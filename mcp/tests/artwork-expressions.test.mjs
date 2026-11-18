import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createArtworkStore,MAX_ARTWORK_FILE} from '../../game_runtime/artwork.mjs';
import {createArtworkExpressionStore,MAX_EXPRESSION_REQUEST} from '../../game_runtime/artwork-expressions.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

const fixtures=JSON.parse(await readFile(new URL('./artwork-fixtures.json',import.meta.url),'utf8'));
const api='/api/artwork-expressions';
const empty={exists:false,mime:null,size:0};
const bytes=image=>Buffer.from(image.base64,'base64');
const payload=(expected_revision,mood,image)=>({expected_revision,mood,image});
const missing={code:'ENOENT'};

async function mount(t) {
  const dir=await mkdtemp(join(tmpdir(),'creature-expression-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'artwork-expressions.json');
  const original=join(dir,'artwork.json');
  const artworkStore=createArtworkStore({file:original});
  const artworkExpressionStore=createArtworkExpressionStore({file});
  const server=createGameServer({artworkStore,artworkExpressionStore});
  // Exercise the HTTP handler in-process, including request limits and local-only checks.
  server.address=()=>({port:3000});
  function request(url,{method='GET',body,headers={}}={}) {
    const encoded=body===undefined?null:Buffer.from(JSON.stringify(body));
    const req=Object.assign(Readable.from(encoded?[encoded]:[]),{
      method,url,socket:{remoteAddress:'127.0.0.1'},
      headers:{host:'127.0.0.1:3000',...(encoded?{
        'content-type':'application/json','content-length':String(encoded.length)
      }:{}),...headers},
    });
    return new Promise(resolve=>{
      const res={
        writeHead(status,headers) {this.status=status;this.headers=headers;},
        end(body) {
          resolve({status:this.status,headers:this.headers,body,json:()=>JSON.parse(body)});
        },
      };
      server.emit('request',req,res);
    });
  }
  return {dir,file,original,artworkStore,artworkExpressionStore,request,
    save:(body,headers)=>request(api,{method:'POST',body,headers})};
}

test('expression GET starts clean and explicit saves, overwrite and CLEAR stay isolated from four-slot artwork',async t=>{
  const {dir,file,original,artworkStore,request,save}=await mount(t);
  const fresh=await request(api);
  assert.equal(fresh.status,200);
  assert.deepEqual(fresh.json(),{revision:0,created:false,moods:{happy:empty,cautious:empty}});
  await assert.rejects(stat(file),missing);
  assert.equal((await request(api+'/image/happy')).status,404);
  for (const slot of ['base','hair','face','outfit']) {
    await artworkStore.save({expected_revision:(await artworkStore.read()).revision,slot,image:fixtures.png});
  }
  const originalBytes=await readFile(original);
  assert.equal((await save(payload(0,'happy',fixtures.png))).status,200);
  const saved=await save(payload(1,'cautious',fixtures.jpeg));
  assert.equal(saved.status,200);
  assert.equal(saved.json().revision,2);
  assert.deepEqual(saved.json().moods,{
    happy:{exists:true,mime:'image/png',size:bytes(fixtures.png).length},
    cautious:{exists:true,mime:'image/jpeg',size:bytes(fixtures.jpeg).length},
  });

  const reopened=createArtworkExpressionStore({file});
  assert.deepEqual(await reopened.read(),saved.json());
  assert.deepEqual((await reopened.image('happy')).bytes,bytes(fixtures.png));
  const raw=await request(api+'/image/cautious?revision=2');
  assert.equal(raw.status,200);
  assert.deepEqual(raw.body,bytes(fixtures.jpeg));
  assert.equal(raw.headers['Content-Type'],'image/jpeg');
  assert.equal(raw.headers['Content-Length'],raw.body.length);
  assert.equal(raw.headers['Cache-Control'],'no-store');
  assert.equal(raw.headers['X-Content-Type-Options'],'nosniff');
  assert.equal(raw.headers['X-Frame-Options'],'DENY');
  assert.equal(raw.headers['Referrer-Policy'],'no-referrer');
  assert.match(raw.headers['Content-Security-Policy'],/sandbox/);

  assert.equal((await save(payload(2,'happy',fixtures.webp))).status,200);
  assert.deepEqual((await request(api+'/image/happy')).body,bytes(fixtures.webp));
  const cleared=await save(payload(3,'happy',null));
  assert.equal(cleared.status,200);
  assert.equal(cleared.json().revision,4);
  assert.deepEqual(cleared.json().moods.happy,empty);
  assert.deepEqual((await reopened.image('cautious')).bytes,bytes(fixtures.jpeg));
  assert.equal((await request(api+'/image/happy')).status,404);
  assert.equal((await stat(file)).mode & 0o777,0o600);
  assert.deepEqual((await readdir(dir)).sort(),['artwork-expressions.json','artwork.json']);
  assert.deepEqual(await readFile(original),originalBytes);
});

test('competing saves against the same revision produce exactly one write and a 409',async t=>{
  const {file,request,save}=await mount(t);
  const secondStore=createArtworkExpressionStore({file});
  const [first,second]=await Promise.all([
    save(payload(0,'happy',fixtures.png)).then(response=>response.status),
    secondStore.save(payload(0,'cautious',fixtures.webp)).then(()=>200,error=>error.status),
  ]);
  assert.deepEqual([first,second].sort(),[200,409]);
  const {revision,moods}=(await request(api)).json();
  assert.equal(revision,1);
  assert.equal(Number(moods.happy.exists)+Number(moods.cautious.exists),1);
  assert.equal((await save(payload(0,'happy',null))).status,409);
  assert.deepEqual((await request(api)).json(),{revision,created:true,moods});
});

test('corrupt expression files fail closed while the normal game and artwork remain available',async t=>{
  const {file,original,artworkStore,request,save}=await mount(t);
  await artworkStore.save({expected_revision:0,slot:'base',image:fixtures.png});
  for (const corrupt of [
    '{',
    JSON.stringify({schema:1,revision:1,moods:{happy:null,cautious:null,ready:null}}),
    JSON.stringify({schema:1,revision:1,moods:{happy:{...fixtures.png,size:1},cautious:null}}),
    JSON.stringify({schema:1,revision:1,moods:{happy:{mime:'image/png',base64:'@@@@',size:3},cautious:null}}),
  ]) {
    await writeFile(file,corrupt,{mode:0o600});
    assert.equal((await request(api)).status,503);
    assert.equal((await request(api+'/image/happy')).status,503);
    assert.equal((await save(payload(0,'happy',fixtures.png))).status,503);
    assert.equal(await readFile(file,'utf8'),corrupt);
  }
  await rm(file);
  await symlink(original,file);
  assert.equal((await request(api)).status,503);
  assert.equal((await save(payload(0,'cautious',null))).status,503);
  assert.equal((await request('/game')).status,200);
  assert.equal((await request('/api/artwork')).json().revision,1);
  assert.deepEqual((await request('/api/artwork/image/base')).body,bytes(fixtures.png));
});

test('rejects extra fields, unknown routes and moods, malformed images and non-local requests',async t=>{
  const {dir,request,save}=await mount(t);
  const truncated={...fixtures.png,base64:bytes(fixtures.png).subarray(0,-8).toString('base64')};
  for (const [body,status] of [
    [payload(0,'ready',fixtures.png),400],
    [payload('0','happy',fixtures.png),400],
    [{...payload(0,'happy',fixtures.png),slot:'base'},400],
    [{expected_revision:0,mood:'happy'},400],
    [payload(0,'happy',{...fixtures.png,mime:'image/svg+xml'}),415],
    [payload(0,'happy',{...fixtures.png,mime:'image/jpeg'}),415],
    [payload(0,'happy',truncated),415],
    [payload(0,'happy',{...fixtures.png,base64:'YQ==\n'}),400],
    [payload(0,'happy',{...fixtures.png,base64:'YR=='}),400],
    [payload(0,'happy',{...fixtures.png,base64:'__8='}),400],
    [payload(0,'happy',{...fixtures.png,base64:Buffer.alloc(MAX_ARTWORK_FILE+1).toString('base64')}),413],
  ]) assert.equal((await save(body)).status,status,JSON.stringify(body).slice(0,100));
  assert.equal((await save(payload(0,'happy',fixtures.png),{'content-length':String(MAX_EXPRESSION_REQUEST+1)})).status,413);
  assert.equal((await save(payload(0,'happy',fixtures.png),{origin:'https://example.invalid'})).status,403);
  assert.equal((await save(payload(0,'happy',fixtures.png),{'content-type':'text/plain'})).status,415);
  for (const path of [api+'/',api+'/image/ready',api+'/image/happy/extra',api+'/image/%68appy',
    api+'/image/../image/happy',api+'/../artwork','/api/./artwork-expressions']) {
    assert.equal((await request(path)).status,404,path);
  }
  assert.equal((await request(api,{method:'DELETE'})).status,404);
  assert.deepEqual(await readdir(dir),[]);
});
