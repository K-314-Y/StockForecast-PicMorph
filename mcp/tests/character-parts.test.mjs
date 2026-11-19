import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile,copyFile,link} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {extractCharacterZip} from '../../game_runtime/parts-lab/zip-import.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'creature-parts-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const folder of ['mcp','game_runtime','local_state/node_game']) {
    await mkdir(join(root,folder),{recursive:true});
  }
  for(const file of [
    'mcp/companion-chatgpt.mjs','mcp/character_parts.py','mcp/character_parts_render.py',
    'game_runtime/artwork.mjs','game_runtime/image-validation.mjs',
  ]) {
    await copyFile(new URL('../../'+file,import.meta.url),join(root,file));
  }
  await symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),
    join(root,'mcp/node_modules'),'dir');

  const {makeCompanionChatGptMcp}=await import(pathToFileURL(join(root,'mcp/companion-chatgpt.mjs')));
  const server=makeCompanionChatGptMcp({apiBase:'http://127.0.0.1:1'});
  const client=new Client({name:'parts-test',version:'1.0.0'});
  const [local,remote]=InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  t.after(async()=>{await client.close();await server.close();});
  return {root,client};
}

const appearance={name:'モカ',hair_color:'#9069ac',clothing_color:'#47b8a2',
  accessory:'star',seed:42};

async function rejected(call,name,args) {
  assert.equal((await call(name,args)).isError,true);
}

