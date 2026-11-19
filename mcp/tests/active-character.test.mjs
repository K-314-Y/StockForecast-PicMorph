import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile,link,mkdir,mkdtemp,readFile,readdir,rename,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {createActiveCharacterStore} from '../../game_runtime/active-character.mjs';
import {createArtworkStore} from '../../game_runtime/artwork.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

const ENDPOINT='/api/active-character';
const artwork={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMMqFjAwMDAxMDAwMDAAAAQugFsZnyF3gAAAABJRU5ErkJggg=='};

async function makeFixture(t) {
  const root=await mkdtemp(join(tmpdir(),'creature-active-character-'));
  const state=join(root,'local_state','node_game');
  const file=join(state,'active-character.json');
  const catalogRoot=join(root,'local_state','character_parts');
  const artworkStore=createArtworkStore({file:join(state,'artwork.json')});
  let server;
  async function close() {
    if(server?.listening) await new Promise(resolve=>server.close(resolve));
  }
  t.after(async()=>{
    await close();
    await rm(root,{recursive:true,force:true});
  });
  await mkdir(join(root,'mcp'));
  for(const name of ['character_parts.py','character_parts_render.py']) {
    await copyFile(new URL('../'+name,import.meta.url),join(root,'mcp',name));
  }
  async function helper(operation,input) {
    const pending=promisify(execFile)('python3',['-B','-E',join(root,'mcp','character_parts.py'),operation]);
    pending.child.stdin.end(JSON.stringify(input)+'\n');
    const {stdout}=await pending;
    const {result,error}=JSON.parse(stdout);
    assert.equal(error,undefined);
    return result;
  }
  async function start() {
    await close();
    server=createGameServer({catalogRoot, artworkStore, activeCharacterStore:createActiveCharacterStore({file}),
      loadSnapshot:()=>{throw Error('Avatar selection must not read forecasting state');}});
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    return {
      origin,
      get:(path=ENDPOINT)=>fetch(origin+path),
      post:(payload,headers={})=>fetch(origin+ENDPOINT,{method:'POST',
        headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(payload)}),
    };
  }
  return {root,state,file,catalogRoot,artworkStore,helper,start};
}

test('active appearance checks registration, survives restart, and clears an unavailable ID explicitly',async t=>{
  const {state,file,catalogRoot,artworkStore,helper,start}=await makeFixture(t);
  let api=await start();
  const read=async()=>{
    const response=await api.get();
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
    assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
    return response.json();
  };
  assert.deepEqual(await read(),{schema:1,revision:0,active_demo_id:null,available:false});
  await assert.rejects(stat(state),{code:'ENOENT'});
  const request=id=>({expected_revision:0,active_demo_id:id});
  const {generated_id}=await helper('generate',{name:'ミント',hair_color:'#9069ac',
    clothing_color:'#47b8a2',accessory:'star',seed:42});
  assert.equal((await api.post(request(generated_id))).status,404);
  for(const payload of [request('../node_game/artwork.json'), request(generated_id+'\n'),
    request(generated_id.toUpperCase()), {...request(null),extra:true},
    {...request(null),expected_revision:-1}, {...request(null),expected_revision:'0'}]) {
    assert.equal((await api.post(payload)).status,400);
  }
  for(const headers of [{Origin:'https://example.invalid'},
    {Origin:api.origin.replace('127.0.0.1','localhost')},{'Sec-Fetch-Site':'cross-site'},
    {'Sec-Fetch-Site':'same-site'}]) {
    assert.equal((await api.post(request(null),headers)).status,403);
  }
  for(const method of ['PUT','DELETE']) assert.equal((await fetch(api.origin+ENDPOINT,{method})).status,404);
  await assert.rejects(stat(state),{code:'ENOENT'});

  await helper('register',{generated_id});
  await artworkStore.save({expected_revision:0,slot:'base',image:artwork});
  const privateNames=['artwork.json','artwork-expressions.json','companion.json','looks.json','growth.json'];
  for(const name of privateNames.slice(1)) await writeFile(join(state,name),'fixture '+name);
  const snapshot=()=>Promise.all(privateNames.map(async name=>{
    const path=join(state,name);
    return {bytes:await readFile(path),mtime:(await stat(path)).mtimeMs};
  }));
  const before=await snapshot();
  const pair=await Promise.all([api.post(request(generated_id),{Origin:api.origin}),
    api.post(request(generated_id),{Origin:api.origin})]);
  assert.deepEqual(pair.map(res=>res.status).sort(),[200,409]);
  assert.deepEqual(await pair.find(res=>res.ok).json(),
    {schema:1,revision:1,active_demo_id:generated_id,available:true});
  const persisted=await readFile(file);
  assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(),['active_demo_id','revision','schema']);
  assert.equal((await stat(file)).mode&0o777,0o600);
  const saved=await read();
  api=await start();
  assert.deepEqual(await read(),saved);

  const ready=join(catalogRoot,generated_id,'character_ready_6frames.png');
  const corrupt=await readFile(ready);
  corrupt[32]^=1;
  await writeFile(ready,corrupt);
  assert.deepEqual(await read(),{...saved,available:false});
  assert.deepEqual(await readFile(file),persisted);
  assert.equal((await api.post({expected_revision:1,active_demo_id:generated_id})).status,404);
  const reset=await api.post({expected_revision:1,active_demo_id:null});
  assert.equal(reset.status,200);
  assert.deepEqual(await reset.json(),{schema:1,revision:2,active_demo_id:null,available:false});
  assert.deepEqual(await snapshot(),before);
  assert.deepEqual((await readdir(state)).sort(),[...privateNames,'active-character.json'].sort());
  assert.deepEqual(Buffer.from(await (await api.get('/api/artwork/image/base')).arrayBuffer()),
    Buffer.from(artwork.base64,'base64'));
});

test('corrupt, symlinked and hardlinked selection storage fails closed',async t=>{
  const {root,state,file,start}=await makeFixture(t);
  const api=await start();
  await mkdir(state,{recursive:true,mode:0o700});
  const foreign=join(root,'foreign.json');
  await writeFile(foreign,'{"schema":1,"revision":1,"active_demo_id":null}',{mode:0o600});
  for(const makeLink of [symlink,link]) {
    await makeLink(foreign,file);
    assert.equal((await api.get()).status,503);
    assert.equal((await api.post({expected_revision:1,active_demo_id:null})).status,503);
    await rm(file);
  }
  const bad='{"schema":1,"revision":1,"active_demo_id":"../other"}';
  await writeFile(file,bad,{mode:0o600});
  assert.equal((await api.get()).status,503);
  assert.equal((await api.post({expected_revision:1,active_demo_id:null})).status,503);
  assert.equal(await readFile(file,'utf8'),bad);
  const moved=join(root,'another-directory');
  await rename(state,moved);
  await symlink(moved,state,'dir');
  assert.equal((await api.get()).status,503);
  assert.equal((await api.post({expected_revision:0,active_demo_id:null})).status,503);
  assert.equal(await readFile(join(moved,'active-character.json'),'utf8'),bad);
});
