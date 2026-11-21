/** Local ZIP-game accessory definitions and their saved equipment snapshots. */
import {createHash} from 'node:crypto';
import {accessoryIdentityInput,BUILTIN_ACCESSORIES,MAX_EQUIPPED_ACCESSORIES,normalizeAccessoryDefinition,
  requireDistinctMethods} from './parts-lab/accessory-options.mjs';

export const ACCESSORY_COMBINATION_VERSION = 'accessory-analysis-v2';
export const CUSTOM_ACCESSORY_ID = /^accessory_[0-9a-f]{64}$/;
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export function validateAccessoryDefinition(value) {
  const {name,method}=normalizeAccessoryDefinition(value);
  return {id:'accessory_'+createHash('sha256').update(accessoryIdentityInput({name,method})).digest('hex'),
    name,method};
}

export function validateEquippedAccessories(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_EQUIPPED_ACCESSORIES)
    throw Error('invalid equipment');
  const equipped = items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3)
      throw Error('invalid accessory snapshot');
    const builtin = BUILTIN_ACCESSORIES.find(candidate => candidate.id === item.id);
    const expected = builtin ?? validateAccessoryDefinition({name:item.name,method:item.method});
    if (item.id !== expected.id || item.name !== expected.name || item.method !== expected.method) {
      throw Error('accessory identity mismatch');
    }
    return expected;
  });
  requireDistinctMethods(equipped.map(item => item.method));
  return equipped;
}

export function equipmentHash(characterId, modelHash, equipped) {
  return digest([ACCESSORY_COMBINATION_VERSION,characterId,modelHash,
    equipped.map(({id,name,method}) => [id,name,method])]);
}
