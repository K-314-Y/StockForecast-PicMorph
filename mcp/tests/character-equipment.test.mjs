import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createCharacterEquipmentStore,CHARACTER_EQUIPMENT_API as API} from '../../game_runtime/character-equipment.mjs';
import {createIndependentPartReader} from '../../game_runtime/independent-part-reader.mjs';

const run=promisify(execFile);

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'creature-equipment-http-'));
  const mcp=join(root,'mcp');
  await mkdir(mcp);
  for(const name of ['character_equipment.py','character_parts.py','independent_parts.py',
    'independent_parts_catalog.py','import_png_character.py']) {
    await copyFile(new URL('../'+name,import.meta.url),join(mcp,name));
  }
  const {stdout}=await run('python3',['-B','-E','-c',`
import base64, io, json, os, sys
from pathlib import Path
from PIL import Image, ImageDraw
sys.path.insert(0, 'mcp')
from import_png_character import register
from independent_parts import prepare_catalog_part, sha256
os.umask(0o077)
def encode(im):
    out = io.BytesIO()
    im.save(out, format='PNG')
    return out.getvalue()
atlas = Image.new('RGBA', (1152, 208))
ImageDraw.Draw(atlas).rectangle((20, 30, 26, 40), fill='blue')
encoded = base64.b64encode(encode(atlas)).decode()
ids = [register({'name': name, 'parts': {key: encoded for key in ('body','ready','happy','cautious')}})['generated_id']
       for name in ('Fixture one','Fixture two')]
cell = encode(atlas.crop((0, 0, 192, 208)))
candidate = {'schema_version':1, 'candidate_id':'sg_'+'a'*32,'source_id':ids[0],
    'source_sha256':sha256(encode(atlas)),'part_png_sha256':sha256(cell),'not_registered_in_game':True,
    'metadata':{'source_part':'ready','frame':0,'review_required':True,'width':192,'height':208,'bbox':[20,30,27,41]}}
manifest, png = prepare_catalog_part(candidate,cell,kind_id='fixture.pin',layer_anchor='outfit',
    rights={'basis':'original','holder':'Fixture','reference':''})
target = Path('local_state/independent_parts') / manifest['part_id']
target.mkdir(parents=True)
(target/'manifest.json').write_text(json.dumps(manifest))
(target/'part.png').write_bytes(png)
print(json.dumps({'ids':ids,'part':{'part_id':manifest['part_id'],'image_sha256':manifest['image']['sha256'],
      'layer_anchor':'face','visible':False,'x':-8,'y':12}}))
`],{cwd:root,timeout:5000,maxBuffer:4096});
  const {ids,part}=JSON.parse(stdout);
  const state=join(root,'local_state');
  const servers=[];
  t.after(async()=>{
    await Promise.all(servers.map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})));
    await rm(root,{recursive:true,force:true});
  });
  const start=async(override={})=>{
    const server=createGameServer({catalogRoot:join(state,'character_parts'),
      equipmentStore:createCharacterEquipmentStore({script:join(mcp,'character_equipment.py')}),
      independentPartReader:createIndependentPartReader({script:join(mcp,'independent_parts_catalog.py')}),
      loadSnapshot:()=>{throw Error('Equipment must not reach game state');},
      activeCharacterStore:{read(){throw Error('Unexpected active read');},save(){throw Error('Unexpected active write');}},
      ...override});
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    servers.push(server);
    const origin='http://127.0.0.1:'+server.address().port;
    return {
      origin,
      get:(id=ids[0])=>fetch(origin+API+'/'+id),
      post:(body,id=ids[0],headers={})=>fetch(origin+API+'/'+id,{method:'POST',
        headers:{'Content-Type':'application/json',Origin:origin,...headers},body:JSON.stringify(body)}),
    };
  };
  return {start,ids,part,state};
}

test('equipment persists by registered character and concurrent servers enforce revision',async t=>{
  const {start,ids,part,state}=await fixture(t);
  const a=await start(),b=await start();
  const empty=id=>({schema:1,character_id:id,revision:0,parts:[]});
  assert.deepEqual(await a.get().then(r=>r.json()),empty(ids[0]));
  await assert.rejects(readdir(join(state,'character_equipment')),{code:'ENOENT'});
  const artwork=join(state,'character_parts',ids[0],'character_ready_6frames.png');
  const original=await readFile(artwork);
  const replies=await Promise.all([a.post({expected_revision:0,parts:[part]}),b.post({expected_revision:0,parts:[part]})]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
  const current=await b.get();
  assert.equal(current.headers.get('cache-control'),'no-store');
  assert.equal(current.headers.get('access-control-allow-origin'),null);
  assert.deepEqual(await current.json(),{...empty(ids[0]),revision:1,parts:[part]});
  assert.deepEqual(await b.get(ids[1]).then(r=>r.json()),empty(ids[1]));
  assert.equal((await a.post({expected_revision:0,parts:[{...part,visible:true}]},ids[1])).status,200);
  assert.deepEqual(await b.post({expected_revision:1,parts:[]}).then(r=>r.json()),{...empty(ids[0]),revision:2});
  assert.equal((await b.get(ids[1]).then(r=>r.json())).parts[0].visible,true);
  assert.deepEqual(await readFile(artwork),original);
  assert.deepEqual((await readdir(state)).sort(),['character_equipment','character_parts','independent_parts']);
});

test('equipment HTTP rejects invalid IDs, origins and payloads, and fails closed on missing or corrupt parts',async t=>{
  const {start,ids,part,state}=await fixture(t);
  const api=await start();
  const body={expected_revision:0,parts:[part]};
  const unregistered='cp_'+'0'.repeat(32);
  assert.equal((await api.get(unregistered)).status,404);
  assert.equal((await api.post(body,unregistered)).status,404);
  assert.equal((await api.get('cp_bad')).status,404);
  assert.equal((await api.get(ids[0]+'?part=external')).status,404);
  for(const headers of [{Origin:'https://example.invalid'}, {Origin:api.origin.replace('127.0.0.1','localhost')},
    {'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'}]) {
    assert.equal((await api.post(body,ids[0],headers)).status,headers['Content-Type']?415:403);
  }
  const status=await new Promise((resolve,reject)=>{
    const req=request(api.origin+API+'/'+ids[0],{headers:{Host:'outside.invalid'}},res=>{res.resume();resolve(res.statusCode);});
    req.once('error',reject);req.end();
  });
  assert.equal(status,403);
  const noOrigin=await fetch(api.origin+API+'/'+ids[0],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(noOrigin.status,403);
  for(const bad of [{...body,filename:'../file'}, {...body,parts:[part,part]}, {...body,expected_revision:true},
    {...body,parts:[{...part,x:0.5}]}, {...body,parts:[{...part,visible:0}]}])assert.equal((await api.post(bad)).status,400);
  assert.equal((await api.post({...body,parts:[{...part,image_sha256:'a'.repeat(64)}]})).status,422);
  assert.equal((await api.post({...body,parts:[{...part,image_sha256:'a'.repeat(6000)}]})).status,413);
  await assert.rejects(readdir(join(state,'character_equipment')),{code:'ENOENT'});
  assert.equal((await api.post(body)).status,200);
  const folder=join(state,'independent_parts',part.part_id);
  await writeFile(join(folder,'part.png'),'broken');
  assert.equal((await api.get()).status,503);
  await rm(folder,{recursive:true});
  assert.equal((await api.get()).status,422);
  assert.equal((await api.post({...body,expected_revision:1})).status,422);
  const viewer=await start({equipmentStore:null});
  assert.equal((await viewer.get()).status,404);
  assert.equal((await viewer.post(body)).status,404);
});
