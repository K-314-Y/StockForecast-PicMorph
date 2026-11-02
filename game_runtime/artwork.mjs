/** User-authored source images only: no cutout, conversion, model or XP writes. */
import {readFile,mkdir,open,rename,unlink,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export const ARTWORK_FILE=fileURLToPath(new URL('../local_state/node_game/artwork.json',import.meta.url));
export const ARTWORK_SLOTS=Object.freeze(['base','hair','face','outfit']);
export const MAX_ARTWORK_FILE=450*1024;
export const MAX_ARTWORK_TOTAL=2*1024*1024;
const MAX_ENCODED=4*Math.ceil(MAX_ARTWORK_FILE/3);
const MAX_RECORD=4*MAX_ENCODED+4096;
const queues=new Map();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const keys=value=>Object.keys(value).sort().join('|');
const emptySlots=()=>Object.fromEntries(ARTWORK_SLOTS.map(slot=>[slot,null]));

export function validateArtworkImage(slot,image) {
  if(!ARTWORK_SLOTS.includes(slot)) throw fail('未対応の画像スロットです');
  if(!object(image) || keys(image)!=='base64|mime') throw fail('画像のMIMEとbase64を指定してください');
  const mimes=slot==='base'?['image/png','image/jpeg','image/webp']:['image/png','image/webp'];
  if(!mimes.includes(image.mime)) throw fail('完成イラストはPNG/JPEG/WebP、レイヤーはPNG/WebPのみです',415);
  const encoded=image.base64;
  if(typeof encoded!=='string' || encoded.length===0) throw fail('画像のbase64が不正です');
  if(encoded.length>MAX_ENCODED) throw fail('画像は1枚450KBまでです',413);
  // Buffer.from alone accepts whitespace, URL-safe spelling and truncated padding.
  if(encoded.length%4!==0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw fail('画像のbase64が不正です');
  }
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length>MAX_ARTWORK_FILE) throw fail('画像は1枚450KBまでです',413);
  if(bytes.toString('base64')!==encoded) throw fail('画像のbase64が不正です');
  const png=bytes.length>=33 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    bytes.readUInt32BE(8)===13 && bytes.toString('ascii',12,16)==='IHDR' &&
    bytes.readUInt32BE(16)>0 && bytes.readUInt32BE(20)>0;
  const jpeg=bytes.length>=4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 &&
    bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217;
  const webp=bytes.length>=20 && bytes.toString('ascii',0,4)==='RIFF' &&
    bytes.readUInt32LE(4)===bytes.length-8 && bytes.toString('ascii',8,12)==='WEBP' &&
    ['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16));
  if(!(image.mime==='image/png'?png:image.mime==='image/jpeg'?jpeg:webp)) {
    throw fail('画像のMIMEとファイルシグネチャが一致しません',415);
  }
  return {mime:image.mime,base64:encoded,size:bytes.length};
}

function metadata(record,created=true) {
  return {revision:record.revision,created,slots:Object.fromEntries(ARTWORK_SLOTS.map(slot=>{
    const image=record.slots[slot];
    return [slot,{exists:image!==null,mime:image?.mime??null,size:image?.size??0}];
  }))};
}

export function createArtworkStore({file=ARTWORK_FILE}={}) {
  file=resolve(file);
  async function readRecord() {
    try {
      const info=await lstat(file);
      if(!info.isFile() || info.isSymbolicLink() || info.size>MAX_RECORD) throw Error('invalid file');
      const record=JSON.parse(await readFile(file,'utf8'));
      if(!object(record) || keys(record)!=='revision|schema|slots' || record.schema!==1 ||
          !Number.isSafeInteger(record.revision) || record.revision<1 ||
          !object(record.slots) || keys(record.slots)!=='base|face|hair|outfit') throw Error('invalid record');
      let total=0;
      for(const slot of ARTWORK_SLOTS) {
        const image=record.slots[slot];
        if(image===null) continue;
        if(!object(image) || keys(image)!=='base64|mime|size') throw Error('invalid image');
        const validated=validateArtworkImage(slot,{mime:image.mime,base64:image.base64});
        if(image.size!==validated.size) throw Error('invalid size');
        total+=validated.size;
      }
      if(total>MAX_ARTWORK_TOTAL) throw Error('invalid total');
      return {record,created:true};
    } catch(error) {
      if(error.code==='ENOENT') return {record:{schema:1,revision:0,slots:emptySlots()},created:false};
      throw fail('保存したイラストを読み込めません。保存ファイルを確認してください',503);
    }
  }
  async function write(record) {
    const dir=dirname(file);
    await mkdir(dir,{recursive:true,mode:0o700});
    const info=await lstat(dir);
    if(!info.isDirectory() || info.isSymbolicLink()) throw fail('イラストの保存先が不正です',503);
    const tmp=join(dir,'.artwork-'+randomUUID());
    let handle;
    try {
      handle=await open(tmp,'wx',0o600);
      await handle.writeFile(JSON.stringify(record)+'\n');
      await handle.sync();
      await handle.close();handle=null;
      await rename(tmp,file);
      const folder=await open(dir,'r');
      try {await folder.sync();} finally {await folder.close();}
    } finally {
      if(handle) await handle.close();
      await unlink(tmp).catch(error=>{if(error.code!=='ENOENT') throw error;});
    }
  }
  return {
    async read() {
      const {record,created}=await readRecord();
      return metadata(record,created);
    },
    async image(slot) {
      if(!ARTWORK_SLOTS.includes(slot)) throw fail('画像が見つかりません',404);
      const {record}=await readRecord();
      const image=record.slots[slot];
      if(!image) throw fail('画像が見つかりません',404);
      return {mime:image.mime,bytes:Buffer.from(image.base64,'base64')};
    },
    save(payload) {
      const task=async()=>{
        if(!object(payload) || keys(payload)!=='expected_revision|image|slot' ||
            !Number.isSafeInteger(payload.expected_revision) || payload.expected_revision<0 ||
            !ARTWORK_SLOTS.includes(payload.slot)) throw fail('スロットと現在のrevisionを指定してください');
        const image=payload.image===null?null:validateArtworkImage(payload.slot,payload.image);
        const {record}=await readRecord();
        if(record.revision!==payload.expected_revision || record.revision>=Number.MAX_SAFE_INTEGER) {
          throw fail('イラストが別の操作で更新されています。再取得してから保存してください',409);
        }
        record.slots[payload.slot]=image;
        const total=Object.values(record.slots).reduce((sum,item)=>sum+(item?.size??0),0);
        if(total>MAX_ARTWORK_TOTAL) throw fail('画像は合計2MBまでです',413);
        record.revision++;
        await write(record);
        return metadata(record);
      };
      const result=(queues.get(file)??Promise.resolve()).then(task);
      const tail=result.catch(()=>{});
      queues.set(file,tail);
      tail.then(()=>{if(queues.get(file)===tail) queues.delete(file);});
      return result;
    },
  };
}
