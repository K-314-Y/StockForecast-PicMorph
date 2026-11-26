import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createAccessoryEvaluationReadiness,evaluationEvidenceResponse,evaluationReadinessResponse} from '../../game_runtime/accessory-evaluation-readiness.mjs';

const run=promisify(execFile);
const PATH='/api/accessory-analysis/v1/registration/readiness';
const EVIDENCE=PATH.replace('/readiness','/evidence');
const KEYS=['source','retrieval','calendar','adjustment','rights','point_in_time'];
const notExpected=()=>assert.fail('Readiness must not read current settings, contact a service or execute a model');
const FALSE_FLAGS=['score_allowed','holdout_evaluated','calendar_verified','source_verified','rights_verified',
  'point_in_time_verified','adjustments_verified','timestamps_verified'];

async function fixture(t,{withInput=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'creature-evidence-http-'));
  const mcp=join(root,'mcp'), state=join(root,'local_state');
  const servers=[];
  t.after(async()=>{
    await Promise.all(servers.map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})));
    await rm(root,{recursive:true,force:true});
  });
  await mkdir(mcp);
  for(const name of ['accessory_evaluation_readiness.py','accessory_registration_store.py','accessory_analysis_store.py','character_equipment.py',
    'character_parts.py','independent_parts_catalog.py','independent_parts.py','import_png_character.py']) {
    await copyFile(new URL('../'+name,import.meta.url),join(mcp,name));
  }
  const seeded=await run('python3',['-B','-E','-c',`
import json,sys
from pathlib import Path
sys.path.insert(0,'mcp/tests')
from test_accessory_evaluation_readiness import fixture,private_write,readiness
root=Path(sys.argv[1])
identifier,_,package=fixture(root)
if sys.argv[2] == "yes":
    folder=root/"local_state"/readiness.INPUT_FOLDER
    folder.mkdir(mode=0o700)
    private_write(folder/(identifier+".json"),package)
print(json.dumps(identifier))
`,root,withInput?'yes':'no'],{cwd:new URL('../../',import.meta.url),timeout:8000,maxBuffer:4096});
  const id=JSON.parse(seeded.stdout);
  const storeCheck=createAccessoryEvaluationReadiness({script:join(mcp,'accessory_evaluation_readiness.py')});
  async function start(overrides={},path=PATH) {
    const server=createGameServer({accessoryEvaluationReadiness:storeCheck,accessoryRegistrationStore:null,
      accessoryAnalysisStore:null,equipmentStore:null,independentPartReader:null,
      activeCharacterStore:{read:notExpected},loadSnapshot:notExpected,companionStore:{read:notExpected},
      predict:notExpected,historicalPredict:notExpected,historicalBatchPredict:notExpected,adjustedSplitPredict:notExpected,
      ...overrides});
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    servers.push(server);
    const origin='http://127.0.0.1:'+server.address().port;
    const post=(input, headers={},suffix='')=>fetch(origin+path+suffix,{method:'POST',
      headers:{'Content-Type':'application/json',Origin:origin,...headers},
      body:typeof input==='string'?input:JSON.stringify(input)});
    return {origin,post};
  }
  return {root,state,id,start,storeCheck,registration:join(state,'accessory_registrations',id+'.json'),
    packageFile:join(state,'accessory_evaluation_inputs',id+'.json')};
}

test('readiness POST works without active character and does not create storage or scan other input',async t=>{
  const {id,state,registration,start}=await fixture(t);
  const api=await start();
  const recordBefore=await readFile(registration);
  const response=await api.post({registration_id:id});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  const report=await response.json();
  assert.equal(report.status,'pending_input');
  assert.equal(report.reason,'input_missing');
  assert.deepEqual(report.expected,{codes:10,history_sessions:24,evaluation_sessions:12,rows:360});
  assert.equal(report.actual,null);
  for(const flag of FALSE_FLAGS)assert.equal(report[flag],false);
  assert.deepEqual(await readdir(state),['accessory_registrations']);
  assert.deepEqual(await readFile(registration),recordBefore);
  assert.equal((await api.post({registration_id:'0'.repeat(64)})).status,404);
});

