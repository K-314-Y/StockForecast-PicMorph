/** Parse MCP Inspector CLI output after a real MCP transport connection. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const output=await readFile(process.argv[2],'utf8');
const index=output.indexOf('{');
assert.ok(index>=0,'Inspector did not emit tool JSON');
const data=JSON.parse(output.slice(index));
const names=data.tools.map(tool=>tool.name);
assert.deepEqual(new Set(names),new Set([
  'get_my_companion','save_my_companion','get_my_creature_growth',
  'get_my_look','save_my_look','get_my_artwork',
  'get_my_character_sheet','view_my_artwork_image',
  'list_my_trained_brains','preview_my_companion'
]));
assert.equal(names.length,10);
for (const tool of data.tools) {
  assert.ok(tool.description?.length>5,tool.name+' missing description');
  assert.equal(tool.inputSchema.type,'object',tool.name+' schema invalid');
  assert.equal(tool.annotations.openWorldHint,false,tool.name+' must stay private');
}
for (const name of ['save_my_companion','save_my_look']) {
  assert.equal(data.tools.find(t=>t.name===name).annotations.readOnlyHint,false);
}
for (const name of ['get_my_character_sheet','view_my_artwork_image','preview_my_companion']) {
  assert.equal(data.tools.find(t=>t.name===name).annotations.readOnlyHint,true);
}
console.log('PASS MCP Inspector: 10 tools, schemas, read/write classification, local-only metadata');
