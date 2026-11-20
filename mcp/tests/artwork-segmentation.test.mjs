import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,readdir,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createActiveCharacterStore} from '../../game_runtime/active-character.mjs';

async function createFixtureImage(root) {
 const lines=[
 'import io,sys,json,base64',
 'from PIL import Image,ImageDraw',
 "sys.path.insert(0,'mcp')",
 'from import_png_character import register',
 'parts={}',
 "for part in ['body','ready','happy','cautious']:",
 " im=Image.new('RGBA',(1152,208),(0,0,0,0))",
 ' d=ImageDraw.Draw(im)',
 ' for frame in range(6):',
 '  x=192*frame',
 "  if part=='body':",
 '   d.rectangle((x+20,70,x+170,190),fill=(190,155,228,255))',
 '  else:',
 '   d.rectangle((x+43,30,x+75,48),fill=(239,36,112,255))',
 '   d.ellipse((x+91,82,x+110,95),fill=(45,73,99,255))',
 ' out=io.BytesIO(); im.save(out,format="PNG")',
 ' parts[part]=base64.b64encode(out.getvalue()).decode()',
 'print(json.dumps(register({"name":"Local Candidate","parts":parts})))'
 ];
 const output=await new Promise((resolve,reject)=>{
  const child=spawn('python3',['-B','-c',lines.join('\n')],{cwd:root,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',x=>stdout+=x);
  child.stderr.setEncoding('utf8').on('data',x=>stderr+=x);
  child.once('error',reject);
  child.once('close',code=>code===0?resolve(stdout):reject(Error(stderr)));
 });
 return JSON.parse(output);
}

async function fixture(t,{readOnly=false}={}) {
 const dir=await mkdtemp(join(tmpdir(),'creature-segment-mcp-'));
 await mkdir(join(dir,'mcp'),{recursive:true});
 await mkdir(join(dir,'game_runtime'),{recursive:true});
 for(const name of ['character_parts.py','character_parts_render.py','import_png_character.py',
     'artwork_segment.py','companion-chatgpt.mjs']) {
   await copyFile(new URL('../'+name,import.meta.url),join(dir,'mcp',name));
 }
 for(const name of ['artwork.mjs','image-validation.mjs'])
   await copyFile(new URL('../../game_runtime/'+name,import.meta.url),
     join(dir,'game_runtime',name));
 await symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),
   join(dir,'mcp','node_modules'),'dir');
 const generated=await createFixtureImage(dir);
 assert.match(generated.generated_id,/^cp_[a-f0-9]{32}$/);
 const game=createGameServer({
  catalogRoot:join(dir,'local_state','character_parts'),
  activeCharacterStore:createActiveCharacterStore({file:join(dir,'local_state','node_game','active-character.json')}),
  loadSnapshot:()=>{throw Error('No market access for segmentation tests');},
 });
 await new Promise((resolve,reject)=>game.once('error',reject).listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+game.address().port;
 const {makeCompanionChatGptMcp}=await import(pathToFileURL(join(dir,'mcp','companion-chatgpt.mjs')));
 const mcp=makeCompanionChatGptMcp({apiBase:url,readOnly});
 const client=new Client({name:'segment-test',version:'1.0.0'});
 const [left,right]=InMemoryTransport.createLinkedPair();
 await mcp.connect(right);await client.connect(left);
 t.after(async()=>{
  await client.close();await mcp.close();
  await new Promise(resolve=>game.close(resolve));
  await rm(dir,{recursive:true,force:true});
 });
 return {dir,url,id:generated.generated_id,client};
}

const args=id=>({
 generated_id:id,source_part:'ready',part_type:'ribbon',
 frame:0,seeds:[{x:50,y:35}],tolerance:4,
});
const call=(client,name,arguments0)=>client.callTool({name,arguments:arguments0});

test('MCP previews color-mask PNG without creating files or altering the game',async t=>{
 const {dir,id,url,client}=await fixture(t);
 const initial=await(await fetch(url+'/api/active-character')).json();
 const tools=(await client.listTools()).tools;
 assert.equal(tools.length,16);
 for(const name of ['inspect_character_image_for_parts','preview_segment_candidate','save_segment_candidate'])
  assert(tools.some(x=>x.name===name),name);
 const inspection=await call(client,'inspect_character_image_for_parts',{
  generated_id:id,source_part:'ready',
 });
 assert.equal(inspection.isError,undefined,JSON.stringify(inspection));
 assert.equal(inspection.content[1].type,'image');
 const preview=await call(client,'preview_segment_candidate',args(id));
 assert.equal(preview.isError,undefined,JSON.stringify(preview));
 assert.equal(preview.content[1].type,'image');
 assert.deepEqual(preview.structuredContent.bbox,[43,30,76,49]);
 assert.equal(preview.structuredContent.mask_pixels,33*19);
 assert.equal(preview.structuredContent.semantic_model_used,false);
 assert.match(preview.structuredContent.source_sha256,/^[0-9a-f]{64}$/);
 await assert.rejects(readdir(join(dir,'local_state','segment_candidates')),{code:'ENOENT'});
 assert.deepEqual(await(await fetch(url+'/api/active-character')).json(),initial);
});

test('Save requires matching source digest, creates only isolated candidate PNG',async t=>{
 const {dir,id,url,client}=await fixture(t);
 const before=Buffer.from(await(await fetch(url+'/api/character-demos/'+id+'/ready.png')).arrayBuffer());
 const preview=await call(client,'preview_segment_candidate',args(id));
 assert.equal(preview.isError,undefined);
 const wrong=await call(client,'save_segment_candidate',{...args(id),expected_sha256:'0'.repeat(64)});
 assert.equal(wrong.isError,true);
 await assert.rejects(readdir(join(dir,'local_state','segment_candidates')),{code:'ENOENT'});
 const saved=await call(client,'save_segment_candidate',{
  ...args(id),expected_sha256:preview.structuredContent.source_sha256,
 });
 assert.equal(saved.isError,undefined,JSON.stringify(saved));
 const data=saved.structuredContent;
 assert.match(data.candidate_id,/^sg_[a-f0-9]{32}$/);
 assert.equal(data.registered_in_game,false);
 const filename=join(dir,data.local_directory,'part.png');
 const contents=await readFile(filename);
 assert(contents.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
 assert.equal((await stat(filename)).mode & 0o777,0o600);
 const manifest=JSON.parse(await readFile(join(dir,data.local_directory,'manifest.json'),'utf8'));
 assert.equal(manifest.not_registered_in_game,true);
 assert.deepEqual(Buffer.from(await(await fetch(url+'/api/character-demos/'+id+'/ready.png')).arrayBuffer()),before);
 assert.equal((await(await fetch(url+'/api/active-character')).json()).active_demo_id,null);
});

test('Read-only MCP hides image inspection, previews and writes',async t=>{
 const {client,dir,id}=await fixture(t,{readOnly:true});
 const names=(await client.listTools()).tools.map(tool=>tool.name);
 assert.equal(names.length,6);
 for(const name of ['inspect_character_image_for_parts','preview_segment_candidate','save_segment_candidate']){
  assert(!names.includes(name));
  assert.equal((await call(client,name,args(id))).isError,true);
 }
 await assert.rejects(readdir(join(dir,'local_state','segment_candidates')),{code:'ENOENT'});
});

test('Source traversal, invalid coordinates and transparent seed fail closed',async t=>{
 const {dir,id,client}=await fixture(t);
 const invalid=[
  {...args(id),generated_id:'../private'}, {...args(id),source_part:'../base'},
  {...args(id),seeds:[{x:0,y:0}]}, {...args(id),seeds:[{x:-1,y:4}]},
  {...args(id),tolerance:300}, {...args(id),part_type:'../secret'},
  {...args(id),frame:6}, {...args(id),extra_url:'https://example.org'},
  {...args(id),generated_id:'cp_'+'a'.repeat(32)},
 ];
 for(const item of invalid){
  const response=await call(client,'preview_segment_candidate',item);
  assert.equal(response.isError,true,JSON.stringify(item));
  assert(!response.content.some(x=>x.type==='image'));
 }
 await assert.rejects(readdir(join(dir,'local_state','segment_candidates')),{code:'ENOENT'});
});
