import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {get} from 'node:http';
import {chmod,copyFile,link,mkdir,mkdtemp,readFile,readdir,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createCharacterDemoCatalog} from '../../game_runtime/character-demo-catalog.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

const API='/api/character-demos';
const name='<b>モカ</b>';
const pngName='character_body_6frames.png';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'creature-gallery-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'mcp'));
  for(const file of ['character_parts.py','character_parts_render.py']) {
    await copyFile(new URL('../'+file,import.meta.url),join(root,'mcp',file));
  }
  const catalogRoot=join(root,'local_state','character_parts');
  const server=createGameServer({catalogRoot});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  const call=(path=API,options)=>fetch(url+path,options);
  const list=async()=>(await call()).json();
  async function helper(operation,input) {
    const pending=promisify(execFile)('python3',['-B','-E',join(root,'mcp','character_parts.py'),operation]);
    pending.child.stdin.end(JSON.stringify(input)+'\n');
    const {stdout}=await pending;
    const {result,error}=JSON.parse(stdout);
    assert.equal(error,undefined);
    return result;
  }
  const generate=()=>helper('generate',{name,hair_color:'#9069ac',
    clothing_color:'#47b8a2',accessory:'star',seed:42});
  return {root,catalogRoot,url,call,list,helper,generate};
}

function rawStatus(url,path) {
  return new Promise((resolve,reject)=>{
    get(url,{path},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);
  });
}

test('character demo API lists only registrations and serves exact PNG bytes via same-origin GET',async t=>{
  const {catalogRoot,url,call,list,helper,generate}=await fixture(t);
  assert.deepEqual(await list(),[]);
  await assert.rejects(readdir(catalogRoot),{code:'ENOENT'});
  const {generated_id}=await generate();
  const image=part=>API+'/'+generated_id+'/'+part+'.png';
  assert.deepEqual(await list(),[]);
  assert.equal((await call(image('body'))).status,404);

  await helper('register',{generated_id});
  const folder=join(catalogRoot,generated_id);
  const stamp=await readFile(join(folder,'demo.json'));
  const catalog=await call();
  assert.equal(catalog.status,200);
  assert.deepEqual(await catalog.json(),[{generated_id,name,engine:'original-template',model:'creature-lab-chibi-v1'}]);
  const own=await call(image('body'),{headers:{Origin:url,'Sec-Fetch-Site':'same-origin'}});
  assert.equal(own.status,200);
  for(const response of [catalog,own]) {
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  }
  for(const [part,response] of [
    ['body',own],['ready',await call(image('ready'))],
    ['happy',await call(image('happy'))],['cautious',await call(image('cautious'))],
  ]) {
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'image/png');
    const bytes=await readFile(join(folder,`character_${part}_6frames.png`));
    assert.equal(Number(response.headers.get('content-length')),bytes.length);
    assert.ok(bytes.length<=512*1024);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  }

  for(const path of [API,image('body')]) {
    for(const method of ['POST','PUT','DELETE','HEAD']) {
      assert.equal((await call(path,{method})).status,404,method+' '+path);
    }
    for(const headers of [
      {Origin:'https://example.invalid'},
      {Origin:url.replace('127.0.0.1','localhost')},
      {'Sec-Fetch-Site':'cross-site'},
      {'Sec-Fetch-Site':'same-site'},
      {Origin:'null'},
    ]) {
      assert.equal((await call(path,{headers})).status,403);
    }
    assert.equal((await call(path,{headers:{'Sec-Fetch-Site':'none'}})).status,200);
  }
  for(const suffix of [
    '/.tmp-generation/body.png','/cp_'+'A'.repeat(32)+'/body.png',
    '/'+generated_id+'/preview.gif','/'+generated_id+'/demo.json',
    '/'+generated_id+'/character_body_6frames.png','/'+generated_id+'/%62ody.png',
    '/'+generated_id+'%2f..%2fnode_game/body.png','/../node_game/artwork.json',
    '/%2e%2e/'+generated_id+'/body.png','/abc/../'+generated_id+'/body.png',
  ]) {
    assert.equal(await rawStatus(url,API+suffix),404,suffix);
  }
  assert.equal(await rawStatus(url,API+'/%xx'),400);
  assert.deepEqual(await readFile(join(folder,'demo.json')),stamp);
});

