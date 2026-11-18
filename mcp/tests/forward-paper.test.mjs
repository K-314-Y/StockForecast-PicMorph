import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORWARD_PAPER_MODE, createForwardLedger, queueForwardOrder,
  applyForwardBatch, inspectForwardWallet,
} from '../../game_runtime/forward-paper.mjs';

const hA = 'a'.repeat(64);
const hB = 'b'.repeat(64);
const initial = () => createForwardLedger({
  initialMedals:1000,
  allocations:[
    {id:'ai_red',modelHash:hA,medals:300},
    {id:'ai_blue',modelHash:hB,medals:200},
  ],
});
const batch = (observedAt, quotes) =>
  ({observedAt, sourceId:'TEST_FIXTURE_NOT_LIVE', quotes});
const order = (id, aiId, symbol='7203', action='OPEN_LONG', margin=100, leverage=2) =>
  ({id,aiId,symbol,action,margin,leverage});

test('an unconnected forward ledger only allocates virtual funds', () => {
  const ledger=initial();
  assert.equal(ledger.mode, FORWARD_PAPER_MODE);
  assert.equal(ledger.unallocated,500);
  assert.equal(inspectForwardWallet(ledger,'ai_red').cash,300);
  assert.equal(inspectForwardWallet(ledger,'ai_blue').cash,200);
  assert.equal(ledger.lastBatchAt,null);
  assert.equal(ledger.journal.length,0);
});

test('cannot fill at an earlier or equal observation, only a later quote', () => {
  const t='2026-11-18T09:00:00Z';
  let ledger=queueForwardOrder(initial(),order('o1','ai_red'),t);
  ledger=applyForwardBatch(ledger,batch('2026-11-18T08:59:00Z',{'7203':100}));
  assert.equal(ledger.pending.length,1);
  ledger=applyForwardBatch(ledger,batch(t,{'7203':100}));
  assert.equal(ledger.pending.length,1);
  ledger=applyForwardBatch(ledger,batch('2026-11-18T09:30:00Z',{'7203':105}));
  assert.equal(ledger.pending.length,0);
  assert.equal(inspectForwardWallet(ledger,'ai_red').position.entryPrice,105);
  assert.equal(ledger.journal.at(-1).kind,'OPENED');
  assert.throws(()=>applyForwardBatch(ledger,batch(t,{'7203':200})),/時系列/);
});

test('different stock observations do not fill an order or invent a price', () => {
  let ledger=queueForwardOrder(initial(),order('o1','ai_red'),
    '2026-11-18T09:00:00Z');
  ledger=applyForwardBatch(ledger,batch('2026-11-18T09:30:00Z',{'9432':150}));
  assert.equal(ledger.pending.length,1);
  assert.equal(inspectForwardWallet(ledger,'ai_red').position,null);
  ledger=applyForwardBatch(ledger,batch('2026-11-18T10:00:00Z',{'7203':101}));
  assert.equal(inspectForwardWallet(ledger,'ai_red').position.entryPrice,101);
});

test('profit on a long is based on the later actual price supplied by adapter', () => {
  let ledger=queueForwardOrder(initial(),order('open','ai_red'),'2026-11-18T09:00:00Z');
  ledger=applyForwardBatch(ledger,batch('2026-11-18T09:30:00Z',{'7203':100}));
  assert.equal(inspectForwardWallet(ledger,'ai_red').equity,300);
  ledger=applyForwardBatch(ledger,batch('2026-11-18T10:00:00Z',{'7203':110}));
  assert.equal(inspectForwardWallet(ledger,'ai_red').equity,320);
  ledger=queueForwardOrder(ledger,{
    id:'close',aiId:'ai_red',symbol:'7203',action:'CLOSE'
  },'2026-11-18T10:05:00Z');
  ledger=applyForwardBatch(ledger,batch('2026-11-18T10:30:00Z',{'7203':115}));
  assert.equal(inspectForwardWallet(ledger,'ai_red').cash,330);
  assert.equal(inspectForwardWallet(ledger,'ai_red').position,null);
  assert.equal(inspectForwardWallet(ledger,'ai_blue').cash,200);
});

test('a short can exhaust its own collateral, but never another AI or spare cash', () => {
  let ledger=queueForwardOrder(initial(),order('s','ai_red','7203','OPEN_SHORT',100,2),
    '2026-11-18T09:00:00Z');
  ledger=applyForwardBatch(ledger,batch('2026-11-18T09:30:00Z',{'7203':100}));
  ledger=applyForwardBatch(ledger,batch('2026-11-18T10:00:00Z',{'7203':250}));
  const red=inspectForwardWallet(ledger,'ai_red');
  assert.equal(red.equity,0);
  assert.equal(red.cash,0);
  assert.equal(red.status,'LIQUIDATED');
  assert.equal(red.position,null);
  assert.equal(ledger.unallocated,500);
  assert.equal(inspectForwardWallet(ledger,'ai_blue').equity,200);
  assert.equal(ledger.journal.at(-1).kind,'LIQUIDATED');
  assert.throws(()=>queueForwardOrder(ledger,order('after','ai_red'),
    '2026-11-18T10:10:00Z'),/受け付けられません/);
});

