import test from 'node:test';
import assert from 'node:assert/strict';
import {settleLeveragedPractice,MAX_PRACTICE_LEVERAGE} from '../../game_runtime/leverage-practice.mjs';

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
  for(const leverage of [0,26,1.5,Infinity,NaN,'25',null]){
    assert.throws(()=>settleLeveragedPractice({equityPath:[100,105],amount:100,leverage}),RangeError);
  }
  for(const path of [[100],[100,Infinity],[100,-1],[99,110],[100,NaN]]){
    assert.throws(()=>settleLeveragedPractice({equityPath:path,amount:100,leverage:2}),RangeError);
  }
  assert.throws(()=>settleLeveragedPractice({equityPath:[100,110],amount:10001,leverage:1}),RangeError);
});