test('gallery omits corrupt or linked entries and rechecks the PNG when requested',async t=>{
  const {root,catalogRoot,call,list,helper,generate}=await fixture(t);
  const {generated_id}=await generate();
  await helper('register',{generated_id});
  const folder=join(catalogRoot,generated_id);
  const part=join(folder,pngName);
  const manifestPath=join(folder,'manifest.json');
  const demoPath=join(folder,'demo.json');
  const image=API+'/'+generated_id+'/body.png';
  const original=await readFile(part);
  const manifest=await readFile(manifestPath);
  const registration=await readFile(demoPath);
  const assertHidden=async()=>{
    assert.deepEqual(await list(),[]);
    const response=await call(image);
    assert.equal(response.status,404);
    assert.deepEqual(await response.json(),{error:'見つかりません'});
  };

  assert.equal((await list()).length,1);
  const ready=join(folder,'character_ready_6frames.png');
  const readyBytes=await readFile(ready);
  const changedReady=Buffer.from(readyBytes);
  changedReady[40]^=1;
  await writeFile(ready,changedReady);
  await assertHidden(); // Even an intact body is unavailable when ready is corrupt.
  await rm(ready);
  const readyOutside=join(root,'ready.png');
  await writeFile(readyOutside,readyBytes,{mode:0o600});
  await symlink(readyOutside,ready);
  await assertHidden();
  await rm(ready);
  await writeFile(ready,readyBytes,{mode:0o600});
  assert.equal((await call(image)).status,200);

  const changed=Buffer.from(original);
  changed[40]^=1;
  await writeFile(part,changed);
  // Same byte length with the registered manifest still present.
  await assertHidden();
  for(const invalid of [
    Buffer.from('<html>private</html>'),
    Buffer.from(original).fill(0,16,20), // Matching digest but wrong IHDR width.
    changed, // Matching digest and dimensions but corrupted PNG CRC.
    Buffer.alloc(512*1024+1),
  ]) {
    const modified=JSON.parse(manifest);
    modified.files[pngName].sha256=createHash('sha256').update(invalid).digest('hex');
    modified.files[pngName].bytes=invalid.length;
    await writeFile(manifestPath,JSON.stringify(modified));
    await writeFile(part,invalid);
    await assertHidden();
  }
  await writeFile(manifestPath,manifest);
  await rm(part);
  await assertHidden();
  const outside=join(root,'saved-artwork.png');
  await writeFile(outside,original,{mode:0o600});
  for(const makeLink of [symlink,link]) {
    await makeLink(outside,part);
    await assertHidden();
    await rm(part);
  }
  assert.deepEqual(await readFile(outside),original);
  await writeFile(part,original,{mode:0o600});
  await chmod(folder,0o755);
  await assertHidden();
  await chmod(folder,0o700);
  const moved=join(root,'moved-character');
  await rename(folder,moved);
  await symlink(moved,folder,'dir');
  await assertHidden();
  await rm(folder);
  await rename(moved,folder);

  const foreign={...JSON.parse(registration),generated_id:'cp_'+'0'.repeat(32)};
  await writeFile(demoPath,JSON.stringify(foreign));
  await assertHidden();
  await writeFile(demoPath,registration);
  assert.equal((await list()).length,1);
  await rm(demoPath);
  await assertHidden();
});

test('catalog shares only the active scan and handles 128 unrelated entries',async t=>{
  const {catalogRoot,helper,generate}=await fixture(t);
  const catalog=createCharacterDemoCatalog(catalogRoot);
  const first=catalog.list();
  assert.strictEqual(catalog.list(),first);
  assert.deepEqual(await first,[]);
  const {generated_id}=await generate();
  await helper('register',{generated_id});
  await Promise.all(Array.from({length:128},(_,i)=>mkdir(join(catalogRoot,'unrelated-'+i))));
  const next=catalog.list();
  assert.notStrictEqual(next,first);
  assert.strictEqual(catalog.list(),next);
  assert.deepEqual((await next).map(item=>item.generated_id),[generated_id]);
});

test('parallel PNG reads are limited and released for the next request',async t=>{
  const {call,helper,generate}=await fixture(t);
  const {generated_id}=await generate();
  await helper('register',{generated_id});
  const path=API+'/'+generated_id+'/body.png';
  const responses=await Promise.all(Array.from({length:12},()=>call(path)));
  assert.ok(responses.some(response=>response.status===200));
  assert.ok(responses.some(response=>response.status===429));
  for(const response of responses) {
    assert.ok([200,429].includes(response.status));
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    if(response.status===429) {
      assert.equal(response.headers.get('retry-after'),'1');
      assert.match(response.headers.get('content-type'),/^application\/json/);
    }
    await response.arrayBuffer();
  }
  assert.equal((await call(path)).status,200);
});
