/** Local ZIP character registry. Each registration owns an independent model snapshot.
 * Never touches live forecasts, existing companion, XP, wallets or V9 data. */
import {randomUUID} from 'node:crypto';
import {mkdir,open,readdir,lstat,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deriveForwardCompanionModel,identifyForwardModel} from './forward-model.mjs';
import {APPROACHES,normalizeCompanionColor} from './companion.mjs';
import {validateLook} from './looks.mjs';
import {deriveForwardAppearanceModel,identifyForwardAppearanceModel} from './appearance-model.mjs';
import {validateImageStructure} from './image-validation.mjs';

export const IMPORTED_CHARACTER_ROOT=fileURLToPath(new URL('../local_state/node_game/imported-characters',import.meta.url));
export const IMPORTED_CHARACTER_ID=/^zip_[a-f0-9]{32}$/;
export const MAX_IMPORTED_REQUEST=30*1024*1024;
const MAX_IMAGE=5*1024*1024,MAX_PORTRAIT=1024*1024,MAX_TOTAL=21*1024*1024;
const IMAGE_KEYS=['body','ready','happy','cautious','portrait'];
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
function decodeImage(value,part) {
  if(!exact(value,['mime','base64'])||!['image/png','image/webp'].includes(value.mime))
    throw fail('キャラ画像はPNGまたはWebPにしてください');
  const encoded=value.base64;
  const limit=part==='portrait'?MAX_PORTRAIT:MAX_IMAGE;
  if(typeof encoded!=='string'||encoded.length<4||encoded.length>4*Math.ceil(limit/3)||
     encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw fail('画像のbase64が不正です');
  const bytes=Buffer.from(encoded,'base64');
  if(!bytes.length||bytes.length>limit||bytes.toString('base64')!==encoded)
    throw fail('画像サイズまたはbase64が不正です',413);
  if(!validateImageStructure(bytes,value.mime))
    throw fail('画像が破損しているか未対応の形式です',415);
  return {mime:value.mime,base64:encoded,size:bytes.length};
}
function validateRegistration(payload) {
  const usingAppearance=exact(payload,['name','look','colors','images']);
  const legacy=exact(payload,['name','approach','risk_percent','images']);
  if((!usingAppearance && !legacy) ||
     typeof payload.name!=='string'|| !payload.name.trim()||[...payload.name].length>16||
     /[\u0000-\u001f\u007f-\u009f]/u.test(payload.name))
    throw fail('キャラ名は1〜16文字で入力してください');
  if(!object(payload.images)||!Object.keys(payload.images).every(k=>IMAGE_KEYS.includes(k))||
     !['body','ready','portrait'].every(k=>Object.hasOwn(payload.images,k)))
    throw fail('体・通常顔・合成プレビューの画像が必要です');
  let generation, appearance=null;
  if(usingAppearance) {
    const look=validateLook(payload.look);
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
  return {name:payload.name.trim(),images,generation,appearance};
}
function summary(record) {
  return {id:record.id,name:record.name,ai_id:record.ai_id,
    model_version:record.generation.model_version,
    model:record.generation.model,model_revision:record.model_revision,
    image_url:'/api/imported-characters/image/'+record.id,
    appearance:record.appearance??null,
    model_origin:record.appearance?'appearance_features':'legacy_manual',
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
  async function load(id) {
    if(!IMPORTED_CHARACTER_ID.test(id))throw fail('キャラIDが不正です',404);
    const file=join(root,id+'.json');
    let bytes,handle;
    try {
      handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=await handle.stat();
      if(!stat.isFile()||stat.nlink!==1||(stat.mode & 0o777)!==0o600||
         stat.size<1||stat.size>MAX_IMPORTED_REQUEST)throw fail('登録情報が不正です',503);
      bytes=await handle.readFile();
      if(bytes.length!==stat.size)throw fail('登録情報のサイズが一致しません',503);
    }catch(error){
      if(error.code==='ENOENT')throw fail('キャラが見つかりません',404);
      throw error;
    }finally{await handle?.close();}
    let item;try {item=JSON.parse(bytes.toString('utf8'));}catch{throw fail('登録情報が破損しています',503);}
    if(item?.schema!==1||item.id!==id||item.ai_id!==id||
       !Number.isSafeInteger(item.model_revision)||item.model_revision!==1||
       !object(item.images)||!item.images.body||!item.images.ready||!item.images.portrait||
       !item.generation||!item.name)throw fail('登録情報が不正です',503);
    try {
      const validated=identifyForwardModel(item.generation);
      if(validated.modelHash!==item.generation.modelHash)throw Error('model hash mismatch');
      if(item.appearance!==undefined&&item.appearance!==null) {
        const look=validateLook(item.appearance.look);
        if(!exact(item.appearance.colors,['hair_color','clothing_color']))throw Error('colors mismatch');
        const fromLook=identifyForwardAppearanceModel(deriveForwardAppearanceModel(
          look,item.appearance.colors));
        if(fromLook.model_version!==validated.model_version||
           fromLook.modelHash!==validated.modelHash)throw Error('appearance/model mismatch');
      }
    }catch{throw fail('保存済みモデル設定を検証できません',503);}
    return item;
  }
  return {
    async register(payload) {
      const {name,images,generation,appearance}=validateRegistration(payload);
      await ensureRoot();
      const id='zip_'+randomUUID().replaceAll('-','');
      const record={schema:1,id,ai_id:id,name,model_revision:1,
        generation:{model_version:generation.model_version,model:generation.model,modelHash:generation.modelHash},
        ...(appearance?{appearance}:{}),images};
      const file=join(root,id+'.json');
      const handle=await open(file,'wx',0o600);
      try {await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();}
      catch(error){await handle.close();await unlink(file);throw error;}
      await handle.close();
      const folder=await open(root,'r');
      try {await folder.sync();}finally{await folder.close();}
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
      model_revision:record.model_revision,name:record.name,ai_id:record.ai_id};},
    async image(id) {
      const item=(await load(id)).images.portrait;
      const validated=decodeImage({mime:item.mime,base64:item.base64},'portrait');
      if(validated.size!==item.size)throw fail('画像の保存内容が不正です',503);
      return {mime:validated.mime,bytes:Buffer.from(validated.base64,'base64')};
    },
  };
}
