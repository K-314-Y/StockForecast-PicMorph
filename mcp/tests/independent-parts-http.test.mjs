import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createIndependentPartReader,INDEPENDENT_PARTS_API as API} from '../../game_runtime/independent-part-reader.mjs';

const run=promisify(execFile);
const selected={'X-Creature-Part-Preview':'1'};
const requestStatus=(url,options)=>new Promise((resolve,reject)=>{
  const req=request(url,options,res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
  req.once('error',reject);
  req.end();
});

async function listen(t,reader) {
  const server=createGameServer({independentPartReader:reader,loadSnapshot:()=>{throw Error('Private test data only');}});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return 'http://127.0.0.1:'+server.address().port;
}

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'creature-independent-http-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'mcp'));
  for(const name of ['independent_parts_catalog.py','independent_parts.py','character_parts.py','import_png_character.py']) {
    await copyFile(new URL('../'+name,import.meta.url),join(dir,'mcp',name));
  }
  const reader=createIndependentPartReader({script:join(dir,'mcp','independent_parts_catalog.py')});
  const calls=[];
  const url=await listen(t,{
    list(signal){calls.push('list');return reader.list(signal);},
    image(id,signal){calls.push(id);return reader.image(id,signal);},
  });
  const fill=async()=>{
    const {stdout}=await run('python3',['-B','-E','-c',`
import io, json, os, sys
from pathlib import Path
from PIL import Image, ImageDraw
sys.path.insert(0, 'mcp')
from independent_parts import prepare_catalog_part, sha256
os.umask(0o077)
im = Image.new('RGBA', (192, 208))
ImageDraw.Draw(im).rectangle((10, 20, 15, 25), fill='orange')
out = io.BytesIO()
im.save(out, format='PNG')
png = out.getvalue()
candidate = {'schema_version': 1, 'candidate_id': 'sg_'+'a'*32, 'source_id': 'cp_'+'b'*32,
             'source_sha256': 'c'*64, 'part_png_sha256': sha256(png), 'not_registered_in_game': True,
             'metadata': {'frame': 1, 'source_part': 'ready', 'review_required': True,
                          'bbox': [10, 20, 16, 26], 'width': 192, 'height': 208}}
manifest, atlas = prepare_catalog_part(candidate, png, kind_id='fixture.pin', layer_anchor='face',
                                      rights={'basis':'original','holder':'Fixture','reference':''})
path = Path('local_state/independent_parts') / manifest['part_id']
path.mkdir(parents=True)
(path/'manifest.json').write_text(json.dumps(manifest))
(path/'part.png').write_bytes(atlas)
print(json.dumps(manifest))
`],{cwd:dir,timeout:5000,maxBuffer:4096});
    return JSON.parse(stdout);
  };
  return {dir,url,fill,calls};
}

test('catalog GET lists metadata, then serves the explicitly selected verified PNG',async t=>{
  const {dir,url,fill,calls}=await fixture(t);
  const listing=url+API;
  assert.deepEqual(await fetch(listing).then(res=>res.json()),{parts:[]});
  const manifest=await fill();
  const res=await fetch(listing);
  assert.equal(res.headers.get('content-type'),'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'),null);
  const body=await res.json();
  assert.deepEqual(body,{parts:[{part_id:manifest.part_id,kind_id:manifest.kind_id,
    layer_anchor:'face',source_id:manifest.source.source_id,candidate_id:manifest.source.candidate_id,
    image_sha256:manifest.image.sha256}]});
  assert.deepEqual(calls,['list','list']);
  const imageUrl=listing+'/'+manifest.part_id+'/part.png';
  assert.equal((await fetch(imageUrl)).status,403);
  assert.deepEqual(calls,['list','list']);
  const image=await fetch(imageUrl,{headers:{...selected,Origin:url}});
  assert.equal(image.status,200);
  for(const [header,value] of Object.entries({'content-type':'image/png','cache-control':'no-store',
    'cross-origin-resource-policy':'same-origin','x-content-type-options':'nosniff',
    'x-creature-part-sha256':manifest.image.sha256,'access-control-allow-origin':null})) {
    assert.equal(image.headers.get(header),value,header);
  }
  const bytes=Buffer.from(await image.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.image.sha256);
  assert.deepEqual(bytes,await readFile(join(dir,'local_state','independent_parts',manifest.part_id,'part.png')));
  assert.deepEqual(calls,['list','list',manifest.part_id]);
});

test('catalog routes reject malformed IDs, cross-origin callers, writes and corrupt or linked entries',async t=>{
  const {dir,url,fill,calls}=await fixture(t);
  const manifest=await fill();
  const base=url+API;
  const link=base+'/'+manifest.part_id+'/part.png';
  for(const [path,options,status] of [
    [base,{headers:{Origin:'http://example.invalid'}},403],
    [link,{headers:{...selected,Host:'outside.invalid'}},403],
    [link,{headers:{...selected,'Sec-Fetch-Site':'cross-site'}},403],
    [base,{method:'OPTIONS'},404], [base,{method:'POST'},404],
    [link+'?filename=part.png',{headers:selected},404],
    [base+'/pt_fake/part.png',{headers:selected},404],
    [base+'/%70'+manifest.part_id.slice(1)+'/part.png',{headers:selected},404],
    [base+'/'+manifest.part_id+'/manifest.json',{headers:selected},404],
  ])assert.equal(await requestStatus(path,options),status,JSON.stringify({path,options}));
  assert.deepEqual(calls,[]);
  assert.equal((await fetch(base+'/pt_'+'f'.repeat(32)+'/part.png',{headers:selected})).status,404);
  const png=join(dir,'local_state','independent_parts',manifest.part_id,'part.png');
  const bytes=await readFile(png);
  await writeFile(png,'bad PNG');
  for(const path of [base,link]){
    const response=await fetch(path,{headers:selected});
    assert.equal(response.status,503);
    assert.equal((await response.json()).error,'保存済みパーツの整合性を確認できませんでした');
  }
  await rm(png);
  const other=join(dir,'synthetic.png');
  await writeFile(other,bytes,{mode:0o600});
  await symlink(other,png);
  assert.equal((await fetch(link,{headers:selected})).status,503);
});

test('viewer without a Linux catalog reader serves neither catalog metadata nor images',async t=>{
  const url=await listen(t,null);
  assert.equal((await fetch(url+API)).status,404);
  assert.equal((await fetch(url+API+'/pt_'+'a'.repeat(32)+'/part.png',{headers:selected})).status,404);
});
