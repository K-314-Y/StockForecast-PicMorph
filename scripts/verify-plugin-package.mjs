/** Offline package contract checks; safe to run before enabling any plugin. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const json=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
const require=createRequire(new URL('../mcp/package.json',import.meta.url));
const Ajv2020=require('ajv/dist/2020.js').default;
const ajv=new Ajv2020({allErrors:true});
for(const name of ['plugin','mcp']) {
  const schema=await json('scripts/schemas/agent-plugins-1.0.0/'+name+'.schema.json');
  const validate=ajv.compile(schema);
  assert.ok(validate(await json(name+'.json')),JSON.stringify(validate.errors));
}
const plugin=await json('plugin.json');
assert.equal(plugin.$schema,'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(plugin.name,'creature-lab');
assert.match(plugin.version,/^\d+\.\d+\.\d+$/);
assert.ok(plugin.extensions['com.openai'].interface.defaultPrompt.length>=3);
const server=await json('mcp.json');
assert.equal(server.$schema,'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.deepEqual(Object.keys(server.mcpServers),['creature-lab']);
const config=server.mcpServers['creature-lab'];
assert.equal(config.type,'stdio');
assert.equal(config.command,'node');
assert.deepEqual(config.args,['${PLUGIN_ROOT}/mcp/companion-stdio.mjs']);
assert.equal(config.cwd,'${PLUGIN_ROOT}');
assert.ok((await stat(join(root,'mcp/companion-stdio.mjs'))).isFile());
const skill=await readFile(join(root,'skills/creature-lab/SKILL.md'),'utf8');
assert.ok(skill.startsWith('---\nname: creature-lab\n'));
assert.match(skill,/synthetic game outcomes/);
assert.doesNotMatch(JSON.stringify(server),/tunnel_id|api_key|sk-proj|ngrok/i);
console.log('PASS portable plugin package: manifest + MCP stdio + skill + privacy constraints');

// Launch exactly the manifest configuration after host-style placeholder expansion.
const {Client}=await import('../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {StdioClientTransport}=await import('../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const expand=value=>value.replaceAll('${PLUGIN_ROOT}',root);
const transport=new StdioClientTransport({command:config.command,args:config.args.map(expand),cwd:expand(config.cwd),stderr:'pipe'});
const client=new Client({name:'plugin-package-smoke',version:'1.0.0'});
try {
  await client.connect(transport,{timeout:5000});
  const {tools}=await client.listTools({}, {timeout:5000});
  assert.equal(tools.length,10);
  assert.ok(tools.some(tool=>tool.name==='view_my_artwork_image'));
  console.log('PASS official 1.0.0 schemas + manifest cwd/args stdio handshake (10 tools; no game calls)');
}finally{await transport.close();}
