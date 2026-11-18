/** Local, manually supplied full-character illustrations. */
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ARTWORK_FILE,MAX_ARTWORK_FILE,validateArtworkImage} from './artwork.mjs';

export const ARTWORK_EXPRESSIONS_FILE=fileURLToPath(new URL('../local_state/node_game/artwork-expressions.json',import.meta.url));
export const EXPRESSION_MOODS=Object.freeze(['happy','cautious']);
export const MAX_EXPRESSION_REQUEST=4*Math.ceil(MAX_ARTWORK_FILE/3)+1024;
const MAX_RECORD=2*MAX_EXPRESSION_REQUEST;
const queues=new Map();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hasKeys=(value,keys)=>value!==null && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));

function metadata(record) {
  return {revision:record.revision,created:record.revision>0,
    moods:Object.fromEntries(EXPRESSION_MOODS.map(mood=>{
      const image=record.moods[mood];
      return [mood,{exists:image!==null,mime:image?.mime??null,size:image?.size??0}];
    }))};
}

export function createArtworkExpressionStore({file=ARTWORK_EXPRESSIONS_FILE}={}) {
  file=resolve(file);
  if (file===ARTWORK_FILE) throw Error('Expression artwork requires its own storage file');

  async function readRecord() {
    try {
      let handle;
      try {
        handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      } catch (error) {
        if (error.code==='ENOENT') return {schema:1,revision:0,moods:{happy:null,cautious:null}};
        throw error;
      }
      let record;
      try {
        const info=await handle.stat();
        if (!info.isFile() || info.size>MAX_RECORD) throw Error('invalid file');
        const bytes=Buffer.alloc(info.size+1);
        let offset=0;
        while (offset<bytes.length) {
          const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset);
          if (bytesRead===0) break;
          offset+=bytesRead;
        }
        if (offset!==info.size) throw Error('invalid size');
        record=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,offset)));
      } finally {
        await handle.close();
      }
      if (!hasKeys(record,['schema','revision','moods']) || record.schema!==1 ||
          !Number.isSafeInteger(record.revision) || record.revision<1 ||
          !hasKeys(record.moods,EXPRESSION_MOODS)) throw Error('invalid record');
      for (const image of Object.values(record.moods)) {
        if (image===null) continue;
        if (!hasKeys(image,['mime','base64','size'])) throw Error('invalid image');
        const validated=validateArtworkImage('base',{mime:image.mime,base64:image.base64});
        if (image.size!==validated.size) throw Error('invalid size');
      }
      return record;
    } catch {
      throw fail('表情イラストの保存情報を読み込めません。保存ファイルを確認してください',503);
    }
  }

  async function writeRecord(record) {
    const dir=dirname(file);
    await mkdir(dir,{recursive:true,mode:0o700});
    if (!(await lstat(dir)).isDirectory()) throw Error('invalid storage directory');
    const tmp=join(dir,'.artwork-expressions-'+randomUUID());
    const handle=await open(tmp,'wx',0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(record)+'\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp,file);
      const folder=await open(dir,'r');
      try {await folder.sync();} finally {await folder.close();}
    } finally {
      await unlink(tmp).catch(error=>{if (error.code!=='ENOENT') throw error;});
    }
  }

  return {
    async read() {
      return metadata(await readRecord());
    },
    async image(mood) {
      if (!EXPRESSION_MOODS.includes(mood)) throw fail('画像が見つかりません',404);
      const {moods}=await readRecord();
      const image=moods[mood];
      if (!image) throw fail('画像が見つかりません',404);
      return {mime:image.mime,bytes:Buffer.from(image.base64,'base64')};
    },
    save(payload) {
      const task=async()=>{
        if (!hasKeys(payload,['expected_revision','mood','image']) ||
            !Number.isSafeInteger(payload.expected_revision) || payload.expected_revision<0 ||
            !EXPRESSION_MOODS.includes(payload.mood)) throw fail('表情と現在のrevisionを指定してください');
        const record=await readRecord();
        if (record.revision!==payload.expected_revision || record.revision>=Number.MAX_SAFE_INTEGER) {
          throw fail('表情イラストが別の操作で更新されています。再取得してから保存してください',409);
        }
        record.moods[payload.mood]=payload.image===null?null:validateArtworkImage('base',payload.image);
        record.revision++;
        await writeRecord(record);
        return metadata(record);
      };
      const result=(queues.get(file)??Promise.resolve()).then(task);
      const tail=result.catch(()=>{});
      queues.set(file,tail);
      tail.then(()=>{if (queues.get(file)===tail) queues.delete(file);});
      return result;
    },
  };
}