test('MCP generates deterministic aligned RGBA atlases, a GIF and a Parts Lab ZIP',async t=>{
  const {root,client}=await fixture(t);
  const call=(name,args)=>client.callTool({name,arguments:args});
  const tools=(await client.listTools()).tools.filter(tool=>[
    'generate_character_parts','package_character_parts','register_demo_character',
  ].includes(tool.name));
  assert.equal(tools.length,3);
  assert.ok(tools.every(tool=>tool.annotations.readOnlyHint===false &&
    tool.annotations.openWorldHint===false));
  const saves=['growth.json','artwork.json','companion.json','stock.json'];
  for(const file of saves) await writeFile(join(root,'local_state/node_game',file),file);
  const partsRoot=join(root,'local_state/character_parts');

  await rejected(call,'generate_character_parts',{...appearance,output_path:'../artwork.json'});
  await rejected(call,'generate_character_parts',{...appearance,hair_color:'#aaa'});
  await rejected(call,'generate_character_parts',{...appearance,seed:65536});
  await assert.rejects(readdir(partsRoot),{code:'ENOENT'});

  const first=await call('generate_character_parts',appearance);
  assert.equal(first.isError,undefined,first.content[0].text);
  const {generated_id,local_directory,files,engine}=first.structuredContent;
  assert.equal(engine,'original-template');
  assert.match(generated_id,/^cp_[0-9a-f]{32}$/);
  assert.equal(local_directory,'local_state/character_parts/'+generated_id);
  const folder=join(root,local_directory);
  const second=await call('generate_character_parts',appearance);
  assert.deepEqual(second.structuredContent.files,files);
  assert.notEqual(second.structuredContent.generated_id,generated_id);

  for(const id of ['../node_game','a/b','..\\node_game','cp_'+'0'.repeat(32)+'\n']) {
    await rejected(call,'package_character_parts',{generated_id:id});
    await rejected(call,'register_demo_character',{generated_id:id});
  }
  const unknown='cp_'+'0'.repeat(32);
  await rejected(call,'package_character_parts',{generated_id:unknown});
  await symlink(folder,join(partsRoot,unknown),'dir');
  await rejected(call,'package_character_parts',{generated_id:unknown});
  await rejected(call,'register_demo_character',{generated_id:unknown});

  const packed=await call('package_character_parts',{generated_id});
  assert.equal(packed.isError,undefined,packed.content[0].text);
  const zip=join(folder,packed.structuredContent.filename);
  const original=await readFile(zip);
  const repeat=await call('package_character_parts',{generated_id});
  assert.deepEqual(repeat.structuredContent,packed.structuredContent);
  assert.deepEqual(await readFile(zip),original);
  const imported=await extractCharacterZip(new File([original],'character_parts.zip'));
  assert.deepEqual(Object.keys(imported).sort(),['body','cautious','happy','ready']);

  const registered=await call('register_demo_character',{generated_id});
  assert.equal(registered.isError,undefined,registered.content[0].text);
  const demo=JSON.parse(await readFile(join(folder,'demo.json'),'utf8'));
  assert.equal(demo.visibility,'local_only');
  assert.equal(demo.browser_auto_link,false);
  assert.deepEqual((await call('register_demo_character',{generated_id})).structuredContent,
    registered.structuredContent);

  await promisify(execFile)('python3',['-c',String.raw`
import hashlib, json, sys, zipfile
from pathlib import Path
from PIL import Image

folder = Path(sys.argv[1])
manifest = json.loads((folder / 'manifest.json').read_text())
with zipfile.ZipFile(folder / 'character_parts.zip') as z:
    assert z.testzip() is None
    assert set(z.namelist()) == set(manifest['files']) | {'manifest.json'}
    assert z.read('manifest.json') == (folder / 'manifest.json').read_bytes()
    for name, record in manifest['files'].items():
        data = (folder / name).read_bytes()
        assert z.read(name) == data
        assert hashlib.sha256(data).hexdigest() == record['sha256']
        with Image.open(folder / name) as im:
            assert im.size == (record['width'], record['height'])
            if name.endswith('.gif'):
                assert im.format == 'GIF' and im.n_frames == 6
                for i in range(6):
                    im.seek(i)
                    assert im.convert('RGBA').getpixel((0, 0))[3] == 0
                continue
            assert im.format == 'PNG' and im.mode == 'RGBA'
            for i, dy in enumerate((0, -2, -4, -5, -3, -1)):
                frame = im.crop((i * 192, 0, (i + 1) * 192, 208))
                box = frame.getbbox()
                assert frame.getpixel((0, 0))[3] == 0 and box
                if name.endswith('body_6frames.png'):
                    assert box[1] < 30 and box[3] > 185
                    for x,y in ((77,97),(115,97),(96,112)):
                        assert frame.getpixel((x,y+dy)) == (255,219,182,255)
                    assert frame.getpixel((96, 192))[3] > 0
                else:
                    if i == 5:
                        upper = frame.getpixel((77, 92 + dy))[3]
                        lower = frame.getpixel((77, 102 + dy))[3]
                        assert (upper > lower) if 'happy' in name else (lower > upper)
                    assert box[0] > 55 and 80 <= box[1] - dy < 105 and box[3] - dy < 125
                    assert frame.getpixel((96, 140 + dy))[3] == 0
`,folder]);

  await writeFile(zip,'corrupt final ZIP');
  await rejected(call,'package_character_parts',{generated_id});
  assert.equal(await readFile(zip,'utf8'),'corrupt final ZIP');

  const body=join(folder,'character_body_6frames.png');
  await writeFile(body,'invalid content');
  await rejected(call,'package_character_parts',{generated_id});
  for(const file of saves) {
    assert.equal(await readFile(join(root,'local_state/node_game',file),'utf8'),file);
  }
});

test('storage quota blocks additional generations before writing files',async t=>{
  const {root,client}=await fixture(t);
  const partsRoot=join(root,'local_state/character_parts');
  await mkdir(partsRoot);
  for(let i=0;i<32;i++) {
    await mkdir(join(partsRoot,'cp_'+i.toString(16).padStart(32,'0')));
  }
  const result=await client.callTool({name:'generate_character_parts',arguments:appearance});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/storage is full/);
  assert.equal((await readdir(partsRoot)).length,32);
});


function pythonRequest(root,args,input) {
  const result=promisify(execFile)('python3',['-B',...args],{cwd:join(root,'mcp')});
  result.child.stdin.end(input);
  return result;
}

