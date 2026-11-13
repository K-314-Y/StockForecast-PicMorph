import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const script=join(root,'scripts/codex-creature-lab.sh');
const expected=['get_my_character_sheet','get_my_companion','get_my_look','get_my_artwork',
  'get_my_creature_growth','list_my_trained_brains'];

test('Codex wrapper scopes the private HTTP MCP connection to read-only metadata',async()=>{
 const contents=await readFile(script,'utf8');
 assert.match(contents,/127\.0\.0\.1:8896\/mcp/);
 assert.match(contents,/enabled_tools=/);
 assert.match(contents,/default_tools_approval_mode="auto"/);
 assert.doesNotMatch(contents,/view_my_artwork_image|save_my_companion|save_my_look|preview_my_companion/);
 assert.doesNotMatch(contents,/mcp add|--dangerously|sk-proj|\.codex\/config\.toml|ngrok/);
});

test('Codex wrapper passes only a strict tool allowlist and preserves CLI arguments',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'creature-codex-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const fake=join(dir,'codex');
 await writeFile(fake, '#!/usr/bin/env python3\nimport json,os,sys\nprint(json.dumps({"args":sys.argv[1:],"cwd":os.getcwd()}))\n');
 await chmod(fake,0o755);
 const stdout=execFileSync('bash',[script,'mcp','list'],{
   env:{...process.env,PATH:dir+':'+process.env.PATH},cwd:dir,encoding:'utf8'});
 const result=JSON.parse(stdout);
 assert.equal(result.cwd,root);
 assert.deepEqual(result.args.slice(-2),['mcp','list']);
 const configs=[];
 for(let i=0;i<result.args.length-2;i+=2){
   assert.equal(result.args[i],'-c');
   configs.push(result.args[i+1]);
 }
 const tools=configs.find(x=>x.startsWith('mcp_servers.creature_lab_local.enabled_tools='));
 assert.ok(tools);
 const allowed=JSON.parse(tools.split('=',2)[1]);
 assert.deepEqual(allowed,expected);
 assert.equal(new Set(allowed).size,allowed.length);
 assert.equal(configs.find(x=>x.includes('.url=')), 'mcp_servers.creature_lab_local.url="http://127.0.0.1:8896/mcp"');
 assert.ok(configs.includes('mcp_servers.creature_lab_local.required=false'));
 assert.ok(configs.includes('mcp_servers.creature_lab_local.enabled=true'));
 for(const arg of result.args)assert.doesNotMatch(arg,/view_my_artwork_image|save_my_look|save_my_companion/);
});
