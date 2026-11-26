/** S107 snapshot integrity and read-only local delivery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createGameServer} from '../../game_runtime/server.mjs';

const root=new URL('../../',import.meta.url);
const reportUrl=new URL('game_runtime/synthetic-frozen-report-v1.json',root);
const report=JSON.parse(await readFile(reportUrl,'utf8'));
const never=()=>assert.fail('Static sample must not read settings, predict, or write');
test('S107 saved sample exactly matches the passing S106 synthetic computation',()=>{
  const output=execFileSync('node',['--test','mcp/tests/frozen-accessory-replay.test.mjs'],
    {cwd:root,encoding:'utf8',timeout:30000,maxBuffer:512*1024,
      env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'}});
  const lines=output.split(String.fromCharCode(10)).filter(line=>line.includes('S106 synthetic summary: '));
  assert.equal(lines.length,1);
  const summary=JSON.parse(lines[0].split('S106 synthetic summary: ')[1]);
  const fixture=JSON.parse(execFileSync('python3',['-B','-E',fileURLToPath(new URL(
    'mcp/tests/frozen_accessory_replay_fixture.py',root)),'paired'],
    {cwd:root,encoding:'utf8',timeout:15000,maxBuffer:512*1024}));
  assert.deepEqual(report,{schema:1,kind:'SYNTHETIC_TEST_SNAPSHOT_ONLY',
    source_commit:'a76115b7e9ca17b118eac086769b76e16b029fa8',scenario:'S106_PAIRED_V1',
    fixture_sha256:fixture.fixture_sha256,models:fixture.frozen_models,summary});
  assert.equal(summary.score_allowed,false);
  assert.equal(summary.real_market_history,false);
  assert.equal(summary.holdout_evaluated,false);
  assert.ok(['character_id','registration_id','future_prices','probability_traces'].every(key=>!JSON.stringify(report).includes(key)));
});

test('S107 exact read-only sample route, without model or registration reads',async t=>{
  const server=createGameServer({accessoryAnalysisStore:{read:never,save:never},
    accessoryRegistrationStore:{list:never,save:never},accessoryEvaluationReadiness:never,
    activeCharacterStore:{read:never},loadSnapshot:never,companionStore:{read:never},
    predict:never,historicalPredict:never,historicalBatchPredict:never,adjustedSplitPredict:never});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin='http://127.0.0.1:'+server.address().port,path='/synthetic-frozen-report-v1.json';
  const res=await fetch(origin+path);
  assert.equal(res.status,200);
  assert.equal(res.headers.get('content-type'),'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(res.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.equal(res.headers.get('access-control-allow-origin'),null);
  assert.deepEqual(await res.json(),report);
  assert.equal((await fetch(origin+path+'?registration_id=synthetic')).status,404);
  assert.equal((await fetch(origin+path,{method:'POST',headers:{Origin:origin}})).status,404);
  assert.equal((await fetch(origin+path,{headers:{Origin:'https://outside.invalid'}})).status,403);
});
