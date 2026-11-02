/** Cosmetic-only chibi parts. Independent of stock models, training XP and companion brains. */
import {readFile,mkdir,open,rename,unlink,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export const LOOK_FILE=fileURLToPath(new URL('../local_state/node_game/looks.json',import.meta.url));
export const LOOK_CHOICES=Object.freeze({
  hair_style:Object.freeze(['bob','long','twintails']),
  expression:Object.freeze(['cheerful','calm','determined']),
  accessory:Object.freeze(['ribbon','glasses','star','none']),
});
const DEFAULT=Object.freeze({hair_style:'bob',expression:'cheerful',accessory:'ribbon'});
const queues=new Map();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const keyset=value=>Object.keys(value).sort().join('|');
const fields='accessory|expression|hair_style';

export function validateLook(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || keyset(value)!==fields) {
    throw fail('髪型・表情・アクセサリーの3項目を指定してください');
  }
  for(const [field,choices] of Object.entries(LOOK_CHOICES)) {
    if(typeof value[field]!=='string' || !choices.includes(value[field])) {
      throw fail('未対応の外見パーツです: '+field);
    }
  }
  return {hair_style:value.hair_style,expression:value.expression,accessory:value.accessory};
}

export function createLookStore({file=LOOK_FILE}={}) {
  file=resolve(file);
  async function read() {
    try {
      const info=await lstat(file);
      if(!info.isFile() || info.isSymbolicLink() || info.size>2048) throw Error('invalid file');
      const data=JSON.parse(await readFile(file,'utf8'));
      if(!data || keyset(data)!=='look|revision|schema' || data.schema!==1 ||
         !Number.isSafeInteger(data.revision) || data.revision<1) throw Error('invalid record');
      return {created:true,revision:data.revision,look:validateLook(data.look)};
    }catch(error){
      if(error.code==='ENOENT') return {created:false,revision:0,look:{...DEFAULT}};
      throw fail('保存した外見を読み込めません',503);
    }
  }
  async function write(record) {
    const dir=dirname(file);
    await mkdir(dir,{recursive:true,mode:0o700});
    const info=await lstat(dir);
    if(!info.isDirectory() || info.isSymbolicLink()) throw fail('外見の保存先が不正です',503);
    const tmp=join(dir,'.looks-'+randomUUID());
    let handle;
    try {
      handle=await open(tmp,'wx',0o600);
      await handle.writeFile(JSON.stringify(record)+'\n');
      await handle.sync();
      await handle.close();handle=null;
      await rename(tmp,file);
      const folder=await open(dir,'r');
      try {await folder.sync();} finally {await folder.close();}
    }finally{
      if(handle) await handle.close();
      await unlink(tmp).catch(error=>{if(error.code!=='ENOENT') throw error;});
    }
  }
  return {
    read,
    save(payload) {
      const task=async()=>{
        if(!payload || typeof payload!=='object' || Array.isArray(payload) ||
           keyset(payload)!=='expected_revision|look' ||
           !Number.isSafeInteger(payload.expected_revision) || payload.expected_revision<0) {
          throw fail('外見と現在のrevisionを指定してください');
        }
        const look=validateLook(payload.look);
        const current=await read();
        if(current.revision!==payload.expected_revision || current.revision>=Number.MAX_SAFE_INTEGER) {
          throw fail('外見が別の操作で更新されています。再取得してください',409);
        }
        const revision=current.revision+1;
        await write({schema:1,revision,look});
        return {created:true,revision,look};
      };
      const result=(queues.get(file)??Promise.resolve()).then(task);
      const tail=result.catch(()=>{});
      queues.set(file,tail);
      tail.then(()=>{if(queues.get(file)===tail) queues.delete(file);});
      return result;
    },
  };
}
