/** The selected procedural visual, independent of saved artwork and game progress. */
import {constants} from 'node:fs';
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_FILE=fileURLToPath(new URL('../local_state/node_game/active-character.json',import.meta.url));
// POSIX ownership checks remain mandatory on Linux. Windows has no geteuid;
// its independent viewer cannot open the Linux-only protected catalog/store.
const OWNER=typeof process.geteuid==='function' ? process.geteuid() : null;
const READ=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
const MAX_BYTES=1024;
const queues=new Map();
const empty={schema:1,revision:0,active_demo_id:null};
const fail=(message,status)=>Object.assign(Error(message),{status});
const storeError=()=>fail('登録キャラの外見設定を読み書きできません',503);
const stale=()=>fail('外見設定が別の操作で更新されました。再取得してください',409);
const fields=value=>value && typeof value==='object' && !Array.isArray(value) ?
  Object.keys(value).sort().join('|') : '';
const validId=id=>id===null || (typeof id==='string' && id.length===35 && /^cp_[a-f0-9]{32}$/.test(id));
const revision=value=>Number.isSafeInteger(value) && value>=0;
const at=(dir,name)=>`/proc/self/fd/${dir.fd}/${name}`;
const validFile=info=>info.isFile() && info.uid===OWNER && (info.mode&0o7777)===0o600 &&
  info.nlink===1 && info.size>0 && info.size<=MAX_BYTES;
const unchanged=(a,b)=>a.dev===b.dev && a.ino===b.ino && a.size===b.size &&
  a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs;

async function statOrMissing(path) {
  try {return await lstat(path);}
  catch(error) {
    if(error.code==='ENOENT') return null;
    throw error;
  }
}

// Keep each path component pinned and reject symlinks, including local_state.
async function openDirectory(path,create) {
  if(path==='/') return open(path,READ|constants.O_DIRECTORY);
  const parent=await openDirectory(dirname(path),create);
  try {
    const child=at(parent,basename(path));
    if(create && !(await statOrMissing(child))) {
      const info=await parent.stat();
      if(info.uid!==OWNER || (info.mode&0o022)!==0) throw storeError();
      try {
        await mkdir(child,{mode:0o700});
      } catch(error) {
        if(error.code!=='EEXIST') throw error;
      }
      await parent.sync();
    }
    return await open(child,READ|constants.O_DIRECTORY);
  } finally {await parent.close();}
}

async function inStoreDirectory(file,create,action) {
  let dir;
  try {dir=await openDirectory(dirname(file),create);}
  catch(error) {
    if(!create && error.code==='ENOENT') return {...empty};
    throw storeError();
  }
  try {
    const info=await dir.stat();
    if(info.uid!==OWNER || (info.mode&0o022)!==0) throw storeError();
    return await action(dir,at(dir,basename(file)));
  } finally {await dir.close();}
}

async function readRecord(path) {
  const before=await statOrMissing(path);
  if(!before) return {record:{...empty},info:null};
  if(!validFile(before)) throw storeError();
  const handle=await open(path,READ);
  try {
    const info=await handle.stat();
    if(!validFile(info) || !unchanged(before,info)) throw storeError();
    const bytes=Buffer.alloc(info.size+1);
    let total=0;
    while(total<bytes.length) {
      const {bytesRead}=await handle.read(bytes,total,bytes.length-total,total);
      if(!bytesRead) break;
      total+=bytesRead;
    }
    const after=await lstat(path);
    if(total!==info.size || !validFile(after) || !unchanged(info,after)) throw storeError();
    const record=JSON.parse(bytes.toString('utf8',0,total));
    if(fields(record)!=='active_demo_id|revision|schema' || record.schema!==1 ||
       !revision(record.revision) || record.revision===0 || !validId(record.active_demo_id)) throw storeError();
    return {record,info};
  } finally {await handle.close();}
}

async function writeRecord(dir,path,record,previous) {
  const temporary=at(dir,'.active-character-'+randomUUID());
  const handle=await open(temporary,'wx',0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(record)+'\n');
      await handle.sync();
    } finally {await handle.close();}
    const current=await statOrMissing(path);
    if(current && !validFile(current)) throw storeError();
    if(previous ? !current || !unchanged(previous,current) : current!==null) throw stale();
    await rename(temporary,path);
    await dir.sync();
  } finally {
    await unlink(temporary).catch(error=>{if(error.code!=='ENOENT') throw error;});
  }
}

export function createActiveCharacterStore({file=DEFAULT_FILE}={}) {
  file=resolve(file);
  async function read() {
    try {return await inStoreDirectory(file,false,async(_dir,path)=>(await readRecord(path)).record);}
    catch {throw storeError();}
  }
  return {
    read,
    save(payload,isRegistered) {
      const task=async()=>{
        if(fields(payload)!=='active_demo_id|expected_revision' ||
           !revision(payload.expected_revision) || !validId(payload.active_demo_id)) {
          throw fail('有効なキャラIDまたはnullと現在のrevisionを指定してください',400);
        }
        const {active_demo_id,expected_revision}=payload;
        // Validate before creating a directory for a new selection.
        const current=await read();
        if(current.revision!==expected_revision || current.revision>=Number.MAX_SAFE_INTEGER) throw stale();
        if(active_demo_id!==null && !(await isRegistered(active_demo_id))) {
          throw fail('利用できる登録済みキャラが見つかりません',404);
        }
        try {
          return await inStoreDirectory(file,true,async(dir,path)=>{
            const {record,info}=await readRecord(path);
            if(record.revision!==expected_revision) throw stale();
            const next={schema:1,revision:record.revision+1,active_demo_id};
            await writeRecord(dir,path,next,info);
            return next;
          });
        } catch(error) {
          if(error.status===409) throw error;
          throw storeError();
        }
      };
      const result=(queues.get(file)??Promise.resolve()).then(task);
      const tail=result.catch(()=>{});
      queues.set(file,tail);
      tail.then(()=>{if(queues.get(file)===tail) queues.delete(file);});
      return result;
    },
  };
}
