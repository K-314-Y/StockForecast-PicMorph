/** Local ZIP character registry. Each registration owns an independent model snapshot.
 * Never touches live forecasts, existing companion, XP, wallets or V9 data. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readdir,lstat,rename,rmdir,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deriveForwardCompanionModel,identifyForwardModel} from './forward-model.mjs';
import {APPROACHES,normalizeCompanionColor} from './companion.mjs';
import {validateLook} from './looks.mjs';
import {deriveForwardAppearanceModel,identifyForwardAppearanceModel} from './appearance-model.mjs';
import {validatedImageDimensions} from './image-validation.mjs';
import {ACCESSORY_COMBINATION_VERSION,CUSTOM_ACCESSORY_ID,equipmentHash,validateAccessoryDefinition,
  validateEquippedAccessories} from './accessory-catalog.mjs';
import {ACCESSORY_METHODS,BUILTIN_ACCESSORIES,normalizeEquipment} from './parts-lab/accessory-options.mjs';

export const IMPORTED_CHARACTER_ROOT=fileURLToPath(new URL('../local_state/node_game/imported-characters',import.meta.url));
export const IMPORTED_CHARACTER_ID=/^zip_[a-f0-9]{32}$/;
export const MAX_IMPORTED_REQUEST=30*1024*1024;
const MAX_IMAGE=5*1024*1024,MAX_PORTRAIT=1024*1024,MAX_TOTAL=21*1024*1024;
export const MAX_IMPORTED_PORTRAIT_REQUEST=4*Math.ceil(MAX_PORTRAIT/3)+512;
const MAX_CUSTOM_ACCESSORIES=32;
const SOURCE_KEYS=['body','ready','happy','cautious'];
const IMAGE_KEYS=[...SOURCE_KEYS,'portrait'];
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
function decodeImage(value,part,details) {
  if(!exact(value,['mime','base64'])||!['image/png','image/webp'].includes(value.mime))
    throw fail('キャラ画像はPNGまたはWebPにしてください');
  const encoded=value.base64;
  const limit=part==='portrait'?MAX_PORTRAIT:MAX_IMAGE;
  if(typeof encoded==='string'&&encoded.length>4*Math.ceil(limit/3))
    throw fail('画像が大きすぎます',413);
  if(typeof encoded!=='string'||encoded.length<4||
     encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw fail('画像のbase64が不正です');
  const bytes=Buffer.from(encoded,'base64');
  if(!bytes.length||bytes.length>limit||bytes.toString('base64')!==encoded)
    throw fail('画像サイズまたはbase64が不正です',413);
  const size=validatedImageDimensions(bytes,value.mime);
  if(!size)
    throw fail('画像が破損しているか未対応の形式です',415);
  if(details)Object.assign(details,size,{bytes});
  return {mime:value.mime,base64:encoded,size:bytes.length};
}
function storedImage(item,part,details) {
  try {
    const image=decodeImage({mime:item.mime,base64:item.base64},part,details);
    if(image.size!==item.size)throw Error('invalid saved image size');
    return image;
  }catch{throw fail('画像の保存内容が不正です',503);}
}
const imageHash=bytes=>createHash('sha256').update(bytes).digest('hex');
function validateRegistration(payload) {
  const usingEquipment=exact(payload,['name','look','colors','images','accessories']);
  const usingAppearance=usingEquipment||exact(payload,['name','look','colors','images']);
  const legacy=exact(payload,['name','approach','risk_percent','images']);
  if((!usingAppearance && !legacy) ||
     typeof payload.name!=='string'|| !payload.name.trim()||[...payload.name].length>16||
     /[\u0000-\u001f\u007f-\u009f]/u.test(payload.name))
    throw fail('キャラ名は1〜16文字で入力してください');
  const equipped=usingEquipment?normalizeEquipment(payload.accessories).map(item=>
    typeof item==='string'?BUILTIN_ACCESSORIES.find(accessory=>accessory.id===item):
      validateAccessoryDefinition(item)):null;
  if(!object(payload.images)||!Object.keys(payload.images).every(k=>IMAGE_KEYS.includes(k))||
     !['body','ready','portrait'].every(k=>Object.hasOwn(payload.images,k)))
    throw fail('体・通常顔・合成プレビューの画像が必要です');
  let generation, appearance=null;
  if(usingAppearance) {
    const look=validateLook(payload.look);
    if(usingEquipment && look.accessory!=='none')
      throw fail('単体の外見設定と複数装備を同時に指定できません');
    if(!exact(payload.colors,['hair_color','clothing_color']))
      throw fail('髪と服の色を指定してください');
    const colors={hair_color:normalizeCompanionColor(payload.colors.hair_color),
      clothing_color:normalizeCompanionColor(payload.colors.clothing_color)};
    // Existing appearance rules govern the real numerical model, not a character ID.
    generation=identifyForwardAppearanceModel(deriveForwardAppearanceModel(look,colors));
    appearance={look,colors};
  }else {
    if(!APPROACHES.includes(payload.approach)||!Number.isInteger(payload.risk_percent)||
       payload.risk_percent<5||payload.risk_percent>100||payload.risk_percent%5!==0)
      throw fail('予測ルールまたは使用率が不正です');
    generation=deriveForwardCompanionModel({
      approach:payload.approach,risk_percent:payload.risk_percent});
  }
  const images={};let total=0;
  for(const [kind,item] of Object.entries(payload.images)) {
    images[kind]=decodeImage(item,kind);
    total+=images[kind].size;
    if(total>MAX_TOTAL)throw fail('ZIP画像の合計サイズが大きすぎます',413);
  }
  return {name:payload.name.trim(),images,generation,appearance,equipped};
}
function summary(record,portraitHash=imageHash(Buffer.from(record.images.portrait.base64,'base64'))) {
  return {id:record.id,name:record.name,ai_id:record.ai_id,
    model_version:record.generation.model_version,
    model:record.generation.model,model_revision:record.model_revision,
    image_url:'/api/imported-characters/image/'+record.id+'?v='+portraitHash,
    appearance:record.appearance??null,
    model_origin:record.appearance?'appearance_features':'legacy_manual',
    accessory_analysis:record.schema===2?{
      version:ACCESSORY_COMBINATION_VERSION,equipped:record.equipped,
    }:record.appearance?{
      accessory:record.appearance.look.accessory,
      method:ACCESSORY_METHODS[record.appearance.look.accessory],
      version:'accessory-analysis-v1',
    }:null,
    frames:6,source:'ZIP_LOCAL',trained:false,live_market:false};
}
export function createImportedCharacterStore({root=IMPORTED_CHARACTER_ROOT}={}) {
  root=resolve(root);
  async function ensureRoot() {
    await mkdir(root,{recursive:true,mode:0o700});
    const info=await lstat(root);
    if(!info.isDirectory()||info.isSymbolicLink()||(info.mode & 0o777)!==0o700)
      throw fail('登録保存先が不正です',503);
  }
  async function readRecord(file,maxSize) {
    let bytes,handle;
    try {
      handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=await handle.stat();
      if(!stat.isFile()||stat.nlink!==1||(stat.mode & 0o777)!==0o600||
         stat.size<1||stat.size>maxSize)throw fail('登録情報が不正です',503);
      bytes=await handle.readFile();
      if(bytes.length!==stat.size)throw fail('登録情報のサイズが一致しません',503);
    }finally{await handle?.close();}
    try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch{throw fail('登録情報が破損しています',503);}
  }
  async function writeRecord(file,record) {
    const temp=join(root,'.pending-'+randomUUID());
    try {
      const handle=await open(temp,'wx',0o600);
      try {await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();}
      finally{await handle.close();}
      await rename(temp,file);
    }finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    const folder=await open(root,'r');
    try {await folder.sync();}finally{await folder.close();}
  }
  async function loadAccessory(id) {
    const builtin=BUILTIN_ACCESSORIES.find(item=>item.id===id);
    if(builtin)return builtin;
    let data;
    try {data=await readRecord(join(root,id+'.json'),1024);}
    catch(error){
      if(error.code==='ENOENT')throw fail('アクセサリーが見つかりません',404);
      throw error;
    }
    try {
      const [validated]=validateEquippedAccessories([data]);
      if(validated.id!==id)throw Error('invalid accessory ID');
      return validated;
    }catch{throw fail('保存済みアクセサリーを検証できません',503);}
  }
  async function customAccessoryIds() {
    return (await readdir(root)).filter(name=>name.endsWith('.json'))
      .map(name=>name.slice(0,-5)).filter(id=>CUSTOM_ACCESSORY_ID.test(id)).sort();
  }
  async function load(id) {
    if(typeof id!=='string'||!IMPORTED_CHARACTER_ID.test(id))throw fail('キャラIDが不正です',404);
    await ensureRoot();
    let item;
    try {item=await readRecord(join(root,id+'.json'),MAX_IMPORTED_REQUEST);}
    catch(error){
      if(error.code==='ENOENT')throw fail('キャラが見つかりません',404);
      if(error.code==='ELOOP')throw fail('キャラ保存先が不正です',503);
      throw error;
    }
    if(![1,2].includes(item?.schema)||item.id!==id||item.ai_id!==id||
       !Number.isSafeInteger(item.model_revision)||item.model_revision!==1||
       !object(item.images)||!item.images.body||!item.images.ready||!item.images.portrait||
       !item.generation||!item.name)throw fail('登録情報が不正です',503);
    try {
      const validated=identifyForwardModel(item.generation);
      if(validated.modelHash!==item.generation.modelHash)throw Error('model hash mismatch');
      if(item.schema===1&&(Object.hasOwn(item,'equipped')||Object.hasOwn(item,'equipment_hash')))
        throw Error('unexpected accessory equipment');
      if(item.appearance!==undefined&&item.appearance!==null) {
        const look=validateLook(item.appearance.look);
        if(!exact(item.appearance.colors,['hair_color','clothing_color']))throw Error('colors mismatch');
        const fromLook=identifyForwardAppearanceModel(deriveForwardAppearanceModel(
          look,item.appearance.colors));
        if(fromLook.model_version!==validated.model_version||
           fromLook.modelHash!==validated.modelHash)throw Error('appearance/model mismatch');
      }
      if(item.schema===2) {
        if(!exact(item,['schema','id','ai_id','name','model_revision','generation','appearance',
          'equipped','equipment_hash','images']) || !exact(item.appearance,['look','colors']))
          throw Error('invalid equipment record');
        if(item.appearance?.look.accessory!=='none')throw Error('equipment requires appearance');
        const equipped=validateEquippedAccessories(item.equipped);
        if(equipmentHash(id,validated.modelHash,equipped)!==item.equipment_hash)
          throw Error('equipment hash mismatch');
      }
    }catch{throw fail('保存済みモデル設定を検証できません',503);}
    return item;
  }
  return {
    async listAccessories() {
      await ensureRoot();
      const accessories=[...BUILTIN_ACCESSORIES];
      for(const id of await customAccessoryIds())accessories.push(await loadAccessory(id));
      return {accessories};
    },
    async addAccessory(payload) {
      const accessory=validateAccessoryDefinition(payload);
      await ensureRoot();
      // Serialize the existence and capacity checks across local server processes.
      const lock=join(root,'.accessory-catalog.lock');
      try {await mkdir(lock,{mode:0o700});}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        throw fail('アクセサリー一覧は保存処理中です。再度お試しください',409);
      }
      try {
        try {return await loadAccessory(accessory.id);}
        catch(error){if(error.status!==404)throw error;}
        if((await customAccessoryIds()).length>=MAX_CUSTOM_ACCESSORIES)
          throw fail('このPCで作成できるアクセサリーは32件までです',409);
        await writeRecord(join(root,accessory.id+'.json'),accessory);
        return accessory;
      }finally{await rmdir(lock);}
    },
    async register(payload) {
      const {name,images,generation,appearance,equipped}=validateRegistration(payload);
      await ensureRoot();
      const id='zip_'+randomUUID().replaceAll('-','');
      const record={schema:equipped?2:1,id,ai_id:id,name,model_revision:1,
        generation:{model_version:generation.model_version,model:generation.model,modelHash:generation.modelHash},
        ...(appearance?{appearance}:{}),
        ...(equipped?{equipped,equipment_hash:equipmentHash(id,generation.modelHash,equipped)}:{}),images};
      await writeRecord(join(root,id+'.json'),record);
      return summary(record);
    },
    async list() {
      try {await ensureRoot();}catch(error){throw fail(error.message,503);}
      const entries=(await readdir(root)).filter(name=>/^zip_[a-f0-9]{32}\.json$/.test(name)).sort();
      const chars=[];
      for(const filename of entries)chars.push(summary(await load(filename.slice(0,-5))));
      return {characters:chars};
    },
    async model(id) {const record=await load(id);return {
      model:record.generation.model,model_version:record.generation.model_version,
      model_revision:record.model_revision,name:record.name,ai_id:record.ai_id,
      ...(record.schema===2?{
        accessory_methods:record.equipped.map(item=>item.method),
        equipment_hash:record.equipment_hash,
      }:{accessory_strategy:record.appearance?.look.accessory??null})};},
    async image(id) {
      const details={};
      const {mime}=storedImage((await load(id)).images.portrait,'portrait',details);
      return {mime,bytes:details.bytes};
    },
    async visualEdit(id) {
      const record=await load(id);
      const portrait={};
      storedImage(record.images.portrait,'portrait',portrait);
      const sources={};
      for(const part of SOURCE_KEYS) {
        if(Object.hasOwn(record.images,part))sources[part]=storedImage(record.images[part],part);
      }
      const image_sha256=imageHash(portrait.bytes);
      return {
        character:summary(record,image_sha256),sources,
        portrait:{width:portrait.width,height:portrait.height,image_sha256},
      };
    },
    async updatePortrait(id,payload) {
      if(typeof id!=='string'||!IMPORTED_CHARACTER_ID.test(id))throw fail('キャラIDが不正です',404);
      if(!exact(payload,['expected_image_sha256','portrait'])||
         typeof payload.expected_image_sha256!=='string'||!/^[a-f0-9]{64}$/.test(payload.expected_image_sha256))
        throw fail('保存済み画像の確認情報が不正です');
      const next={};
      const portrait=decodeImage(payload.portrait,'portrait',next);
      if(next.width>1024||next.height>1024)throw fail('合成画像の縦横は1024px以下にしてください');
      await ensureRoot();
      const lock=join(root,'.portrait-'+id+'.lock');
      try {await mkdir(lock,{mode:0o700});}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        throw fail('このキャラの画像は保存処理中です',409);
      }
      try {
        // Verify the current portrait under the same lock held through replacement.
        const record=await load(id);
        const previous={};
        storedImage(record.images.portrait,'portrait',previous);
        if(imageHash(previous.bytes)!==payload.expected_image_sha256)
          throw fail('保存済みの画像が別の画面で更新されました',409);
        if(previous.width!==next.width||previous.height!==next.height)
          throw fail('合成画像は保存済み画像と同じ寸法にしてください');
        const image_sha256=imageHash(next.bytes);
        if(image_sha256!==payload.expected_image_sha256) {
          record.images.portrait=portrait;
          await writeRecord(join(root,id+'.json'),record);
        }
        return {id,image_sha256};
      }finally{await rmdir(lock);}
    },
  };
}
