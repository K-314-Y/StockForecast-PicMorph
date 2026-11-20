/** Read-only view of the Linux MCP procedural character store. */
import {constants} from 'node:fs';
import {lstat,open,opendir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateImageStructure} from './image-validation.mjs';

export const CHARACTER_DEMOS_API='/api/character-demos';
const DEFAULT_ROOT=fileURLToPath(new URL('../local_state/character_parts',import.meta.url));
const ENGINE='original-template';
const MODEL='creature-lab-chibi-v1';
const PROVENANCE='Drawn from project-authored geometric primitives using Python Pillow.';
const ID=/^cp_[0-9a-f]{32}$/;
const MOODS=['body','ready','happy','cautious'];
const MAX_ENTRIES=32;
const MAX_SCANNED=MAX_ENTRIES*5;
const MAX_JSON=4096;
const MAX_PNG=512*1024;
// POSIX ownership checks remain mandatory on Linux. Windows has no geteuid;
// its independent viewer cannot open the Linux-only protected catalog/store.
const OWNER=typeof process.geteuid==='function' ? process.geteuid() : null;
const READ=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
const LAYOUT={frames:6,columns:6,rows:1,cell_width:192,cell_height:208};

const isId=id=>id.length===35 && ID.test(id);
const sameFile=(left,right)=>left.dev===right.dev && left.ino===right.ino;
const privateMode=(info,mode)=>info.uid===OWNER && (info.mode&0o7777)===mode;
const validDirectory=info=>info.isDirectory() && privateMode(info,0o700);
const validFile=(info,max)=>info.isFile() && privateMode(info,0o600) &&
  info.nlink===1 && info.size>0 && info.size<=max;

function requireValid(ok) {
  if(!ok) throw Error('Invalid local character demo');
}

// Linux procfs anchors all child paths to opened directories, even if a parent
// name is replaced while requests are in flight. Each child open rejects links.
const at=(directory,name)=>`/proc/self/fd/${directory.fd}/${name}`;
async function withDirectory(path,check,read) {
  const before=await lstat(path);
  requireValid(check(before));
  const directory=await open(path,READ|constants.O_DIRECTORY);
  try {
    const actual=await directory.stat();
    requireValid(check(actual) && sameFile(before,actual));
    const result=await read(directory);
    const after=await lstat(path);
    requireValid(check(after) && sameFile(actual,after));
    return result;
  } finally {
    await directory.close();
  }
}

async function boundedFile(directory,name,max,expectedSize) {
  const path=at(directory,name);
  const before=await lstat(path);
  requireValid(validFile(before,max) && (expectedSize===undefined || before.size===expectedSize));
  const file=await open(path,READ);
  try {
    const actual=await file.stat();
    requireValid(validFile(actual,max) && sameFile(before,actual) && before.size===actual.size);
    const buffer=Buffer.alloc(actual.size+1);
    let total=0;
    while(total<buffer.length) {
      const {bytesRead}=await file.read(buffer,total,buffer.length-total,total);
      if(!bytesRead) break;
      total+=bytesRead;
    }
    const after=await lstat(path);
    requireValid(total===actual.size && validFile(after,max) && sameFile(actual,after) &&
      actual.size===after.size && actual.mtimeMs===after.mtimeMs && actual.ctimeMs===after.ctimeMs);
    return buffer.subarray(0,total);
  } finally {
    await file.close();
  }
}

async function readEntry(folder,id) {
  const demo=JSON.parse(await boundedFile(folder,'demo.json',MAX_JSON));
  const manifest=JSON.parse(await boundedFile(folder,'manifest.json',MAX_JSON));
  const {name}=demo;
  requireValid(typeof name==='string' && name.length<=16 && name.trim() &&
    !/\p{Cc}/u.test(name) && demo.visibility==='local_only' &&
    demo.generated_id===id && demo.engine===ENGINE && demo.model===MODEL &&
    demo.browser_auto_link===false &&
    manifest.schema_version===1 && manifest.generated_id===id && manifest.name===name &&
    manifest.engine===ENGINE && manifest.model===MODEL && manifest.source_provenance===PROVENANCE &&
    Object.entries(LAYOUT).every(([key,value])=>manifest.layout?.[key]===value));
  for(const part of MOODS) {
    const info=manifest.files?.[`character_${part}_6frames.png`];
    requireValid(info && Number.isInteger(info.bytes) && info.bytes>0 && info.bytes<=MAX_PNG &&
      typeof info.sha256==='string' && info.sha256.length===64 && /^[0-9a-f]+$/.test(info.sha256) &&
      info.width===1152 && info.height===208 && info.frames===6);
  }
  return {metadata:{generated_id:id,name,engine:ENGINE,model:MODEL},files:manifest.files};
}

async function readPart(folder,files,part) {
  const filename=`character_${part}_6frames.png`;
  const {bytes,sha256}=files[filename];
  const buffer=await boundedFile(folder,filename,MAX_PNG,bytes);
  requireValid(createHash('sha256').update(buffer).digest('hex')===sha256 &&
    buffer.length>=33 && buffer.readUInt32BE(16)===1152 &&
    buffer.readUInt32BE(20)===208 && buffer[24]===8 && buffer[25]===6 &&
    validateImageStructure(buffer,'image/png'));
  return buffer;
}

async function verifyParts(folder,files,selected) {
  let image;
  for(const part of MOODS) {
    const bytes=await readPart(folder,files,part);
    if(part===selected) image=bytes;
  }
  return image;
}

export function createCharacterDemoCatalog(catalogRoot=DEFAULT_ROOT) {
  const root=resolve(catalogRoot);
  const withRoot=read=>withDirectory(dirname(root),info=>info.isDirectory() && info.uid===OWNER,parent=>
    withDirectory(at(parent,basename(root)),validDirectory,read));
  const withEntry=(directory,id,read)=>withDirectory(at(directory,id),validDirectory,read);
  let pendingList;

  async function readList() {
    try {
      return await withRoot(async directory=>{
        const demos=[];
        const entries=await opendir(at(directory,'.'));
        let scanned=0,candidates=0;
        for await(const entry of entries) {
          // Allow 128 unrelated entries alongside the generator's 32 IDs.
          if(++scanned>MAX_SCANNED) break;
          if(!isId(entry.name)) continue;
          if(++candidates>MAX_ENTRIES) break;
          try {
            const metadata=await withEntry(directory,entry.name,async folder=>{
              const item=await readEntry(folder,entry.name);
              await verifyParts(folder,item.files);
              return item.metadata;
            });
            demos.push(metadata);
          } catch {
            // An invalid or concurrently removed entry does not hide other demos.
          }
        }
        return demos.sort((a,b)=>a.name.localeCompare(b.name) ||
          a.generated_id.localeCompare(b.generated_id));
      });
    } catch {
      return [];
    }
  }

  return {
    list() {
      pendingList ??= readList().finally(()=>{pendingList=undefined;});
      return pendingList;
    },
    async image(id,part) {
      if(!isId(id) || !MOODS.includes(part)) return null;
      try {
        return await withRoot(directory=>withEntry(directory,id,async folder=>{
          const {files}=await readEntry(folder,id);
          return verifyParts(folder,files,part);
        }));
      } catch {
        return null;
      }
    },
  };
}
