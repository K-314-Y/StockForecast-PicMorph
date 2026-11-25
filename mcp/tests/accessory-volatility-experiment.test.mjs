import test from 'node:test';
import assert from 'node:assert/strict';
import {volatilityAllocation,riskPath,simulate} from '../../scripts/benchmark-accessory-volatility.mjs';

test('calm market has larger exposure than volatile market; bounds enforced',()=>{
  assert.equal(volatilityAllocation([100,100,100,100,100,100]),.55);
  assert.equal(volatilityAllocation([100,200,100,200,100,200]),.15);
  assert.ok(volatilityAllocation([100,101,100,101,100,101])>volatilityAllocation([100,104,100,104,100,104]));
  assert.throws(()=>volatilityAllocation([0,1,2,3,4,5]));
});
test('each decision uses only prices available before the step',()=>{
  const past=[100,101,100,102,100,101],future=[105,95,103,97],signals=['LONG','LONG','CASH','LONG'];
  const full=riskPath(past,future,signals);
  assert.equal(full[2],0);
  for(let n=1;n<=future.length;n++){
    assert.deepEqual(riskPath(past,future.slice(0,n),signals.slice(0,n)),full.slice(0,n));
    const alt=[...future];alt[n-1]=500;
    assert.deepEqual(riskPath(past,alt,signals).slice(0,n),full.slice(0,n));
  }
  assert.deepEqual(past,[100,101,100,102,100,101]);
});
test('single-wallet cash and known buy then exit match hand calculation',()=>{
  const plan={mode:'PRACTICE_SYNTHETIC_ONLY',allocations:{mine:100,owl:0,turtle:0},initial_coins:1000,initial_price:100,fee_rate:.001,future_prices:[110,120]};
  const original=structuredClone(plan);
  const cash=simulate(plan,[0,0]);
  assert.deepEqual(cash.equity,[1000,1000,1000]);
  assert.equal(cash.fees,0);
  const bought=simulate(plan,[.5,0]);
  assert.ok(Math.abs(bought.profit-48.95)<1e-9);
  assert.ok(Math.abs(bought.fees-1.05)<1e-9);
  assert.equal(bought.trades,2);
  assert.deepEqual(plan,original);
  assert.throws(()=>simulate(plan,[1.1,0]));
});
