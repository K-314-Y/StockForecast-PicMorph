import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HELPER=fileURLToPath(new URL('../mcp/accessory_evaluation_readiness.py',import.meta.url));
const HEX=/^[a-f0-9]{64}$/;
const COUNTS={codes:10,history_sessions:24,evaluation_sessions:12,rows:360};
const FLAGS=['score_allowed','holdout_evaluated','calendar_verified','source_verified','rights_verified',
  'point_in_time_verified','adjustments_verified','timestamps_verified'];
const REASONS=new Map([
  ['pending_input',['input_missing']],['pending_code_mismatch',['code_mismatch']],
  ['pending_invalid_input',['unsafe_input','manifest_shape','registration_binding','source_evidence','calendar_structure','row_alignment','timestamp_structure']],
  ['pending_evidence_review',['evidence_unreviewed']],
]);
const fail=(status,message)=>Object.assign(Error(message),{status});
const unavailable=()=>fail(503,'固定記録または入力を安全に確認できませんでした。');

export function parseEvaluationReadinessRequest(raw) {
  // JSON.parse alone discards duplicate keys. This route has one string member.
  if(!/^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}\s*$/.test(raw))throw fail(400,'固定記録のIDだけを指定してください。');
  return JSON.parse(raw);
}

export function validateEvaluationReadinessRequest(input) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==1 ||
     !Object.hasOwn(input,'registration_id') || typeof input.registration_id!=='string' ||
     input.registration_id.length!==64 || !HEX.test(input.registration_id))throw fail(400,'固定記録のIDだけを指定してください。');
  return input.registration_id;
}

function validDay(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const moment=Date.parse(value);
  return Number.isFinite(moment) && new Date(moment).toISOString().slice(0,10)===value;
}

export function evaluationReadinessResponse(value) {
  const validCounts=counts=>counts && Object.entries(COUNTS).every(([key,count])=>counts[key]===count);
  if(!REASONS.get(value?.status)?.includes(value.reason) || !validCounts(value.expected) ||
     !FLAGS.every(flag=>value[flag]===false) || !validDay(value.registered_jst_day) || !validDay(value.earliest_possible_day) ||
     Date.parse(value.earliest_possible_day)-Date.parse(value.registered_jst_day)!==86400000)throw unavailable();
  let actual=null;
  if(value.status==='pending_evidence_review') {
    const observed=value.actual;
    if(!validCounts(observed))throw unavailable();
    const {history_first,history_last,evaluation_first,evaluation_last}=observed;
    if(![history_first,history_last,evaluation_first,evaluation_last].every(validDay) ||
       !(history_first<history_last && history_last<=value.registered_jst_day &&
         value.registered_jst_day<evaluation_first && evaluation_first<evaluation_last))throw unavailable();
    actual={...COUNTS,history_first,history_last,evaluation_first,evaluation_last};
  } else if(value.actual!==null)throw unavailable();
  return {status:value.status,reason:value.reason,expected:{...COUNTS},actual,
    registered_jst_day:value.registered_jst_day,earliest_possible_day:value.earliest_possible_day,
    ...Object.fromEntries(FLAGS.map(flag=>[flag,false]))};
}

const EVIDENCE_KEYS=['source','retrieval','calendar','adjustment','rights','point_in_time'];
const EVIDENCE_STATES=new Set(['missing','unsafe','hash_mismatch','hash_match']);

export function evaluationEvidenceResponse(value) {
  const report=evaluationReadinessResponse(value);
  const audit=value.evidence_audit;
  if(report.status!=='pending_evidence_review') {
    if(audit!==null)throw unavailable();
    return {...report,evidence_audit:null};
  }
  if(audit?.expected!==EVIDENCE_KEYS.length || audit.authenticity_verified!==false || audit.content_reviewed!==false ||
     !audit.categories || Object.keys(audit.categories).length!==EVIDENCE_KEYS.length)throw unavailable();
  const categories={};
  let matches=0;
  for(const key of EVIDENCE_KEYS) {
    const state=audit.categories[key];
    if(!Object.hasOwn(audit.categories,key) || !EVIDENCE_STATES.has(state))throw unavailable();
    categories[key]=state;
    if(state==='hash_match')matches++;
  }
  if(audit.hash_matches!==matches)throw unavailable();
  return {...report,evidence_audit:{categories,hash_matches:matches,expected:EVIDENCE_KEYS.length,
    authenticity_verified:false,content_reviewed:false}};
}

export function createAccessoryEvaluationReadiness({script=HELPER}={}) {
  return function check(registration_id,{signal,evidence=false}={}) {
    if(process.platform!=='linux')return Promise.reject(unavailable());
    return new Promise((resolve,reject)=>{
      const child=execFile('python3',['-B','-E',script,...(evidence?['--evidence']:[])],{
        env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'},signal,
        timeout:6000,maxBuffer:4096,killSignal:'SIGKILL',
      },(error,stdout)=>{
        if(error)return reject(unavailable());
        try {
          const data=JSON.parse(stdout);
          if(data.code==='not_found')return reject(fail(404,'指定された固定記録が見つかりません。'));
          if(!data.result)throw unavailable();
          resolve(data.result);
        } catch {reject(unavailable());}
      });
      child.stdin.on('error',()=>child.kill('SIGKILL'));
      child.stdin.end(JSON.stringify({registration_id})+'\n');
    });
  };
}
