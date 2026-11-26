/** S106: isolated synthetic integration tests; not a game API or real-data scorer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runSyntheticGame} from '../../game_runtime/practice.mjs';
import {modelMatches,summarizeWindows} from '../../game_runtime/historical-market.mjs';

const script=fileURLToPath(new URL('./frozen_accessory_replay_fixture.py',import.meta.url));
const fixture=variant=>JSON.parse(execFileSync('python3',['-B','-E',script,variant],
  {encoding:'utf8',timeout:15000,maxBuffer:512*1024,
    env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'}}));
const codes=['40050','46890','47550','50200','72010','84100','85930','86040','94320','95010'];

function compare(data) {
  assert.equal(data.scope,'SYNTHETIC_S106_FIXTURE_ONLY');
  assert.equal(data.real_market_history,false);
  assert.equal(data.score_allowed,false);
  assert.equal(data.holdout_evaluated,false);
  assert.match(data.fixture_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(data.windows.map(w=>w.code),codes);
  const pairs=data.windows.map((w,index)=>{
    assert.equal(w.source_origin,'SYNTHETIC_S106_FIXTURE');
    assert.equal(w.lookback_days,24);
    assert.equal(w.future_days,12);
    assert.equal(w.plan.initial_coins,10000);
    assert.equal(w.plan.fee_rate,.001);
    assert.equal(w.plan.initial_price,100);
    assert.equal(w.plan.future_prices.length,12);
    assert.equal(w.plan.signals.length,12);
    assert.equal(w.brier.owl,w.brier.turtle);
    assert.ok(w.plan.signals.every(s=>s.owl===s.turtle));
    assert.ok(modelMatches(w.plan.models.owl,data.frozen_models.baseline));
    assert.ok(modelMatches(w.plan.models.mine,data.frozen_models.candidate));
    // Independently recompute the classifications, decision thresholds and Brier
    // from the traced predictions and closes, not from the reported scores.
    for(const [slot,offset] of [['mine',0],['owl',1],['turtle',2]]){
      let prior=w.plan.initial_price, brier=0;
      for(let day=0;day<12;day++){
        const p=data.probability_traces[index][day*3+offset];
        const next=w.plan.future_prices[day], change=next/prior-1;
        const actual=change>.003?'UP':change<-.003?'DOWN':'FLAT';
        brier+=['UP','FLAT','DOWN'].reduce((sum,k)=>sum+(p[k]-Number(actual===k))**2,0);
        assert.equal(w.plan.signals[day][slot],p.UP>.52&&p.UP>p.DOWN+.05?'LONG':'CASH');
        prior=next;
      }
      assert.ok(Math.abs(w.brier[slot]-brier/12)<=0.000000501);
    }
    function metrics(slot) {
      const allocations={mine:0,owl:0,turtle:0};
      allocations[slot]=100;
      const result=runSyntheticGame({...w.plan,allocations});
      assert.equal(result.steps,12);
      if(w.plan.signals.some(s=>s[slot]==='LONG')){
        assert.ok(result.characters[slot].trades>0);
        assert.ok(result.characters[slot].fees>0);
      }
      const brier=w.brier[slot];
      assert.ok(Number.isFinite(brier)&&brier>=0&&brier<=2);
      assert.ok(Number.isFinite(result.profit_coins));
      assert.ok(result.max_drawdown_pct>=0&&result.max_drawdown_pct<=100);
      return {brier,profit_coins:result.profit_coins,max_drawdown_pct:result.max_drawdown_pct};
    }
    return {baseline:metrics('owl'),candidate:metrics('mine'),
      different_signals:w.plan.signals.filter(s=>s.owl!==s.mine).length};
  });
  return {scope:'SYNTHETIC_FROZEN_COMPARISON_ONLY',real_market_history:false,holdout_evaluated:false,
    score_allowed:false,codes:pairs.length,history_sessions_per_code:24,replay_sessions_per_code:12,
    metrics:summarizeWindows(pairs),different_signals:pairs.reduce((n,p)=>n+p.different_signals,0),
    signal_comparisons:pairs.length*12};
}

test('S106 fixed synthetic models use all 10 paired windows and deterministic accounting',()=>{
  const a=fixture('paired'), b=fixture('paired');
  assert.deepEqual(a,b);
  const summary=compare(a);
  assert.equal(summary.signal_comparisons,120);
  assert.ok(a.windows.some(w=>w.plan.signals.some(s=>s.mine==='LONG'||s.owl==='LONG')));
  assert.ok(a.windows.some(w=>w.plan.signals.some(s=>s.mine==='CASH'||s.owl==='CASH')));
  assert.ok(summary.different_signals>0);
  assert.ok(summary.metrics.profit_coins.baseline_mean!==0||summary.metrics.profit_coins.candidate_mean!==0);

  assert.notDeepEqual(a.frozen_models.baseline,a.frozen_models.candidate);
  assert.ok(a.windows.every(w=>w.plan.models.owl.effective_sha256!==w.plan.models.mine.effective_sha256));
  for(const metric of Object.values(summary.metrics))assert.equal(metric.wins+metric.ties+metric.losses,10);
  console.log('S106 synthetic summary: '+JSON.stringify(summary));
});

test('S106 identical frozen models tie on every metric and all decisions',()=>{
  const data=fixture('identical');
  const summary=compare(data);
  assert.equal(summary.different_signals,0);
  for(const metric of Object.values(summary.metrics)){
    assert.equal(metric.baseline_mean,metric.candidate_mean);
    assert.deepEqual([metric.wins,metric.ties,metric.losses],[0,10,0]);
  }
});

test('S106 altering only the final unseen close cannot alter any preceding probability or decision',()=>{
  const a=fixture('paired'), shock=fixture('last-close-shock');
  assert.equal(a.fixture_sha256,shock.fixture_sha256);
  assert.deepEqual(a.probability_traces,shock.probability_traces);
  for(let i=0;i<10;i++){
    assert.deepEqual(a.windows[i].plan.signals,shock.windows[i].plan.signals);
    assert.deepEqual(a.windows[i].plan.future_prices.slice(0,-1),shock.windows[i].plan.future_prices.slice(0,-1));
    assert.notEqual(a.windows[i].plan.future_prices.at(-1),shock.windows[i].plan.future_prices.at(-1));
  }
  compare(shock);
});

test('S106 fixture accepts no external path or arbitrary prices',()=>{
  assert.throws(()=>fixture('local_state/accessory_evaluation_inputs/example.json'));
});
