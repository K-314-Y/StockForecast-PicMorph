import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createAccessoryEvaluationReadiness,evaluationReadinessResponse} from '../../game_runtime/accessory-evaluation-readiness.mjs';

const run=promisify(execFile);
const PATH='/api/accessory-analysis/v1/registration/readiness';
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
  async function start(overrides={}) {
    const server=createGameServer({accessoryEvaluationReadiness:storeCheck,accessoryRegistrationStore:null,
      accessoryAnalysisStore:null,equipmentStore:null,independentPartReader:null,
      activeCharacterStore:{read:notExpected},loadSnapshot:notExpected,companionStore:{read:notExpected},
      predict:notExpected,historicalPredict:notExpected,historicalBatchPredict:notExpected,adjustedSplitPredict:notExpected,
      ...overrides});
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    servers.push(server);
    const origin='http://127.0.0.1:'+server.address().port;
    const post=(input, headers={},suffix='')=>fetch(origin+PATH+suffix,{method:'POST',
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

test('readiness rejects malformed bodies, forged origin and forged hosts before calling the helper',async t=>{
  const {id,start}=await fixture(t);
  const api=await start({accessoryEvaluationReadiness:notExpected});
  const payload={registration_id:id};
  for(const invalid of [null,[],{}, {id}, {...payload,code:'94320'},{registration_id:'../test'},
    {registration_id:id+'\n'},{registration_id:123},'{"registration_id":"'+id+'","registration_id":"'+id+'"}']) {
    assert.equal((await api.post(invalid)).status,400);
  }
  for(const header of [{Origin:'https://outside.invalid'},{Origin:api.origin.replace('127.0.0.1','localhost')},{'Sec-Fetch-Site':'cross-site'}])
    assert.equal((await api.post(payload,header)).status,403);
  const noOrigin=await fetch(api.origin+PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.equal(noOrigin.status,403);
  const wrongHost=await new Promise((resolve,reject)=>{
    const outbound=request(api.origin+PATH,{method:'POST',headers:{Host:'outside.invalid',Origin:api.origin}},res=>{
      res.resume();resolve(res.statusCode);
    });
    outbound.once('error',reject);
    outbound.end();
  });
  assert.equal(wrongHost,403);
  assert.equal((await fetch(api.origin+PATH)).status,404);
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
