/** Local ZIP character registry. Each registration owns an independent model snapshot.
 * Never touches live forecasts, existing companion, XP, wallets or V9 data. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readdir,lstat,rename,rmdir,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {deriveForwardCompanionModel,identifyForwardModel} from './forward-model.mjs';
import {APPROACHES,normalizeCompanionColor} from './companion.mjs';
import {validateLook} from './looks.mjs';
import {deriveForwardAppearanceModel,identifyForwardAppearanceModel} from './appearance-model.mjs';
import {validatedImageDimensions} from './image-validation.mjs';
import {ACCESSORY_COMBINATION_VERSION,CUSTOM_ACCESSORY_ID,equipmentHash,validateAccessoryDefinition,
  validateEquippedAccessories} from './accessory-catalog.mjs';
import {ACCESSORY_METHODS,BUILTIN_ACCESSORIES,MAX_EQUIPPED_ACCESSORIES,
  normalizeEquipment} from './parts-lab/accessory-options.mjs';
import {layerOffsetLimit,OVERLAY_MAX_SIDE,OVERLAY_POSITION,OVERLAY_SCALE} from './parts-lab/accessory-overlay.mjs';

export const IMPORTED_CHARACTER_ROOT=fileURLToPath(new URL('../local_state/node_game/imported-characters',import.meta.url));
export const IMPORTED_CHARACTER_ID=/^zip_[a-f0-9]{32}$/;
const MAX_IMAGE=5*1024*1024,MAX_PORTRAIT=1024*1024,MAX_TOTAL=21*1024*1024;
const MAX_OVERLAYS=MAX_EQUIPPED_ACCESSORIES*MAX_IMAGE;
// Base64 of at most 21 MiB of ZIP images + 15 MiB of overlays, with JSON headroom.
export const MAX_IMPORTED_REQUEST=50*1024*1024;
const MAX_IMPORTED_RECORD=MAX_IMPORTED_REQUEST;
export const MAX_IMPORTED_VISUAL_EDIT_REQUEST=22*1024*1024;
const MAX_CUSTOM_ACCESSORIES=32;
const SOURCE_KEYS=['body','ready','happy','cautious'];
const IMAGE_KEYS=[...SOURCE_KEYS,'portrait'];
const LAYERS=['body','face','outfit','hair'];
const MOODS=['ready','happy','cautious'];
const FRAME_SIDE=1024;
const visualImageLimits=kind=>({staticOnly:kind==='portrait',maxHeight:FRAME_SIDE,
  maxWidth:kind==='portrait'?FRAME_SIDE:6*FRAME_SIDE});
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const optionalKey=(item,keys,key)=>Object.hasOwn(item??{},key)?[...keys,key]:keys;
const visualKeys=(item,keys)=>optionalKey(item,keys,'visual');
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function decodeImage(value,part,details,limits) {
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
  const size=validatedImageDimensions(bytes,value.mime,limits);
  if(!size)
    throw fail('画像が破損しているか未対応の形式です',415);
  if(details)Object.assign(details,size,{bytes});
  return {mime:value.mime,base64:encoded,size:bytes.length};
}
function storedImage(item,part,details,limits) {
  try {
    if(limits&&!exact(item,['mime','base64','size']))throw Error('invalid saved image fields');
    const image=decodeImage({mime:item.mime,base64:item.base64},part,details,limits);
    if(image.size!==item.size)throw Error('invalid saved image size');
    return image;
  }catch{throw fail('画像の保存内容が不正です',503);}
}
const imageHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const visualSnapshot=(record,portrait)=>({portrait,...(record.visual?{visual:record.visual}:{})});
function editState(record,image_sha256) {
  // Include the rollback target so a change to either side invalidates an open editor.
  return {edit_token:createHash('sha256').update(JSON.stringify([record.id,image_sha256,record.visual??null]))
      .update(JSON.stringify(record.previous_visual??null)).digest('hex'),
    can_restore_previous:Object.hasOwn(record,'previous_visual')};
}
function readImages(input,{stored=false,withVisual=false}={}) {
  if(!object(input)||!Object.keys(input).every(k=>IMAGE_KEYS.includes(k))||
     !['body','ready','portrait'].every(k=>Object.hasOwn(input,k)))
    throw fail('体・通常顔・合成プレビューの画像が必要です');
  const images={},sizes={};
  let total=0;
  for(const [kind,item] of Object.entries(input)) {
    const details=withVisual?{}:undefined;
    const limits=withVisual?visualImageLimits(kind):undefined;
    images[kind]=(stored?storedImage:decodeImage)(item,kind,details,limits);
    total+=images[kind].size;
    if(total>MAX_TOTAL)throw fail('ZIP画像の合計サイズが大きすぎます',413);
    if(details)sizes[kind]={width:details.width,height:details.height};
  }
  if(withVisual) {
    const body=sizes.body,portrait=sizes.portrait;
    if(![1,6].includes(body.width/portrait.width)||body.height!==portrait.height||
       SOURCE_KEYS.some(kind=>sizes[kind]&&
         (sizes[kind].width!==body.width||sizes[kind].height!==body.height)))
      throw fail('素材は同じ寸法の横1コマまたは6コマで、合成画像は1コマの寸法にしてください');
  }
  return {images,sizes};
}
function validateVisual(visual,sizes,{appearance,equipped}) {
  if(!exact(visual,['schema','mood','offsets','overlays'])||visual.schema!==1||
     !MOODS.includes(visual.mood)||!Object.hasOwn(sizes,visual.mood)||
     !exact(visual.offsets,LAYERS)||!Array.isArray(visual.overlays)||
     visual.overlays.length>MAX_EQUIPPED_ACCESSORIES)
    throw fail('見た目の編集情報が不正です');
  const {width,height}=sizes.portrait;
  const offsets={};
  // JSON stores both signs of zero as 0. Normalize positions before comparing drafts.
  for(const layer of LAYERS) {
    const offset=visual.offsets[layer],limit=layerOffsetLimit(layer,width,height);
    if(!exact(offset,['x','y'])||![offset.x,offset.y].every(value=>inRange(value,-limit,limit)))
      throw fail('パーツの位置が範囲外です');
    offsets[layer]={x:offset.x||0,y:offset.y||0};
  }
  const ids=new Set(equipped?equipped.map(item=>item.id):
    BUILTIN_ACCESSORIES.filter(item=>item.id===appearance?.look?.accessory).map(item=>item.id));
  const overlays=[];
  let total=0;
  for(const overlay of visual.overlays) {
    if(!exact(overlay,['id','image','x','y','scale'])||!ids.delete(overlay.id)||
       ![overlay.x,overlay.y].every(value=>inRange(value,OVERLAY_POSITION.min,OVERLAY_POSITION.max))||
       !inRange(overlay.scale,OVERLAY_SCALE.min,OVERLAY_SCALE.max))
      throw fail('装備と重ね絵の位置情報が不正です');
    const {id,x,y,scale}=overlay;
    const {mime,base64,size}=decodeImage(overlay.image,'overlay',undefined,
      {staticOnly:true,maxWidth:OVERLAY_MAX_SIDE,maxHeight:OVERLAY_MAX_SIDE});
    total+=size;
    if(total>MAX_OVERLAYS)throw fail('重ね絵の合計サイズが大きすぎます',413);
    overlays.push({id,image:{mime,base64},x:x||0,y:y||0,scale});
  }
  return {schema:1,mood:visual.mood,offsets,overlays};
}
const inRange=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
function validateRegistration(payload) {
  const withVisual=Object.hasOwn(payload??{},'visual');
  const usingEquipment=exact(payload,visualKeys(payload,['name','look','colors','images','accessories']));
  const usingAppearance=usingEquipment||exact(payload,visualKeys(payload,['name','look','colors','images']));
  const legacy=exact(payload,visualKeys(payload,['name','approach','risk_percent','images']));
  if((!usingAppearance && !legacy) ||
     typeof payload.name!=='string'|| !payload.name.trim()||[...payload.name].length>16||
     /[\u0000-\u001f\u007f-\u009f]/u.test(payload.name))
    throw fail('キャラ名は1〜16文字で入力してください');
  const equipped=usingEquipment?normalizeEquipment(payload.accessories).map(item=>
    typeof item==='string'?BUILTIN_ACCESSORIES.find(accessory=>accessory.id===item):
      validateAccessoryDefinition(item)):null;
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
  const {images,sizes}=readImages(payload.images,{withVisual});
  const visual=withVisual?validateVisual(payload.visual,sizes,{appearance,equipped}):undefined;
  return {name:payload.name.trim(),images,generation,appearance,equipped,visual};
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
      bytes=Buffer.allocUnsafe(stat.size);
      for(let offset=0;offset<bytes.length;) {
        const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
        if(!bytesRead)throw fail('登録情報のサイズが一致しません',503);
        offset+=bytesRead;
      }
      if((await handle.stat()).size!==stat.size)throw fail('登録情報のサイズが一致しません',503);
    }finally{await handle?.close();}
    try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch{throw fail('登録情報が破損しています',503);}
  }
  async function writeRecord(file,record) {
    const content=JSON.stringify(record)+'\n';
    if(Buffer.byteLength(content)>MAX_IMPORTED_RECORD)throw fail('登録情報が大きすぎます',413);
    const temp=join(root,'.pending-'+randomUUID());
    try {
      const handle=await open(temp,'wx',0o600);
      try {await handle.writeFile(content);await handle.sync();}
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
  async function load(id,details={}) {
    if(typeof id!=='string'||!IMPORTED_CHARACTER_ID.test(id))throw fail('キャラIDが不正です',404);
    await ensureRoot();
    let item;
    try {item=await readRecord(join(root,id+'.json'),MAX_IMPORTED_RECORD);}
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
        const keys=visualKeys(item,['schema','id','ai_id','name','model_revision','generation',
          'appearance','equipped','equipment_hash','images']);
        if(!exact(item,optionalKey(item,keys,'previous_visual')) || !exact(item.appearance,['look','colors']))
          throw Error('invalid equipment record');
        if(item.appearance?.look.accessory!=='none')throw Error('equipment requires appearance');
        const equipped=validateEquippedAccessories(item.equipped);
        if(equipmentHash(id,validated.modelHash,equipped)!==item.equipment_hash)
          throw Error('equipment hash mismatch');
      }
    }catch{throw fail('保存済みモデル設定を検証できません',503);}
    if(Object.hasOwn(item,'visual')) {
      try {
        const {sizes}=readImages(item.images,{stored:true,withVisual:true});
        validateVisual(item.visual,sizes,item);
        details.sizes=sizes;
      }catch{throw fail('保存済みの見た目の編集情報を検証できません',503);}
    }
    if(Object.hasOwn(item,'previous_visual')) {
      try {
        const previous=item.previous_visual;
        if(!exact(previous,visualKeys(previous,['portrait']))||
           !exact(previous.portrait,['mime','base64','size']))
          throw Error('invalid visual history');
        const hasVisual=Object.hasOwn(previous,'visual');
        const previousSizes=hasVisual&&!details.sizes?
          readImages({...item.images,portrait:previous.portrait},{stored:true,withVisual:true}).sizes:undefined;
        const size=previousSizes?.portrait??{};
        if(!previousSizes)storedImage(previous.portrait,'portrait',size,
          hasVisual?visualImageLimits('portrait'):undefined);
        const current=details.sizes?.portrait??{};
        if(!details.sizes)storedImage(item.images.portrait,'portrait',current);
        if(size.width>FRAME_SIDE||size.height>FRAME_SIDE||
           size.width!==current.width||size.height!==current.height)
          throw Error('invalid previous portrait dimensions');
        if(hasVisual)validateVisual(previous.visual,previousSizes??details.sizes,item);
      }catch{throw fail('1つ前の見た目を検証できません',503);}
    }
    return item;
  }
  function checkCharacterId(id) {
    if(typeof id!=='string'||!IMPORTED_CHARACTER_ID.test(id))throw fail('キャラIDが不正です',404);
  }
  async function changePortrait(id,payload,change) {
    await ensureRoot();
    const lock=join(root,'.portrait-'+id+'.lock');
    try {await mkdir(lock,{mode:0o700});}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      throw fail('このキャラの画像は保存処理中です',409);
    }
    try {
      const details={};
      const record=await load(id,details);
      const current={};
      const portrait=storedImage(record.images.portrait,'portrait',current);
      const hash=imageHash(current.bytes);
      const state={id,image_sha256:hash,...editState(record,hash)};
      if(payload.expected_image_sha256!==hash||
         (Object.hasOwn(payload,'expected_edit_token')&&payload.expected_edit_token!==state.edit_token))
        throw fail('保存済みの見た目が別の画面で更新されました',409);
      const next=change(record,current,details);
      if(!next)return state;
      record.previous_visual=visualSnapshot(record,portrait);
      record.images.portrait=next.portrait;
      if(next.visual)record.visual=next.visual;
      else delete record.visual;
      const image_sha256=imageHash(Buffer.from(next.portrait.base64,'base64'));
      const result={id,image_sha256,...editState(record,image_sha256)};
      await writeRecord(join(root,id+'.json'),record);
      return result;
    }finally{await rmdir(lock);}
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
      const {name,images,generation,appearance,equipped,visual}=validateRegistration(payload);
      await ensureRoot();
      const id='zip_'+randomUUID().replaceAll('-','');
      const record={schema:equipped?2:1,id,ai_id:id,name,model_revision:1,
        generation:{model_version:generation.model_version,model:generation.model,modelHash:generation.modelHash},
        ...(appearance?{appearance}:{}),
        ...(equipped?{equipped,equipment_hash:equipmentHash(id,generation.modelHash,equipped)}:{}),images,
        ...(visual?{visual}:{})};
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
        if(Object.hasOwn(record.images,part))
          sources[part]=record.visual?record.images[part]:storedImage(record.images[part],part);
      }
      const image_sha256=imageHash(portrait.bytes);
      return {
        character:summary(record,image_sha256),sources,
        portrait:{width:portrait.width,height:portrait.height,image_sha256},
        ...editState(record,image_sha256),
        ...(record.visual?{visual:record.visual}:{}),
      };
    },
    async updatePortrait(id,payload) {
      checkCharacterId(id);
      const withVisual=Object.hasOwn(payload??{},'visual');
      const withToken=Object.hasOwn(payload??{},'expected_edit_token');
      const keys=visualKeys(payload,['expected_image_sha256','portrait']);
      if(!exact(payload,optionalKey(payload,keys,'expected_edit_token'))||
         !isHash(payload.expected_image_sha256)||((withVisual||withToken)&&!isHash(payload.expected_edit_token)))
        throw fail('保存済み画像の確認情報が不正です');
      const next={};
      const portrait=decodeImage(payload.portrait,'portrait',next,
        withVisual?visualImageLimits('portrait'):undefined);
      if(next.width>FRAME_SIDE||next.height>FRAME_SIDE)
        throw fail('合成画像の縦横は1024px以下にしてください');
      const state=await changePortrait(id,payload,(record,current,details)=>{
        if(current.width!==next.width||current.height!==next.height)
          throw fail('合成画像は保存済み画像と同じ寸法にしてください');
        const imageChanged=imageHash(next.bytes)!==payload.expected_image_sha256;
        let visual=record.visual;
        if(withVisual) {
          const sizes=details.sizes??readImages({...record.images,portrait},{stored:true,withVisual:true}).sizes;
          visual=validateVisual(payload.visual,sizes,record);
        }else if(record.visual&&imageChanged) {
          // Keep the last editable draft when a legacy client replaces only the portrait.
          decodeImage(payload.portrait,'portrait',undefined,visualImageLimits('portrait'));
        }
        if(imageChanged||!isDeepStrictEqual(visual,record.visual))return {portrait,visual};
      });
      return withToken?state:{id,image_sha256:state.image_sha256};
    },
    async restorePortrait(id,payload) {
      checkCharacterId(id);
      if(!exact(payload,['expected_image_sha256','expected_edit_token'])||
         !isHash(payload.expected_image_sha256)||!isHash(payload.expected_edit_token))
        throw fail('保存済み画像の確認情報が不正です');
      return changePortrait(id,payload,record=>{
        if(!record.previous_visual)throw fail('1つ前の見た目がありません',409);
        return record.previous_visual;
      });
    },
  };
}