test('an unrelated AI does not inherit another AI short loss', () => {
  let ledger=queueForwardOrder(initial(),order('s','ai_red','7203','OPEN_SHORT',100,2),
    '2026-11-18T09:00:00Z');
  ledger=applyForwardBatch(ledger,batch('2026-11-18T09:30:00Z',{'7203':100}));
  ledger=applyForwardBatch(ledger,batch('2026-11-18T10:00:00Z',{'7203':200}));
  assert.equal(inspectForwardWallet(ledger,'ai_red').equity,100);
  assert.equal(inspectForwardWallet(ledger,'ai_blue').equity,200);
});

test('orders queued before wallet bankruptcy are cancelled without resurrection', () => {
  let ledger=queueForwardOrder(initial(),order('s','ai_red','7203','OPEN_SHORT',100,2),
    '2026-11-18T09:00:00Z');
  ledger=applyForwardBatch(ledger,batch('2026-11-18T09:30:00Z',{'7203':100}));
  ledger=queueForwardOrder(ledger,{id:'close',aiId:'ai_red',symbol:'7203',action:'CLOSE'},
    '2026-11-18T09:40:00Z');
  ledger=applyForwardBatch(ledger,batch('2026-11-18T10:00:00Z',{'7203':300}));
  assert.equal(inspectForwardWallet(ledger,'ai_red').status,'LIQUIDATED');
  assert.equal(ledger.pending.length,0);
  assert.equal(ledger.journal.at(-1).kind,'CANCELLED');
});

test('invalid capital, model id and excessive leverage are rejected', () => {
  assert.throws(()=>createForwardLedger({initialMedals:1000,allocations:[
    {id:'ai_red',modelHash:hA,medals:1500},
  ]}),/超えて/);
  assert.throws(()=>createForwardLedger({initialMedals:1000,allocations:[
    {id:'ai_red',modelHash:hA,medals:1},{id:'ai_red',modelHash:hA,medals:1},
  ]}),/識別/);
  assert.throws(()=>queueForwardOrder(initial(),
    order('o','ai_red','7203','OPEN_LONG',301,1),'2026-11-18T09:00:00Z'),/資金/);
  assert.throws(()=>queueForwardOrder(initial(),
    order('o','ai_red','7203','OPEN_LONG',100,26),'2026-11-18T09:00:00Z'),/倍率/);
  assert.throws(()=>queueForwardOrder(initial(),
    order('o','ai_red','7203','OPEN_LONG',100,2),'2026-11-18T09:00:00+09:00'),/UTC/);
  assert.throws(()=>applyForwardBatch(initial(),
    batch('2026-11-18T09:00:00Z',{'7203':NaN})),/価格/);
});

test('state transitions do not mutate earlier snapshots; model is frozen at entry', () => {
  const first=initial();
  const second=queueForwardOrder(first,order('o1','ai_red'),
    '2026-11-18T09:00:00Z');
  const third=applyForwardBatch(second,batch('2026-11-18T09:30:00Z',{'7203':100}));
  assert.equal(first.pending.length,0);
  assert.equal(second.pending.length,1);
  assert.equal(second.journal.length,0);
  assert.equal(third.wallets.ai_red.position.modelHash,hA);
  assert.equal(third.wallets.ai_blue.modelHash,hB);
});


test('extreme prices or oversized profit cannot overflow the medals ledger', () => {
  const state=createForwardLedger({initialMedals:1_000_000_000_000,
    allocations:[{id:'ai_big',modelHash:hA,medals:500_000_000_000}]});
  const queued=queueForwardOrder(state,
    order('huge','ai_big','7203','OPEN_LONG',500_000_000_000,25),
    '2026-11-18T09:00:00Z');
  assert.throws(()=>applyForwardBatch(queued,
    batch('2026-11-18T09:30:00Z',{'7203':0.000001})),/数量/);
  assert.equal(queued.pending.length,1);
  const opened=applyForwardBatch(queued,
    batch('2026-11-18T09:30:00Z',{'7203':100}));
  assert.throws(()=>applyForwardBatch(opened,
    batch('2026-11-18T10:00:00Z',{'7203':1_000_000_000})),/損益/);
  assert.equal(opened.journal.length,1);
});
