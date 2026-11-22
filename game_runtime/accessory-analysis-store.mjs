import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateAnalysisPolicies} from './accessory-analysis.mjs';

export const ACCESSORY_ANALYSIS_API='/api/accessory-analysis/v1';
export const MAX_ANALYSIS_REQUEST=8192;
const HELPER=fileURLToPath(new URL('../mcp/accessory_analysis_store.py',import.meta.url));
const fail=(message,status)=>Object.assign(Error(message),{status});
const keys=value=>value && typeof value==='object' && !Array.isArray(value)?Object.keys(value).sort().join('|'):'';
const revision=n=>Number.isSafeInteger(n)&&n>=0;

export function validateAnalysisSave(input) {
  if(keys(input)!=='expected_revision|policies' || !revision(input.expected_revision)) {
    throw fail('分析設定と現在のrevisionを指定してください',400);
  }
  return {expected_revision:input.expected_revision,policies:validateAnalysisPolicies(input.policies)};
}

export function analysisRecord(value) {
  try {
    if(keys(value)!=='policies|revision|schema' || value.schema!==1 || !revision(value.revision) ||
       (value.revision===0 && value.policies?.length!==0) ||
       !value.policies.every(row=>keys(row)==='focus|intensity|kind_id'))throw Error('Invalid analysis record');
    return {...value,policies:validateAnalysisPolicies(value.policies)};
  } catch {throw fail('保存済みの分析設定を確認できません',503);}
}

export function createAccessoryAnalysisStore({script=HELPER}={}) {
  function call(operation,input,signal) {
    if(process.platform!=='linux')return Promise.reject(fail('分析設定はLinuxで利用できます',404));
    return new Promise((resolve,reject)=>{
      let outcome;
      const child=execFile('python3',['-B','-E',script,operation],{
        env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'},
        signal,timeout:6000,maxBuffer:MAX_ANALYSIS_REQUEST,killSignal:'SIGKILL',
      },(error,stdout)=>{outcome={error,stdout};});
      child.once('close',()=>{
        try {
          if(!outcome || outcome.error)throw Error('Analysis helper failed');
          const response=JSON.parse(outcome.stdout);
          if(response.code==='conflict')return reject(fail('分析設定が別の操作で更新されました',409));
          resolve(analysisRecord(response.result));
        }catch{reject(fail('分析設定を安全に読み書きできませんでした',503));}
      });
      child.stdin.on('error',()=>child.kill('SIGKILL'));
      child.stdin.end(JSON.stringify(input)+'\n');
    });
  }
  return {read:signal=>call('read',{},signal),save:input=>call('save',validateAnalysisSave(input))};
}
