/** Per-character configuration only. Asset validation is owned by the local API. */
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const CHARACTER_EQUIPMENT_API='/api/character-equipment/v1';
export const MAX_EQUIPMENT_BYTES=4096;
const HELPER=fileURLToPath(new URL('../mcp/character_equipment.py',import.meta.url));
const ANCHORS=['base','outfit','face','hair'];
const names=value=>value && typeof value==='object' && !Array.isArray(value) ? Object.keys(value).sort().join('|') : '';
const revision=value=>Number.isSafeInteger(value) && value>=0;
const matches=(value,length,pattern)=>typeof value==='string' && value.length===length && pattern.test(value);
const fail=(status,message)=>Object.assign(Error(message),{status});

export function validateEquipmentParts(parts) {
  if(!Array.isArray(parts) || parts.length>8)throw fail(400,'装備は8件まで指定できます');
  const seen=new Set();
  for(const part of parts) {
    if(names(part)!=='image_sha256|layer_anchor|part_id|visible|x|y' ||
       !matches(part.part_id,35,/^pt_[0-9a-f]{32}$/) || seen.has(part.part_id) ||
       !matches(part.image_sha256,64,/^[0-9a-f]{64}$/) || !ANCHORS.includes(part.layer_anchor) ||
       typeof part.visible!=='boolean' || ![part.x,part.y].every(v=>Number.isInteger(v) && v>=-24 && v<=24)) {
      throw fail(400,'装備のID・配置・位置・表示設定が不正です');
    }
    seen.add(part.part_id);
  }
  return parts;
}

export function validateEquipmentSave(payload) {
  if(names(payload)!=='expected_revision|parts' || !revision(payload.expected_revision)) {
    throw fail(400,'現在のrevisionと装備設定を指定してください');
  }
  return {expected_revision:payload.expected_revision,parts:validateEquipmentParts(payload.parts)};
}

export function equipmentRecord(value, characterId) {
  try {
    if(names(value)!=='character_id|parts|revision|schema' || value.schema!==1 ||
       value.character_id!==characterId || !revision(value.revision) || (value.revision===0 && value.parts?.length!==0)) {
      throw Error('Invalid record');
    }
    validateEquipmentParts(value.parts);
    return value;
  } catch {throw fail(503,'装備設定の整合性を確認できませんでした');}
}

export function createCharacterEquipmentStore({script=HELPER}={}) {
  function call(operation,character_id,input={},signal) {
    if(process.platform!=='linux' || !matches(character_id,35,/^cp_[0-9a-f]{32}$/)) {
      return Promise.reject(fail(400,'登録キャラIDまたは実行環境が不正です'));
    }
    return new Promise((resolve,reject)=>{
      let outcome;
      const child=execFile('python3',['-B','-E',script,operation],{
        env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'},
        signal,timeout:6000,maxBuffer:MAX_EQUIPMENT_BYTES,killSignal:'SIGKILL',
      },(error,stdout)=>{outcome={error,stdout};});
      child.once('close',()=>{
        try {
          if(!outcome || outcome.error)throw Error('Equipment helper failed');
          const response=JSON.parse(outcome.stdout);
          if(response.code==='conflict')return reject(fail(409,'装備設定が別の操作で更新されました'));
          resolve(equipmentRecord(response.result,character_id));
        }catch{reject(fail(503,'装備設定を安全に読み書きできませんでした'));}
      });
      child.stdin.on('error',()=>child.kill('SIGKILL'));
      child.stdin.end(JSON.stringify({...input,character_id})+'\n');
    });
  }
  return {
    read:(id,signal)=>call('read',id,{},signal),
    save:(id,input)=>call('save',id,validateEquipmentSave(input)),
  };
}
