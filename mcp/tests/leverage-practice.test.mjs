import test from 'node:test';
import assert from 'node:assert/strict';
import {settleLeveragedPractice,settleSymmetricCappedExperiment,MAX_PRACTICE_LEVERAGE} from '../../game_runtime/leverage-practice.mjs';

test('1x matches fee-inclusive simulated equity and leaves cash aside',()=>{
  const value=settleLeveragedPractice({equityPath:[1000,980,1050],amount:1000,leverage:1});
  assert.equal(value.profit_coins,50);
  assert.equal(value.final_balance,10050);
  assert.equal(value.cash_held,9000);
  assert.equal(value.liquidated_at_step,null);
  assert.equal(value.max_drawdown_pct,2);
});

test('25x scales gains and losses but cannot borrow or lose unallocated cash',()=>{
  const up=settleLeveragedPractice({equityPath:[1000,1008,1010],amount:1000,leverage:25});
  assert.equal(up.final_balance,10250);
  assert.equal(up.profit_coins,250);
  const down=settleLeveragedPractice({equityPath:[1000,995,990],amount:1000,leverage:25});
  assert.equal(down.final_balance,9750);
  assert.equal(down.profit_coins,-250);
  assert.equal(MAX_PRACTICE_LEVERAGE,25);
});

test('first loss crossing wipes position and later price recovery cannot resurrect it',()=>{
  const result=settleLeveragedPractice({equityPath:[1000,990,940,1200],amount:1000,leverage:25});
  assert.equal(result.liquidated_at_step,2);
  assert.deepEqual(result.allocated_equity_path,[1000,750,0,0]);
  assert.equal(result.final_balance,9000);
  assert.equal(result.profit_coins,-1000);
  assert.equal(result.max_drawdown_pct,100);
});

test('leverage validates amounts, choices and paths strictly',()=>{
  for(const settle of [settleLeveragedPractice,settleSymmetricCappedExperiment]){
    for(const leverage of [0,26,1.5,Infinity,NaN,'25',null]){
      assert.throws(()=>settle({equityPath:[100,105],amount:100,leverage}),RangeError);
    }
    for(const path of [null,{},[],[100],[100,Infinity],[100,-1],[99,110],[100,NaN],[100,'110'],Array(502).fill(100)]){
      assert.throws(()=>settle({equityPath:path,amount:100,leverage:2}),RangeError);
    }
    for(const amount of [0,-1,1.5,10001,Infinity,NaN,'100',null,Number.MAX_SAFE_INTEGER+1]){
      assert.throws(()=>settle({equityPath:[amount,110],amount,leverage:1}),RangeError);
    }
    for(const available of [99,-1,100.5,Infinity,NaN,'100',null,Number.MAX_SAFE_INTEGER+1]){
      assert.throws(()=>settle({equityPath:[100,110],amount:100,leverage:1,available}),RangeError);
    }
  }
});

test('ONE-STEP ASSUMPTION: equally likely +/-6% yields original +250 average, experiment zero',()=>{
  // This two-outcome, one-step calculation is not proof of fairness in real markets.
  const inputs=[1060,940].map(final=>({equityPath:[1000,final],amount:1000,leverage:25}));
  const original=inputs.map(input=>settleLeveragedPractice(input).profit_coins);
  const experimental=inputs.map(input=>settleSymmetricCappedExperiment(input).profit_coins);
  assert.deepEqual(original,[1500,-1000]);
  assert.equal((original[0]+original[1])/2,250);
  assert.deepEqual(experimental,[1000,-1000]);
  assert.equal((experimental[0]+experimental[1])/2,0);
});

test('experimental 1x matches original ordinary paths, including terminal +/-100% bounds',()=>{
  for(const equityPath of [[1000,980,1050],[1000,1100,940],[1000,500,1500],[1000,0],[1000,2000]]){
    const input={equityPath,amount:1000,leverage:1};
    const original=settleLeveragedPractice(input);
    const experimental=settleSymmetricCappedExperiment(input);
    for(const key of ['leverage','invested_coins','cash_held','profit_coins','allocated_final','final_balance','max_drawdown_pct']){
      assert.equal(experimental[key],original[key],key);
    }
    assert.deepEqual(experimental.capped_equity_path,original.allocated_equity_path);
    assert.equal(experimental.experimental_only,true);
    assert.equal(experimental.daily_close_only,true);
  }
});

