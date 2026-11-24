import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmEntries,candidatePlan} from '../../scripts/benchmark-accessory-entry.mjs';
test('entry needs consecutive LONG, exit immediately',()=>{
  assert.deepEqual(confirmEntries(['LONG','CASH','LONG','LONG','LONG','CASH','LONG','LONG']),['CASH','CASH','CASH','LONG','LONG','CASH','CASH','LONG']);
  assert.throws(()=>confirmEntries(['INVALID']));
});
test('every prefix produces identical decisions without future signals',()=>{
  for(let m=0;m<256;m++){
    const full=Array.from({length:8},(_,i)=>m&(1<<i)?'LONG':'CASH');
    for(let n=1;n<=8;n++)assert.deepEqual(confirmEntries(full.slice(0,n)),confirmEntries(full).slice(0,n));
  }
});
test('candidate preserves prices and model parameters without mutating baseline',()=>{
  const plan={future_prices:[100,101,102],fee_rate:.001,models:{mine:{effective_sha256:'a'.repeat(64),risk_fraction:.35},owl:{risk_fraction:.2}},signals:[{mine:'LONG',owl:'CASH'},{mine:'LONG',owl:'LONG'},{mine:'CASH',owl:'LONG'}]};
  const before=structuredClone(plan),candidate=candidatePlan(plan,'confirm');
  assert.deepEqual(plan,before);
  assert.deepEqual(candidate.future_prices,plan.future_prices);
  assert.equal(candidate.fee_rate,plan.fee_rate);
  assert.deepEqual(candidate.models.owl,plan.models.owl);
  assert.equal(candidate.models.mine.risk_fraction,plan.models.mine.risk_fraction);
  assert.notEqual(candidate.models.mine.effective_sha256,plan.models.mine.effective_sha256);
  assert.deepEqual(candidate.signals.map(s=>s.mine),['CASH','LONG','CASH']);
  assert.deepEqual(candidatePlan(plan,'cash').signals.map(s=>s.mine),['CASH','CASH','CASH']);
  assert.deepEqual(candidatePlan(plan,'equal'),plan);
  assert.throws(()=>candidatePlan(plan,'bogus'));
});