test('SIGKILL before publication leaves no final artifact and retry reclaims staging',async t=>{
  const {root,client}=await fixture(t);
  const call=(name,args)=>client.callTool({name,arguments:args});
  const interrupt=(operation,input,stage)=>pythonRequest(root,['-c',`
import os, signal, sys
import character_parts as parts
move = parts.move_exclusive
def interrupted(parent, source, destination):
    if source == sys.argv[2]:
        os.kill(os.getpid(), signal.SIGKILL)
    move(parent, source, destination)
parts.move_exclusive = interrupted
operation, payload = parts.read_request(sys.argv[1:2], sys.stdin.buffer)
parts.run(operation, payload)
`,operation,stage],JSON.stringify(input)+'\n');

  const partsRoot=join(root,'local_state/character_parts');
  await assert.rejects(interrupt('generate',appearance,'.tmp-generation'),{signal:'SIGKILL'});
  assert.deepEqual(await readdir(partsRoot),['.tmp-generation']);
  const generated=await call('generate_character_parts',appearance);
  assert.equal(generated.isError,undefined,generated.content[0].text);
  const {generated_id}=generated.structuredContent;
  assert.deepEqual(await readdir(partsRoot),[generated_id]);
  const folder=join(partsRoot,generated_id);
  const zip=join(folder,'character_parts.zip');
  await assert.rejects(interrupt('package',{generated_id},'.tmp-character_parts.zip'),
    {signal:'SIGKILL'});
  await assert.rejects(readFile(zip),{code:'ENOENT'});
  assert.ok((await readdir(folder)).includes('.tmp-character_parts.zip'));
  const packed=await call('package_character_parts',{generated_id});
  assert.equal(packed.isError,undefined,packed.content[0].text);
  assert.ok(!(await readdir(folder)).includes('.tmp-character_parts.zip'));

  const sentinel=join(root,'local_state/node_game/unchanged');
  await writeFile(sentinel,'untouched',{mode:0o600});
  const temporary=join(folder,'.tmp-demo.json');
  await symlink(sentinel,temporary);
  await rejected(call,'register_demo_character',{generated_id});
  await rm(temporary);
  await link(sentinel,temporary);
  await rejected(call,'register_demo_character',{generated_id});
  assert.equal(await readFile(temporary,'utf8'),'untouched');
});

test('helper rejects extra arguments, overlong input, and extra input lines before storage access',async t=>{
  const {root}=await fixture(t);
  for(const [args,input] of [
    [['generate','extra'],'{}\n'],
    [['unknown'],'{}\n'],
    [['generate'],' '.repeat(1024)+'\n'],
    [['generate'],JSON.stringify(appearance)+'\n{}\n'],
    [['generate'],JSON.stringify({...appearance,name:[]})+'\n'],
  ]) {
    const {stdout}=await pythonRequest(root,['character_parts.py',...args],input);
    assert.equal(typeof JSON.parse(stdout).error,'string');
  }
  await assert.rejects(readdir(join(root,'local_state/character_parts')),{code:'ENOENT'});
});

test('helper receives JSON on stdin with a limited environment and stops on MCP cancellation',async t=>{
  const {root,client}=await fixture(t);
  const marker=join(root,'mcp/started.json');
  await writeFile(join(root,'mcp/character_parts.py'),`
import json, os, pathlib, sys, time
input_data = json.load(sys.stdin)
path = pathlib.Path(__file__).with_name('started.json')
if input_data['seed'] == 42:
    path.write_text(json.dumps({'args':sys.argv[1:], 'env':sorted(os.environ),
                                'name':input_data['name'], 'pid':os.getpid()}))
    time.sleep(30)
print(json.dumps({'error':'helper available'}))
`);
  const controller=new AbortController();
  const call=args=>client.callTool({name:'generate_character_parts',arguments:args},undefined,
    {signal:controller.signal});
  const pending=assert.rejects(call(appearance),/cancelled for test/);
  let started;
  for(let i=0;i<100 && !started;i++) {
    try { started=JSON.parse(await readFile(marker,'utf8')); }
    catch(error) {
      if(error.code!=='ENOENT' && !(error instanceof SyntaxError)) throw error;
      await delay(20);
    }
  }
  assert.ok(started,'expected helper to receive stdin');
  assert.deepEqual(started.args,['generate']);
  assert.deepEqual(started.env,['LANG','PATH']);
  assert.equal(started.name,appearance.name);
  controller.abort(Error('cancelled for test'));
  await pending;
  let result;
  for(let i=0;i<100;i++) {
    result=await client.callTool({name:'generate_character_parts',arguments:{...appearance,seed:43}});
    if(result.content[0].text==='helper available') break;
    await delay(20);
  }
  assert.equal(result.content[0].text,'helper available');
  assert.throws(()=>process.kill(started.pid,0),{code:'ESRCH'});
});
