/* Safe in-browser ZIP import for Creature Lab PNG/WebP frame atlases.
 * No extraction to disk, no persistence, no archive files are uploaded. */
import {normalizeEquipment} from './accessory-options.mjs';

const MAX_ZIP_BYTES=12*1024*1024;
const MAX_IMAGE_BYTES=5*1024*1024;
const MAX_ENTRIES=48;
const TOTAL_UNCOMPRESSED=20*1024*1024;
const MAX_MANIFEST_BYTES=16*1024;
const ZIP_END=0x06054b50, ZIP_CENTRAL=0x02014b50, ZIP_LOCAL=0x04034b50;

function invalid(message='ZIP形式が正しくありません。'){return new Error(message);}
function crc32(buffer){
  let value=0xffffffff;
  for(const byte of buffer){
    value^=byte;
    for(let i=0;i<8;i++)value=(value>>>1)^(value&1?0xedb88320:0);
  }
  return (value^0xffffffff)>>>0;
}
function parseAppearanceManifest(buffer) {
  let manifest;
  try {manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));}
  catch {throw invalid('ZIP内のmanifest.jsonを読み取れません。');}
  if(!manifest || typeof manifest!=='object' || Array.isArray(manifest))
    throw invalid('ZIP内の外見情報が不正です。');
  const input=manifest.appearance;
  if(input==null)return null;
  if(typeof input!=='object'||Array.isArray(input))throw invalid('ZIP内の外見情報が不正です。');
  const enums={hair_style:['bob','long','twintails'],
    expression:['cheerful','calm','determined'],
    accessory:['ribbon','glasses','star','none']};
  const appearance={};
  if(typeof input.name==='string' && input.name.trim() && [...input.name.trim()].length<=16 &&
     !/[\u0000-\u001f\u007f-\u009f]/u.test(input.name))appearance.name=input.name.trim();
  for(const [field,allowed] of Object.entries(enums)) {
    if(Object.hasOwn(input,field)) {
      if(!allowed.includes(input[field]))throw invalid('ZIPの外見情報に未対応の'+field+'があります。');
      appearance[field]=input[field];
    }
  }
  if(Object.hasOwn(input,'accessories')) {
    if(Object.hasOwn(input,'accessory'))throw invalid('ZIPの単体設定と複数装備を同時に指定できません。');
    try {appearance.accessories=normalizeEquipment(input.accessories);}
    catch(error){throw invalid('ZIPの装備情報：'+error.message);}
  }
  for(const field of ['hair_color','clothing_color']) {
    if(Object.hasOwn(input,field)) {
      if(typeof input[field]!=='string'||!/^#[0-9a-f]{6}$/i.test(input[field]))
        throw invalid('ZIPの'+field+'は #rrggbb 形式にしてください。');
      appearance[field]=input[field].toLowerCase();
    }
  }
  return appearance;
}
function partsKey(name){
  const m=/(?:^|[_-])(body|ready|happy|cautious)(?:[_-]6frames)?\.(webp|png)$/i.exec(name);
  if(!m)return null;
  return {key:m[1].toLowerCase(),ext:m[2].toLowerCase()};
}
async function deflateRawBounded(compressed,maxSize){
  if(typeof DecompressionStream!=='function')throw invalid('このブラウザはZIP展開に対応していません。');
  const stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader=stream.getReader();let bytes=0;const chunks=[];
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.length;
      if(bytes>maxSize)throw invalid('画像が大きすぎます。');
      chunks.push(value);
    }
  }finally{await reader.cancel().catch(()=>{});}
  const result=new Uint8Array(bytes);let offset=0;
  for(const part of chunks){result.set(part,offset);offset+=part.length;}
  return result;
}
export async function extractCharacterZip(file){
  if(!file || file.size<22 || file.size>MAX_ZIP_BYTES)throw invalid('ZIPファイルは12MB以下にしてください。');
  const raw=new Uint8Array(await file.arrayBuffer());
  const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  const u16=at=>view.getUint16(at,true),u32=at=>view.getUint32(at,true);
  let end=-1;
  // ZIP EOCD lives within the last 65557 bytes.
  for(let i=raw.length-22;i>=Math.max(0,raw.length-65557);i--){
    if(u32(i)===ZIP_END && i+22+u16(i+20)===raw.length){end=i;break;}
  }
  if(end<0)throw invalid();
  if(u16(end+4)!==0 || u16(end+6)!==0 || u16(end+8)!==u16(end+10))
    throw invalid('分割ZIPには対応していません。');
  const count=u16(end+10),offset=u32(end+16),size=u32(end+12);
  if(!count||count>MAX_ENTRIES||size===0xffffffff||offset===0xffffffff||offset+size>end)
    throw invalid('ZIPの構造または件数が不正です。');
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const entries={};
  let metadataEntry=null;
  let at=offset,total=0;
  for(let i=0;i<count;i++){
    if(at+46>offset+size||u32(at)!==ZIP_CENTRAL)throw invalid();
    const flags=u16(at+8),method=u16(at+10),checksum=u32(at+16),
      compressedSize=u32(at+20),unpackedSize=u32(at+24),
      nameSize=u16(at+28),extra=u16(at+30),comment=u16(at+32),
      disk=u16(at+34),localAt=u32(at+42);
    const next=at+46+nameSize+extra+comment;
    if(next>offset+size || !nameSize || nameSize>220 || disk ||
       [compressedSize,unpackedSize,localAt].includes(0xffffffff))throw invalid();
    let name;
    try{name=decoder.decode(raw.subarray(at+46,at+46+nameSize));}
    catch{throw invalid('ファイル名を読み取れません。');}
    at=next;
    // No folder traversal, absolute paths, NULs, or platform paths.
    if(name.includes('/')||name.includes('\\')||name.includes('\0')||
      name.startsWith('.')||name.includes('..')||name.includes(':'))throw invalid('ZIP内に安全でないファイル名があります。');
    const match=partsKey(name);
    const isManifest=name==='manifest.json';
    if(!match&&!isManifest)continue; // Ignore other assets including preview GIF.
    if(match && entries[match.key])throw invalid('同じ種類の画像が複数あります。');
    if(isManifest && metadataEntry)throw invalid('manifest.jsonが複数あります。');
    if((flags&1)||![0,8].includes(method)||compressedSize>MAX_ZIP_BYTES||
        !unpackedSize || unpackedSize>(isManifest?MAX_MANIFEST_BYTES:MAX_IMAGE_BYTES) ||
        localAt+30>offset ||u32(localAt)!==ZIP_LOCAL)
      throw invalid('ZIPの画像または外見情報が暗号化・大きすぎる・破損しています。');
    const dataAt=localAt+30+u16(localAt+26)+u16(localAt+28);
    if(dataAt+compressedSize>offset)throw invalid('ZIP画像データの範囲が不正です。');
    total+=unpackedSize;
    if(total>TOTAL_UNCOMPRESSED)throw invalid('ZIPの展開サイズが大きすぎます。');
    const entry={dataAt,compressedSize,unpackedSize,method,checksum,ext:match?.ext};
    if(isManifest)metadataEntry=entry;
    else entries[match.key]=entry;
  }
  if(at!==offset+size || !entries.body || !entries.ready)
    throw invalid('ZIPにbodyとreadyの画像が必要です。');
  const extracted={};
  for(const [kind,item] of Object.entries(entries)){
    const chunk=raw.subarray(item.dataAt,item.dataAt+item.compressedSize);
    let out;
    try{out=item.method===0 ? chunk.slice() : await deflateRawBounded(chunk,item.unpackedSize);}
    catch{throw invalid(kind+'のZIP展開に失敗しました。');}
    if(out.length!==item.unpackedSize || crc32(out)!==item.checksum)
      throw invalid(kind+'の画像データが破損しています。');
    const mime=item.ext==='png'?'image/png':'image/webp';
    extracted[kind]=new File([out],kind+'.'+item.ext,{type:mime});
  }
  if(metadataEntry) {
    const item=metadataEntry;
    const chunk=raw.subarray(item.dataAt,item.dataAt+item.compressedSize);
    let out;
    try{out=item.method===0 ? chunk.slice() : await deflateRawBounded(chunk,item.unpackedSize);}
    catch{throw invalid('manifest.jsonの展開に失敗しました。');}
    if(out.length!==item.unpackedSize||crc32(out)!==item.checksum)
      throw invalid('manifest.jsonの内容が破損しています。');
    // The supplied ZIP manifest is metadata, not visual image recognition.
    Object.defineProperty(extracted,'appearance',{
      value:parseAppearanceManifest(out),enumerable:false,
    });
  }
  return extracted;
}
