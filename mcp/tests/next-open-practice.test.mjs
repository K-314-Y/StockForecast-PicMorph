import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runNextOpenPractice} from '../../game_runtime/next-open-practice.mjs';

const mode='SYNTHETIC_NEXT_OPEN_V2_DRAFT';
const day=(open,close,signal='CASH')=>({open,close,signal});
const plan=(first, risk=.5)=>({mode,initial_close:100,risk_fraction:risk,
  sessions:[...first,...Array.from({length:12-first.length},()=>day(100,100))]});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7, a+' != '+b);
test('new purchase cannot earn an overnight gap from the previous close',()=>{
  const r=runNextOpenPractice(plan([day(200,200,'LONG'),day(200,200)]));
  assert.equal(r.steps[0].execution_price,200);
  near(r.steps[0].units,25);
  near(r.steps[0].equity_at_close,9995);
  near(r.steps[1].equity_before_open_trade,9995);
  near(r.final_coins,9990);
  near(r.fees,10);
  assert.equal(r.trades,2);
  assert.equal(r.score_allowed,false);
});
test('existing position absorbs the next opening gap before a CASH exit',()=>{
  const r=runNextOpenPractice(plan([day(100,100,'LONG'),day(50,50)]));
  near(r.steps[1].equity_before_open_trade,7495);
  near(r.steps[1].equity_after_open_trade,7492.5);
  near(r.final_coins,7492.5);
  near(r.max_drawdown_pct,25.075);
  assert.equal(r.steps[1].units,0);
});
test('all cash stays unchanged, even across enormous gaps',()=>{
  const r=runNextOpenPractice(plan([day(999999,.01),day(.01,999999)]));
  near(r.final_coins,10000);near(r.fees,0);near(r.max_drawdown_pct,0);
  assert.equal(r.trades,0);
});
test('100% target is cash capped including fees; no terminal forced sale',()=>{
  const p=plan([],1);
  p.sessions[11]=day(100,110,'LONG');
  const r=runNextOpenPractice(p);
  const gross=10000/1.001;
  near(r.steps[11].gross,gross);
  near(r.final_coins,gross*1.1);
  assert.equal(r.trades,1);
  assert.ok(r.steps.every(s=>s.cash>=0&&s.units>=0));
});
test('rejects missing or untrusted shape, zero/null price, nonfinite and invalid signals',()=>{
  for(const mutate of [
    p=>p.mode='REAL',p=>p.extra=true,p=>p.sessions.pop(),
    p=>p.sessions[0].open=null,p=>p.sessions[0].close=0,p=>p.sessions[0].open=Infinity,
    p=>p.sessions[0].signal='SHORT',p=>p.sessions[0].observed_at='later',p=>p.risk_fraction=1.1,
  ]){const p=plan([]);mutate(p);assert.throws(()=>runNextOpenPractice(p));}
});

const script=fileURLToPath(new URL('./frozen_accessory_replay_fixture.py',import.meta.url));
const fixture=variant=>JSON.parse(execFileSync('python3',['-B','-E',script,variant],
  {encoding:'utf8',timeout:15000,maxBuffer:512*1024,
    env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'}}));
test('S106 fixed probability decisions feed separate next-open accounting, paired 10 x 12',()=>{
  const a=fixture('paired'),b=fixture('last-close-shock');
  assert.deepEqual(a.probability_traces,b.probability_traces);
  assert.equal(a.windows.length,10);
  let differing=0;
  for(let i=0;i<10;i++){
    const w=a.windows[i],shock=b.windows[i];
    assert.deepEqual(w.plan.signals,shock.plan.signals);
    const prices=w.plan.future_prices;
    // Deterministic fictional gaps, independent of both models and the future close.
    const opens=prices.map((_,j)=>(j===0?w.plan.initial_price:prices[j-1])*
      (1+(((j*7+i*3)%9)-4)/100));
    for(const slot of ['owl','mine']){
      const p={mode,initial_close:w.plan.initial_price,risk_fraction:w.plan.models[slot].risk_fraction,
        sessions:prices.map((close,j)=>day(opens[j],close,w.plan.signals[j][slot]))};
      const r=runNextOpenPractice(p);
      assert.equal(r.steps.length,12);
      assert.equal(r.equity_path.length,37);
      assert.ok(r.steps.every((s,j)=>s.execution_price===null||s.execution_price===opens[j]));
      assert.ok(r.steps.every(s=>s.cash>=0&&s.units>=0));
      // Last close is not available at any decision or at the final open.
      const changed=structuredClone(p);
      changed.sessions[11].close=shock.plan.future_prices[11];
      const s=runNextOpenPractice(changed);
      assert.deepEqual(r.steps.slice(0,11),s.steps.slice(0,11));
      for(const key of ['side','gross','fee','units','cash','equity_before_open_trade','equity_after_open_trade'])
        assert.equal(r.steps[11][key],s.steps[11][key]);
      assert.deepEqual(r,runNextOpenPractice(p));
      if(r.final_coins!==s.final_coins)differing++;
    }
  }
  assert.ok(differing>0,'fixture must exercise a held position at final close');
});
