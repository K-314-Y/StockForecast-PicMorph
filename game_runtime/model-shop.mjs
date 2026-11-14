/**
 * Local-only prototype: buy the right to use someone else's model by stable
 * model ID. When the author publishes changes, owners use the latest model.
 * No real authors, multi-user authentication, ads, JPX data,
 * public leaderboard or transferable currency. Never execute uploaded code.
 */
import {readFile, mkdir, open, rename, unlink, lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateLabModel} from './model-lab.mjs';

export const MODEL_SHOP_FILE=fileURLToPath(new URL('../local_state/node_game/model_shop.json',import.meta.url));
const BASE={fast_window:4,slow_window:12,risk_fraction:.35,
  plugin_weights:{trend:70,momentum:20,volatility:10,reversion:0},
  plugin_strengths:{trend:110,momentum:100,volatility:100,reversion:100}};
const CATALOG=[
  {id:'demo_trend',name:'追い風の研究者',author:'デモ作者A（架空）',price:80,
    description:'トレンドを中心に分析するサンプルモデル。',
    model:BASE},
  {id:'demo_reversion',name:'反転の観察者',author:'デモ作者B（架空）',price:110,
    description:'平均への戻りを中心に分析するサンプルモデル。',
    model:{fast_window:5,slow_window:16,risk_fraction:.25,
      plugin_weights:{trend:5,momentum:5,volatility:10,reversion:80},
      plugin_strengths:{trend:100,momentum:90,volatility:110,reversion:125}}},
].map(entry=>Object.freeze({...entry,model:Object.freeze(validateLabModel(entry.model))}));
const BY_ID=new Map(CATALOG.map(item=>[item.id,item]));
const keys=value=>Object.keys(value).sort().join('|');
const safeInt=value=>Number.isSafeInteger(value)&&value>=0;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
export class ModelShopError extends Error{
  constructor(message,status=400){super(message);this.status=status;}
}
function empty(){return {schema:1,revision:0,coins:200,licenses:[]};}
function checked(value){
  if(!plain(value)||keys(value)!=='coins|licenses|revision|schema'||value.schema!==1||
    !safeInt(value.revision)||!safeInt(value.coins)||value.coins>100000000||
    !Array.isArray(value.licenses)||value.licenses.length>CATALOG.length||
    new Set(value.licenses).size!==value.licenses.length||
    !value.licenses.every(id=>typeof id==='string'&&BY_ID.has(id))) {
    throw new ModelShopError('モデルショップの保存情報が不正です',503);
  }
  return value;
}
function itemPublic(item,licenses){
  const {id,name,author,price,description}=item;
  return {id,name,author,price,description,owned:licenses.includes(id),
    performance:'未検証・デモ専用'};
}
function publicState(state){
  return {mode:'LOCAL_DEMO_SHOP_ONLY',coins:state.coins,revision:state.revision,
    models:CATALOG.map(item=>itemPublic(item,state.licenses)),
    notice:'ローカル1人用の試作です。作者は架空で、価格も仮設定。モデル単位で使用権を解放し、作者の公開更新は次の練習から自動適用。投資用資金・XP・実株価結果には反映しません。',
    no_real_market:true,transferable:false};
}
async function readSafe(file){
  try{
    const stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)
      throw new ModelShopError('モデルショップの保存先が不正です',503);
    return checked(JSON.parse(await readFile(file,'utf8')));
  }catch(error){
    if(error.code==='ENOENT')return empty();
    if(error instanceof ModelShopError)throw error;
    throw new ModelShopError('モデルショップの保存情報を読めません',503);
  }
}
async function saveSafe(file,state){
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const tmp=join(dirname(file),'.model-shop-'+randomUUID());
  let handle;
  try{
    handle=await open(tmp,'wx',0o600);
    await handle.writeFile(JSON.stringify(checked(state))+'\n','utf8');
    await handle.sync();
    await handle.close();handle=null;
    await rename(tmp,file);
    const dir=await open(dirname(file),'r');
    try{await dir.sync();}finally{await dir.close();}
  }finally{
    if(handle)await handle.close();
    await unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}
export function createModelShopStore({file=MODEL_SHOP_FILE}={}){
  let sequence=Promise.resolve();
  const serialized=task=>{
    const out=sequence.then(task);
    sequence=out.catch(()=>{});
    return out;
  };
  const read=()=>readSafe(file);
  return {
    async public(){return publicState(await read());},
    async licensedModel(id){
      const item=BY_ID.get(id);
      if(!item)
        throw new ModelShopError('モデルが見つかりません',404);
      const state=await read();
      if(!state.licenses.includes(id))
        throw new ModelShopError('先にモデルの使用権を解放してください',403);
      return structuredClone(item.model);
    },
    purchase(payload){
      return serialized(async()=>{
        if(!plain(payload)||keys(payload)!=='expected_revision|id'||
          !safeInt(payload.expected_revision)||typeof payload.id!=='string')
          throw new ModelShopError('モデルIDと残高の版数を指定してください');
        const item=BY_ID.get(payload.id);
        if(!item)
          throw new ModelShopError('モデルが見つかりません',404);
        const before=await read();
        if(before.licenses.includes(item.id))
          return {...publicState(before),purchase_status:'already_owned'};
        if(before.revision!==payload.expected_revision)
          throw new ModelShopError('コイン残高が更新されました。再読み込みしてください',409);
        if(before.coins<item.price)
          throw new ModelShopError('コインが不足しています',400);
        const next={...before,revision:before.revision+1,
          coins:before.coins-item.price,licenses:[...before.licenses,item.id]};
        await saveSafe(file,next);
        return {...publicState(next),purchase_status:'unlocked'};
      });
    },
  };
}