test('first experimental gain cap locks profit through later losses and gains',()=>{
  for(const firstWin of [1040,1060]){
    const result=settleSymmetricCappedExperiment({equityPath:[1000,990,firstWin,940,1200],amount:1000,leverage:25});
    assert.equal(result.stopped_at_step,2);
    assert.equal(result.stop_reason,'gain_cap');
    assert.deepEqual(result.capped_equity_path,[1000,750,2000,2000,2000]);
    assert.equal(result.allocated_final,2000);
    assert.equal(result.profit_coins,1000);
    assert.equal(result.cash_held,9000);
    assert.equal(result.final_balance,11000);
    assert.equal(result.max_drawdown_pct,25);
  }
});

test('first experimental loss cap locks liquidation through later recovery',()=>{
  for(const firstLoss of [960,940]){
    const result=settleSymmetricCappedExperiment({equityPath:[1000,1020,firstLoss,1200,980],amount:1000,leverage:25});
    assert.equal(result.stopped_at_step,2);
    assert.equal(result.stop_reason,'loss_cap');
    assert.deepEqual(result.capped_equity_path,[1000,1500,0,0,0]);
    assert.equal(result.allocated_final,0);
    assert.equal(result.profit_coins,-1000);
    assert.equal(result.cash_held,9000);
    assert.equal(result.final_balance,9000);
    assert.equal(result.max_drawdown_pct,100);
  }
});

test('experimental +/-2% at 25x stays uncapped at +/-500 coins',()=>{
  for(const [final,profit] of [[1020,500],[980,-500]]){
    const input={equityPath:[1000,final],amount:1000,leverage:25};
    const original=settleLeveragedPractice(input);
    const result=settleSymmetricCappedExperiment(input);
    assert.equal(original.profit_coins,profit);
    assert.equal(result.profit_coins,profit);
    assert.equal(result.stopped_at_step,null);
    assert.equal(result.stop_reason,null);
    assert.equal(result.final_balance,original.final_balance);
    assert.equal(result.max_drawdown_pct,original.max_drawdown_pct);
    assert.deepEqual(result.capped_equity_path,original.allocated_equity_path);
  }
});

test('rounding near a bound does not trigger an experimental stop',()=>{
  for(const nearBound of [1039.9999,960.0001]){
    const input={equityPath:[1000,nearBound,1000],amount:1000,leverage:25};
    const original=settleLeveragedPractice(input);
    const result=settleSymmetricCappedExperiment(input);
    assert.equal(result.stopped_at_step,null);
    assert.equal(result.stop_reason,null);
    assert.equal(result.profit_coins,0);
    assert.equal(result.max_drawdown_pct,original.max_drawdown_pct);
    assert.deepEqual(result.capped_equity_path,original.allocated_equity_path);
  }
});

test('experimental settlement is pure, preserves idle cash and never makes balances negative',()=>{
  for(const available of [1000,1500]){
    for(const final of [0,1020,2000]){
      const equityPath=Object.freeze([1000,final]);
      const input=Object.freeze({equityPath,amount:1000,leverage:25,available});
      const result=settleSymmetricCappedExperiment(input);
      assert.equal(result.cash_held,available-1000);
      assert.ok(result.final_balance>=result.cash_held);
      assert.ok(result.allocated_final>=0 && result.allocated_final<=2000);
      assert.equal(result.final_balance,result.cash_held+result.allocated_final);
      assert.equal(result.profit_coins,result.allocated_final-1000);
      assert.deepEqual(input,{equityPath:[1000,final],amount:1000,leverage:25,available});
    }
  }
});

import {runSyntheticGame} from '../../game_runtime/practice.mjs';
import {roundingPlan} from './audit74-fixture.mjs';
test('audit74: settlement retains precision through the synthetic replay',()=>{
  const result=runSyntheticGame(roundingPlan());
  assert.equal(result.raw_equity_path[9],.9640162818985352);
  assert.equal(result.equity_path[9],.96);
  const settle=equityPath=>settleLeveragedPractice({equityPath,amount:1,leverage:25});
  assert.equal(settle(result.equity_path).liquidated_at_step,9);
  const actual=settle(result.raw_equity_path);
  assert.equal(actual.liquidated_at_step,null);
  assert.equal(actual.final_balance,10000.25);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(result)),'raw_equity_path'),false);
  assert.equal(Object.hasOwn({...result},'raw_equity_path'),false);
  assert.ok(Object.isFrozen(result.raw_equity_path));
  assert.throws(()=>settle([1,Number.MAX_VALUE]),RangeError);
  const extreme=roundingPlan();extreme.initial_price=.000001;extreme.future_prices.fill(1e12);
  assert.throws(()=>runSyntheticGame(extreme),/不正/);
});
