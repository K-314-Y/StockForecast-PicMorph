import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {validateLabModel,validateLabRevisions} from './model-lab.mjs';

const PROTOCOL=JSON.parse(await readFile(new URL('./accessory-registration-protocol-v1.json',import.meta.url),'utf8'));
const HELPER=fileURLToPath(new URL('../mcp/accessory_registration_store.py',import.meta.url));
const ROOT=new URL('../',import.meta.url);
const PREVIEW_AGE=5*60*1000;
const DAY=86400000;
const HEX=/^[a-f0-9]{64}$/;
const fail=(status,message)=>Object.assign(Error(message),{status});
const stale=()=>fail(409,'プレビューが期限切れか、設定・実行コードが変わりました。再読込して確認してください。');
const unavailable=()=>fail(503,'ローカルの固定記録を安全に読み書きできませんでした。');

export function canonicalPreview(value) {
  if(value===null || typeof value==='boolean' || typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number' && Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalPreview).join(',')+']';
  if(value && Object.getPrototypeOf(value)===Object.prototype) {
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalPreview(value[key])).join(',')+'}';
  }
  throw unavailable();
}

export function registrationDays(timestamp) {
  const shifted=timestamp+9*3600000;
  return {registered_jst_day:new Date(shifted).toISOString().slice(0,10),
    earliest_possible_day:new Date(shifted+DAY).toISOString().slice(0,10)};
}

export async function readRegistrationFingerprints() {
  return Object.fromEntries(await Promise.all(PROTOCOL.source_files.map(async name=>{
    const file=await open(new URL(name,ROOT),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const before=await file.stat();
      if(!before.isFile() || before.size<1 || before.size>256*1024)throw unavailable();
      // One extra byte catches a concurrent append without an unbounded read.
      const buffer=Buffer.alloc(before.size+1);
      let length=0;
      while(length<buffer.length) {
        const {bytesRead}=await file.read(buffer,length,buffer.length-length,length);
        if(!bytesRead)break;
        length+=bytesRead;
      }
      const after=await file.stat();
      if(length!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)
        throw unavailable();
      return [name,createHash('sha256').update(buffer.subarray(0,length)).digest('hex')];
    } finally {await file.close();}
  })));
}

export function registrationContent({timestamp,context,revisions,original,baseline,analysis,fingerprints}) {
  if(!fingerprints || Object.keys(fingerprints).length!==PROTOCOL.source_files.length ||
     !PROTOCOL.source_files.every(name=>typeof fingerprints[name]==='string' && fingerprints[name].length===64 && HEX.test(fingerprints[name])))
    throw unavailable();
  return {schema:1,...registrationDays(timestamp),context,source_revisions:validateLabRevisions(revisions),
    base_model:validateLabModel(original.base_model),baseline:validateLabModel(baseline),candidate:validateLabModel(analysis.candidate),
    applied_rules:analysis.applied,visible_kinds:analysis.visibleKinds,source_sha256:fingerprints,protocol:PROTOCOL,
    timestamp_basis:'local_system_clock',status:'pending_no_verified_data'};
}

export function createRegistrationReview() {
  const key=randomBytes(32);
  const sign=(content,issued)=>createHmac('sha256',key).update(canonicalPreview({content,issued})).digest();
  return {
    issue(content,now) {
      if(content.registered_jst_day!==registrationDays(now).registered_jst_day)throw stale();
      const preview_token=now+'.'+sign(content,now).toString('hex');
      // The hashes bind review to the actual code but need not be shown to the browser.
      const {source_sha256,...review}=content;
      return {preview_token,valid_for_seconds:PREVIEW_AGE/1000,review};
    },
    check(token,content,now) {
      const match=typeof token==='string' && /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
      if(!match || match[0]!==token)throw fail(400,'有効なプレビューを指定してください。');
      const issued=Number(match[1]);
      if(now<issued || now-issued>=PREVIEW_AGE ||
         registrationDays(issued).registered_jst_day!==content.registered_jst_day ||
         registrationDays(now).registered_jst_day!==content.registered_jst_day ||
         !timingSafeEqual(sign(content,issued),Buffer.from(match[2],'hex')))throw stale();
      return issued+PREVIEW_AGE;
    },
  };
}

export function registrationResponse(value,list) {
  function metadata(row) {
    const fields=['id','created_at','registered_jst_day','earliest_possible_day','status','timestamp_basis'];
    if(!row || Object.keys(row).length!==fields.length || !fields.every(key=>Object.hasOwn(row,key)) ||
       typeof row.id!=='string' || row.id.length!==64 || !HEX.test(row.id) || row.status!=='pending_no_verified_data' ||
       row.timestamp_basis!=='local_system_clock' || typeof row.created_at!=='string')throw unavailable();
    const time=Date.parse(row.created_at);
    if(!Number.isFinite(time) || new Date(time).toISOString()!==row.created_at ||
       Object.entries(registrationDays(time)).some(([key,day])=>row[key]!==day))throw unavailable();
    return row;
  }
  if(list) {
    if(!Array.isArray(value?.registrations) || value.registrations.length>50)throw unavailable();
    return {registrations:value.registrations.map(metadata)};
  }
  return {registration:metadata(value?.registration)};
}

export function createAccessoryRegistrationStore({script=HELPER}={}) {
  function call(operation,input,signal) {
    if(process.platform!=='linux')return Promise.reject(unavailable());
    return new Promise((resolve,reject)=>{
      const child=execFile('python3',['-B','-E',script,operation],{
        env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'},signal,
        timeout:6000,maxBuffer:32*1024,killSignal:'SIGKILL',
      },(error,stdout)=>{
        if(error)return reject(unavailable());
        try {
          const response=JSON.parse(stdout);
          if(response.code==='duplicate')return reject(fail(409,'同じ内容は本日すでに固定されています。記録一覧で確認してください。'));
          if(response.code==='stale')return reject(stale());
          if(response.code==='full')return reject(fail(409,'固定記録が上限の50件に達しました。'));
          if(!response.result)throw unavailable();
          resolve(response.result);
        } catch {reject(unavailable());}
      });
      child.stdin.on('error',()=>child.kill('SIGKILL'));
      child.stdin.end(JSON.stringify(input)+'\n');
    });
  }
  return {list:signal=>call('list',{},signal),save:(content,expires_at_ms,signal)=>call('save',{content,expires_at_ms},signal)};
}