test('readiness returns only metadata on matched, changed-code, unsafe or corrupted evidence',async t=>{
  const {root,state,id,start,packageFile,registration}=await fixture(t,{withInput:true});
  const api=await start();
  const beforeRecord=await readFile(registration),beforePackage=await readFile(packageFile);
  const check=async()=>{
    const res=await api.post({registration_id:id});
    assert.equal(res.status,200);
    const report=await res.json();
    for(const flag of FALSE_FLAGS)assert.equal(report[flag],false);
    assert.doesNotMatch(JSON.stringify(report),/adjusted_close|available_at|source_sha256|fixture-rights|baseline|local_state|rows":\{/);
    return report;
  };
  const actual=await check();
  assert.equal(actual.status,'pending_evidence_review');
  assert.equal(actual.actual.rows,360);
  assert.equal(actual.actual.evaluation_first,'2025-02-05');
  assert.equal(actual.actual.history_last,'2025-02-04');
  assert.deepEqual(await readFile(packageFile),beforePackage);
  assert.deepEqual(await readFile(registration),beforeRecord);
  assert.deepEqual((await readdir(state)).sort(),['accessory_evaluation_inputs','accessory_registrations']);
  const codeFile=join(root,'engine.py'), oldCode=await readFile(codeFile);
  await writeFile(codeFile,'changed synthetic source');
  assert.equal((await check()).status,'pending_code_mismatch');
  await writeFile(codeFile,oldCode);
  await rm(codeFile);
  const unreadable=await api.post({registration_id:id});
  assert.equal(unreadable.status,503);
  assert.deepEqual(Object.keys(await unreadable.json()),['error']);
  await writeFile(codeFile,oldCode);
  await writeFile(packageFile,'{"schema":1,"schema":1}');
  assert.equal((await check()).status,'pending_invalid_input');
  await writeFile(registration,Buffer.concat([beforeRecord,Buffer.from('\n')]));
  const invalid=await api.post({registration_id:id});
  assert.equal(invalid.status,503);
  assert.deepEqual(Object.keys(await invalid.json()),['error']);
});

for(const path of [PATH,EVIDENCE])test(path+' rejects invalid requests before calling the helper',async t=>{
  const {id,start}=await fixture(t);
  const api=await start({accessoryEvaluationReadiness:notExpected},path);
  const payload={registration_id:id};
  for(const invalid of [null,[],{}, {id}, {...payload,code:'94320'},{registration_id:'../test'},
    {registration_id:id+'\n'},{registration_id:123},'{"registration_id":"'+id+'","registration_id":"'+id+'"}']) {
    assert.equal((await api.post(invalid)).status,400);
  }
  for(const header of [{Origin:'https://outside.invalid'},{Origin:api.origin.replace('127.0.0.1','localhost')},{'Sec-Fetch-Site':'cross-site'}])
    assert.equal((await api.post(payload,header)).status,403);
  assert.equal((await api.post(payload,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await api.post(' '.repeat(8193))).status,413);
  const noOrigin=await fetch(api.origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.equal(noOrigin.status,403);
  const wrongHost=await new Promise((resolve,reject)=>{
    const outbound=request(api.origin+path,{method:'POST',headers:{Host:'outside.invalid',Origin:api.origin}},res=>{
      res.resume();resolve(res.statusCode);
    });
    outbound.once('error',reject);
    outbound.end();
  });
  assert.equal(wrongHost,403);
  assert.equal((await fetch(api.origin+path)).status,404);
  assert.equal((await api.post(payload,{},'?path=external')).status,404);
});

test('Node validates helper statuses and strips all nonmetadata fields',()=>{
  const flags=Object.fromEntries(FALSE_FLAGS.map(flag=>[flag,false]));
  const expected={codes:10,history_sessions:24,evaluation_sessions:12,rows:360};
  const result={status:'pending_evidence_review',reason:'evidence_unreviewed',expected:{...expected,close:[10,20]},
    registered_jst_day:'2025-02-04',earliest_possible_day:'2025-02-05',
    actual:{...expected,history_first:'2025-01-01',history_last:'2025-02-04',evaluation_first:'2025-02-05',
      evaluation_last:'2025-02-21',raw_prices:[5]},package_path:'private',...flags};
  assert.equal(evaluationReadinessResponse(result).status,'pending_evidence_review');
  assert.doesNotMatch(JSON.stringify(evaluationReadinessResponse(result)),/private|raw_prices|close/);
  for(const bad of [{score_allowed:true},{holdout_evaluated:true},{rights_verified:true},{status:'READY'},
    {reason:'verified'},{actual:{...result.actual,evaluation_first:'2025-02-04'}},{earliest_possible_day:'2025-02-06'}])
    assert.throws(()=>evaluationReadinessResponse({...result,...bad}),{status:503});
});

async function stateSnapshot(dir) {
  const snapshot={};
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name);
    const {mtimeNs,mode}=await stat(path,{bigint:true});
    snapshot[entry.name]=[mtimeNs,mode,entry.isDirectory()?await stateSnapshot(path):await readFile(path)];
  }
  return snapshot;
}

test('evidence POST returns only bound metadata and leaves the synthetic state intact',async t=>{
  const {id,start,state,packageFile}=await fixture(t,{withInput:true});
  const api=await start({},EVIDENCE);
  async function check(states) {
    const before=await stateSnapshot(state);
    const response=await api.post({registration_id:id});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
    const result=await response.json();
    assert.equal(result.status,'pending_evidence_review');
    assert.deepEqual(result.evidence_audit,{categories:Object.fromEntries(KEYS.map((k,i)=>[k,states[i]])),
      expected:6,hash_matches:states.filter(s=>s==='hash_match').length,authenticity_verified:false,content_reviewed:false});
    for(const flag of FALSE_FLAGS)assert.equal(result[flag],false);
    assert.doesNotMatch(JSON.stringify(result),/\.bin|local_state|[a-f0-9]{64}|fixture-|synthetic_jpx|adjusted_close|private-document/);
    assert.deepEqual(await stateSnapshot(state),before);
  }
  await check(KEYS.map(()=>'missing'));
  const folder=join(state,'accessory_evaluation_evidence',id);
  await mkdir(folder,{recursive:true,mode:0o700});
  const input=JSON.parse(await readFile(packageFile,'utf8'));
  for(const key of KEYS) {
    const bytes=Buffer.from('private-document-'+key);
    await writeFile(join(folder,key+'.bin'),bytes,{mode:0o600});
    input.evidence[key].sha256=createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(packageFile,JSON.stringify(input));
  await check(KEYS.map(()=>'hash_match'));
  await writeFile(join(folder,'rights.bin'),'different');
  await check(KEYS.map(key=>key==='rights'?'hash_mismatch':'hash_match'));
  const readiness=await start();
  assert.equal('evidence_audit' in await (await readiness.post({registration_id:id})).json(),false);
  await rm(packageFile);
  const before=await stateSnapshot(state);
  const pending=await (await api.post({registration_id:id})).json();
  assert.equal(pending.status,'pending_input');
  assert.equal(pending.evidence_audit,null);
  assert.equal((await api.post({registration_id:'0'.repeat(64)})).status,404);
  assert.deepEqual(await stateSnapshot(state),before);
});

test('evidence validator rejects inconsistent audits and strips helper-only fields',()=>{
  const categories=Object.fromEntries(KEYS.map(k=>[k,'unsafe']));
  const audit={categories,expected:6,hash_matches:0,authenticity_verified:false,content_reviewed:false};
  const expected={codes:10,history_sessions:24,evaluation_sessions:12,rows:360};
  const base={status:'pending_evidence_review',reason:'evidence_unreviewed',expected,
    registered_jst_day:'2025-02-04',earliest_possible_day:'2025-02-05',
    actual:{...expected,history_first:'2025-01-01',history_last:'2025-02-04',evaluation_first:'2025-02-05',
      evaluation_last:'2025-02-21'},...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false])),evidence_audit:audit};
  const clean=evaluationEvidenceResponse({...base,path:'private',evidence_audit:{...audit,ref:'private',raw:'private'}});
  assert.deepEqual(clean,base);
  for(const changes of [{status:'ready'},{reason:'verified'},{evidence_audit:null},
    ...FALSE_FLAGS.map(flag=>({[flag]:true}))])assert.throws(()=>evaluationEvidenceResponse({...base,...changes}),{status:503});
  for(const changes of [{hash_matches:1},{hash_matches:'0'},{expected:5},{content_reviewed:true},{authenticity_verified:true},
    {content_reviewed:undefined},{categories:{...categories,rights:'verified'}},{categories:{...categories,extra:'missing'}},
    {categories:{source:'missing'}}])assert.throws(()=>evaluationEvidenceResponse({...base,evidence_audit:{...audit,...changes}}),{status:503});
  for(const [status,reason] of [['pending_input','input_missing'],['pending_invalid_input','manifest_shape'],['pending_code_mismatch','code_mismatch']]) {
    const pending={...base,status,reason,actual:null};
    assert.throws(()=>evaluationEvidenceResponse(pending),{status:503});
    assert.throws(()=>evaluationEvidenceResponse({...pending,evidence_audit:undefined}),{status:503});
    assert.equal(evaluationEvidenceResponse({...pending,evidence_audit:null}).evidence_audit,null);
  }
});
