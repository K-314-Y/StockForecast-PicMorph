import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmod,copyFile,mkdir,mkdtemp,readFile,readdir,rm,stat,symlink,truncate,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createActiveCharacterStore} from '../../game_runtime/active-character.mjs';

function runPython(root,argv,{input,env}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawn('python3',['-B','-E',...argv],{cwd:root,env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',x=>stdout+=x);
  child.stderr.setEncoding('utf8').on('data',x=>stderr+=x);
  child.stdin.on('error',reject);
  child.stdin.end(input);
  child.once('error',reject);
  child.once('close',code=>code===0?resolve(stdout):reject(Error(stderr)));
 });
}

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
 '   left=43+(7 if frame==5 else 0)',
 '   d.rectangle((x+left,30,x+left+32,48),fill=(239,36,112,255))',
 '   d.ellipse((x+91,82,x+110,95),fill=(45,73,99,255))',
 ' out=io.BytesIO(); im.save(out,format="PNG")',
 ' parts[part]=base64.b64encode(out.getvalue()).decode()',
 'print(json.dumps(register({"name":"Local Candidate","parts":parts})))'
 ];
 return JSON.parse(await runPython(root,['-c',lines.join('\n')]));
}

async function fixture(t,{readOnly=false,http=false}={}) {
 const dir=await mkdtemp(join(tmpdir(),'creature-segment-mcp-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'mcp'),{recursive:true});
 await mkdir(join(dir,'game_runtime'),{recursive:true});
 for(const name of ['character_parts.py','character_parts_render.py','import_png_character.py',
     'artwork_segment.py','segment_onnx.py','independent_parts.py','independent_parts_catalog.py','companion-chatgpt.mjs']) {
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
 t.after(()=>new Promise(resolve=>game.close(resolve)));
 const url='http://127.0.0.1:'+game.address().port;
 const {createCompanionChatGptHttpServer,makeCompanionChatGptMcp}=await import(
  pathToFileURL(join(dir,'mcp','companion-chatgpt.mjs')));
 const client=new Client({name:'segment-test',version:'1.0.0'});
 t.after(()=>client.close());
 if(http){
  const bridge=createCompanionChatGptHttpServer({apiBase:url,readOnly});
  await new Promise((resolve,reject)=>bridge.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{
   bridge.close(resolve);
   bridge.closeAllConnections();
  }));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.address().port}/mcp`)));
 }else{
  const mcp=makeCompanionChatGptMcp({apiBase:url,readOnly});
  const [left,right]=InMemoryTransport.createLinkedPair();
  await mcp.connect(right);await client.connect(left);
  t.after(()=>mcp.close());
 }
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
 assert.equal(tools.length,18);
 for(const name of ['inspect_character_image_for_parts','preview_segment_candidate','save_segment_candidate'])
  assert(tools.some(x=>x.name===name),name);
 for(const name of ['inspect_character_image_for_parts','preview_segment_candidate'])
  assert.equal(tools.find(x=>x.name===name).annotations.readOnlyHint,false);
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
 assert.equal(preview.structuredContent.neural_model_used,false);
 assert.equal(preview.structuredContent.method,'ai-guided-color-region');
 assert.match(preview.structuredContent.source_sha256,/^[0-9a-f]{64}$/);
 await assert.rejects(readdir(join(dir,'local_state','segment_candidates')),{code:'ENOENT'});
 assert.deepEqual(await(await fetch(url+'/api/active-character')).json(),initial);
});

test('private HTTP MCP registers a saved cutout and lists only verified metadata',async t=>{
 const {dir,id,url,client}=await fixture(t,{http:true});
 const catalog=join(dir,'local_state','independent_parts');
 const empty=await call(client,'list_independent_parts',{});
 assert.deepEqual(empty.structuredContent,{parts:[]});
 await assert.rejects(readdir(catalog),{code:'ENOENT'});
 const originalUrl=url+'/api/character-demos/'+id+'/ready.png';
 const original=Buffer.from(await(await fetch(originalUrl)).arrayBuffer());
 const preview=await call(client,'preview_segment_candidate',args(id));
 assert.equal(preview.isError,undefined,JSON.stringify(preview));
 const saved=await call(client,'save_segment_candidate',{
  ...args(id),expected_sha256:preview.structuredContent.source_sha256,
 });
 assert.equal(saved.isError,undefined,JSON.stringify(saved));
 const candidate=join(dir,saved.structuredContent.local_directory);
 const sourceFiles=await Promise.all(['part.png','manifest.json'].map(name=>readFile(join(candidate,name))));
 const input={candidate_id:saved.structuredContent.candidate_id,
  expected_candidate_sha256:saved.structuredContent.part_png_sha256,
  kind_id:'creator.ribbon-green',layer_anchor:'hair',rights:{basis:'original',holder:'Fixture',reference:''}};
 for(const changes of [{path:candidate},{candidate_id:'../bad'},{expected_candidate_sha256:'0'.repeat(64)},
   {kind_id:'face'},{rights:{...input.rights,holder:'bad\ntext'}},{rights:{...input.rights,basis:'permission'}}]){
  const rejected=await call(client,'register_independent_part',{...input,...changes});
  assert.equal(rejected.isError,true,JSON.stringify(rejected));
  assert(rejected.content.every(item=>item.type==='text'));
 }
 await assert.rejects(readdir(catalog),{code:'ENOENT'});
 const registered=await call(client,'register_independent_part',input);
 assert.equal(registered.isError,undefined,JSON.stringify(registered));
 const part=registered.structuredContent;
 assert.deepEqual(Object.keys(part).sort(),['candidate_id','image_sha256','kind_id','layer_anchor','part_id','source_id']);
 assert.match(part.part_id,/^pt_[0-9a-f]{32}$/);
 assert.match(part.image_sha256,/^[0-9a-f]{64}$/);
 assert.equal(part.source_id,id);
 assert.equal(part.candidate_id,input.candidate_id);
 assert.equal(part.kind_id,input.kind_id);
 assert.equal(part.layer_anchor,input.layer_anchor);
 const list=await call(client,'list_independent_parts',{});
 assert.deepEqual(list.structuredContent,{parts:[part]});
 for(const response of [registered,list])assert(response.content.every(item=>item.type==='text'));
 assert.deepEqual(await Promise.all(['part.png','manifest.json'].map(name=>readFile(join(candidate,name)))),sourceFiles);
 assert.deepEqual(Buffer.from(await(await fetch(originalUrl)).arrayBuffer()),original);
 assert.equal((await(await fetch(url+'/api/active-character')).json()).active_demo_id,null);
 await writeFile(join(catalog,part.part_id,'part.png'),'corrupt');
 const broken=await call(client,'list_independent_parts',{});
 assert.equal(broken.isError,true);
 assert.equal(broken.structuredContent,undefined);
});

async function helper(dir,payload,model) {
 return JSON.parse(await runPython(dir,['mcp/artwork_segment.py'],{
  input:JSON.stringify(payload)+'\n',
  env:{PATH:process.env.PATH,CREATURE_SEGMENT_ONNX_MODEL:model},
 }));
}

test('Configured ONNX worker falls back on model, runtime, contention and timeout failures',async t=>{
 const {dir,id,url}=await fixture(t);
 const source=Buffer.from(await(await fetch(url+'/api/character-demos/'+id+'/ready.png')).arrayBuffer());
 const payload={...args(id),mode:'preview',source_png:source.toString('base64')};
 const model=join(dir,'fixture.onnx');
 const missing=await helper(dir,payload,model);
 assert.equal(missing.result.fallback_reason,'invalid_model_file');
 await writeFile(model,'unused');
 await truncate(model,64*1024*1024+1);
 const oversized=await helper(dir,payload,model);
 assert.equal(oversized.result.fallback_reason,'invalid_model_file');
 await truncate(model,1);
 const busy=JSON.parse(await runPython(dir,['-c',[
  'import fcntl,os,subprocess,sys',
  'fd=os.open("mcp",os.O_RDONLY|os.O_DIRECTORY)',
  'fcntl.flock(fd,fcntl.LOCK_EX)',
  'subprocess.run([sys.executable,"-B","-E","mcp/artwork_segment.py"],input=sys.stdin.buffer.read(),check=True)',
 ].join('\n')],{input:JSON.stringify(payload)+'\n',env:{PATH:process.env.PATH,CREATURE_SEGMENT_ONNX_MODEL:model}}));
 assert.equal(busy.result.fallback_reason,'inference_busy');
 await writeFile(join(dir,'mcp','onnxruntime.py'),'raise ImportError("test runtime missing")\n');
 const unavailable=await helper(dir,payload,model);
 assert.equal(unavailable.result.fallback_reason,'runtime_unavailable');

 const worker=join(dir,'mcp','segment_onnx.py');
 const code=await readFile(worker,'utf8');
 await writeFile(worker,code.replace('MAX_WALL_SECONDS = 8','MAX_WALL_SECONDS = 0.1')
  .replace('sys.exit(worker_main(*sys.argv[1:]))','import time; time.sleep(10)'));
 const timedOut=await helper(dir,payload,model);
 assert.equal(timedOut.result.fallback_reason,'inference_timeout');
 for(const {result} of [missing,oversized,busy,unavailable,timedOut]){
  assert.equal(result.method,'ai-guided-color-region');
  assert.equal(result.neural_model_used,false);
  assert.equal(result.mask_pixels,33*19);
  assert.equal(result.part_png_sha256,oversized.result.part_png_sha256);
 }
 await assert.rejects(readdir(join(dir,'local_state','segment_candidates')),{code:'ENOENT'});
});

test('HTTP MCP saves the exact reviewed neural mask in frame coordinates',async t=>{
 const {dir,id,url,client}=await fixture(t,{http:true});
 const atlasUrl=url+'/api/character-demos/'+id+'/ready.png';
 const source=Buffer.from(await(await fetch(atlasUrl)).arrayBuffer());
 const payload={...args(id),frame:5,seeds:[{x:55,y:35}]};
 const model=join(dir,'fixture.onnx');
 await writeFile(model,'fixture');
 const previousModel=process.env.CREATURE_SEGMENT_ONNX_MODEL;
 process.env.CREATURE_SEGMENT_ONNX_MODEL=model;
 t.after(()=>{
  if(previousModel===undefined)delete process.env.CREATURE_SEGMENT_ONNX_MODEL;
  else process.env.CREATURE_SEGMENT_ONNX_MODEL=previousModel;
 });
 const worker=join(dir,'mcp','segment_onnx.py');
 const code=await readFile(worker,'utf8');
 const mockMask=right=>writeFile(worker,code.replace('    sys.exit(worker_main(*sys.argv[1:]))',[
  '    assert sys.argv[2].endswith("/fixture.onnx")',
  '    assert sys.stdin.buffer.read()[4*(35*WIDTH+55):4*(35*WIDTH+55)+4]==bytes([239,36,112,255])',
  `    sys.stdout.buffer.write(bytes(52<=x<${right} and 32<=y<38 for y in range(HEIGHT) for x in range(WIDTH)))`,
 ].join('\n')));
 await mockMask(62);
 const preview=await call(client,'preview_segment_candidate',payload);
 assert.equal(preview.isError,undefined,JSON.stringify(preview));
 assert.match(preview.content[0].text,/EfficientSAM/);
 const details=preview.structuredContent;
 assert.equal(details.method,'efficientsam-onnx-cpu');
 assert.equal(details.neural_model_used,true);
 assert.equal(details.semantic_model_used,false);
 assert.deepEqual(details.bbox,[52,32,62,38]);
 assert.equal(details.mask_pixels,60);
 const image=await runPython(dir,['-c',[
  'import sys,io,base64,json',
  'from PIL import Image',
  'im=Image.open(io.BytesIO(base64.b64decode(sys.stdin.read())))',
  'print(json.dumps([im.size, im.getpixel((55,35)), im.getpixel((51,35))]))',
 ].join('\n')],{input:preview.content[1].data});
 assert.deepEqual(JSON.parse(image),[[192,208],[239,36,112,255],[0,0,0,0]]);
 const save={...payload,expected_sha256:details.source_sha256};
 const unreviewed=await call(client,'save_segment_candidate',{...save,tolerance:8});
 assert.equal(unreviewed.isError,true);
 await mockMask(63);
 assert.match((await call(client,'save_segment_candidate',save)).content[0].text,/mask changed/);
 await writeFile(worker,code);
 assert.match((await call(client,'save_segment_candidate',save)).content[0].text,/neural mask is unavailable/);
 await assert.rejects(readdir(join(dir,'local_state','segment_candidates')),{code:'ENOENT'});
 const fallback=await call(client,'preview_segment_candidate',payload);
 assert.equal(fallback.structuredContent.method,'ai-guided-color-region');
 assert.match(fallback.content[0].text,/Pillow/);
 await mockMask(62);
 const savedFallback=await call(client,'save_segment_candidate',save);
 assert.equal(savedFallback.isError,undefined,JSON.stringify(savedFallback));
 assert.equal(savedFallback.structuredContent.method,'ai-guided-color-region');
 const colorOutput=await readFile(join(dir,savedFallback.structuredContent.local_directory,'part.png'));
 assert.deepEqual(colorOutput,Buffer.from(fallback.content[1].data,'base64'));

 await call(client,'preview_segment_candidate',payload);
 const saved=await call(client,'save_segment_candidate',save);
 assert.equal(saved.isError,undefined,JSON.stringify(saved));
 assert.equal(saved.structuredContent.method,'efficientsam-onnx-cpu');
 const output=await readFile(join(dir,saved.structuredContent.local_directory,'part.png'));
 assert.deepEqual(output,Buffer.from(preview.content[1].data,'base64'));
 assert.deepEqual(Buffer.from(await(await fetch(atlasUrl)).arrayBuffer()),source);
});

test('Save requires matching source digest, creates only isolated candidate PNG',async t=>{
 const {dir,id,url,client}=await fixture(t);
 const before=Buffer.from(await(await fetch(url+'/api/character-demos/'+id+'/ready.png')).arrayBuffer());
 const preview=await call(client,'preview_segment_candidate',args(id));
 assert.equal(preview.isError,undefined);
 const wrong=await call(client,'save_segment_candidate',{...args(id),expected_sha256:'0'.repeat(64)});
 assert.equal(wrong.isError,true);
 const unreviewed=await call(client,'save_segment_candidate',{
  ...args(id),tolerance:8,expected_sha256:preview.structuredContent.source_sha256,
 });
 assert.equal(unreviewed.isError,true);
 const candidates=join(dir,'local_state','segment_candidates');
 await assert.rejects(readdir(candidates),{code:'ENOENT'});
 const staging=join(candidates,'.staging-segment');
 await chmod(join(dir,'local_state'),0o775);
 await mkdir(candidates,{mode:0o700});
 await mkdir(staging,{mode:0o700});
 await writeFile(join(staging,'part.png'),'interrupted write',{mode:0o600});
 const busy=JSON.parse(await runPython(dir,['-c',[
  'import fcntl,os,subprocess,sys',
  'fd=os.open("local_state/segment_candidates",os.O_RDONLY|os.O_DIRECTORY)',
  'fcntl.flock(fd,fcntl.LOCK_EX)',
  'subprocess.run([sys.executable,"-B","-E","mcp/artwork_segment.py"],input=sys.stdin.buffer.read(),check=True,timeout=2)',
 ].join('\n')],{input:JSON.stringify({
  ...args(id),mode:'save',source_png:before.toString('base64'),
  expected_sha256:preview.structuredContent.source_sha256,
  review:{method:preview.structuredContent.method,sha256:preview.structuredContent.part_png_sha256},
 })+'\n'}));
 assert.match(busy.error,/storage is busy/i);
 assert.deepEqual(await readdir(candidates),['.staging-segment']);
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
 assert.equal(manifest.part_png_sha256,preview.structuredContent.part_png_sha256);
 assert.deepEqual(contents,Buffer.from(preview.content[1].data,'base64'));
 assert.deepEqual(await readdir(candidates),[data.candidate_id]);
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
