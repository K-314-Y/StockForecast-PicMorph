import assert from 'node:assert/strict';

const metadataTools=[
  'get_my_companion','get_my_creature_growth','get_my_look','get_my_artwork',
  'get_my_character_sheet','list_my_trained_brains',
];
const privateReaders=['view_my_artwork_image','preview_my_companion'];
const privateWriters=[
  'save_my_companion','save_my_look','generate_character_parts',
  'package_character_parts','register_demo_character',
];

export function verifyPluginTools(tools,{readOnly=false}={}) {
  const expected=readOnly ? metadataTools : [...metadataTools,...privateReaders,...privateWriters];
  assert.deepEqual(tools.map(tool=>tool.name).sort(),[...expected].sort());
  for(const tool of tools) {
    assert.ok(tool.description?.length>5,tool.name+' missing description');
    assert.equal(tool.inputSchema.type,'object',tool.name+' schema invalid');
    assert.equal(tool.annotations.openWorldHint,false,tool.name+' must stay private');
    assert.equal(tool.annotations.readOnlyHint,!privateWriters.includes(tool.name),tool.name);
  }
}
