import test from 'node:test';
import assert from 'node:assert/strict';
import {extractCharacterZip} from '../../game_runtime/parts-lab/zip-import.mjs';
import {archive} from './zip-fixture.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMMqFjAwMDAxMDAwMDAAAAQugFsZnyF3gAAAABJRU5ErkJggg==','base64');
const images=[['character_body_6frames.png',png],['character_ready_6frames.png',png]];
const withManifest=appearance=>archive([...images,
  ['manifest.json',Buffer.from(JSON.stringify({schema_version:1,appearance}))]]);
test('manifest appearance is verified and exposed without mixing into image files',async()=>{
  const data=await extractCharacterZip(withManifest({
    name:'ラベンダー',accessory:'star',hair_color:'#A58BD9',clothing_color:'#78C2C5',
  }));
  assert.deepEqual(Object.keys(data),['body','ready']);
  assert.deepEqual(data.appearance,{
    name:'ラベンダー',accessory:'star',hair_color:'#a58bd9',clothing_color:'#78c2c5',
  });
  assert.equal(data.body.type,'image/png');
  assert.equal(data.body.size,png.length);
});
test('missing manifest remains usable but traits must be supplied in the UI',async()=>{
  const data=await extractCharacterZip(archive(images));
  assert.deepEqual(Object.keys(data),['body','ready']);
  assert.equal(data.appearance,undefined);
});
test('invalid or unsupported manifest attributes cannot silently drive a model',async()=>{
  for(const appearance of [
    {accessory:'fake'}, {hair_style:'banana'}, {hair_color:'red'}, {expression:12}
  ])await assert.rejects(extractCharacterZip(withManifest(appearance)),/ZIPの/);
});

test('ZIP equipment accepts built-ins and named methods and rejects ambiguous or invalid sets',async()=>{
  const custom={name:'  月のブローチ  ',method:'moving_average_trend'};
  const data=await extractCharacterZip(withManifest({accessories:['star','glasses',custom]}));
  assert.deepEqual(Object.keys(data),['body','ready']);
  assert.deepEqual(data.appearance.accessories,['star','glasses',{...custom,name:'月のブローチ'}]);
  for(const appearance of [
    {accessory:'star',accessories:['glasses']},
    {accessories:[]}, {accessories:'star'}, {accessories:['none','glasses']},
    {accessories:['star','star']},
    {accessories:['glasses',{...custom,method:'rsi_oversold'}]},
    {accessories:['star','glasses','ribbon',custom]},
    {accessories:[{...custom,method:'constructor'}]},
    {accessories:[{...custom,code:'extra'}]},
  ])await assert.rejects(extractCharacterZip(withManifest(appearance)),/ZIPの/);
});
