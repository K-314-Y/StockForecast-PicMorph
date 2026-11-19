import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORWARD_PAPER_MODE, createForwardLedger, queueForwardOrder,
  applyForwardBatch, inspectForwardWallet,
} from '../../game_runtime/forward-paper.mjs';
import {MARKET_PAPER_MODE, TEST_FIXTURE_SOURCE} from '../../game_runtime/forward-market-guard.mjs';

const hA = 'a'.repeat(64);
const hB = 'b'.repeat(64);
const initial = (mode = FORWARD_PAPER_MODE) => createForwardLedger({
  mode,
  initialMedals:1000,
  allocations:[
    {id:'ai_red',modelHash:hA,medals:300},
    {id:'ai_blue',modelHash:hB,medals:200},
  ],
});
const batch = (observedAt, quotes) =>
  ({observedAt, sourceId: TEST_FIXTURE_SOURCE, quotes});
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

test('profit on a fixture long is based on the later synthetic price', () => {
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

const marketAt = (time, day = '19') => `2026-11-${day}T${time}Z`;
const received = marketAt('01:00:00'); // 10:00 JST
const sourceId = 'MOCK_PROVIDER_NOT_LIVE';
const marketQuote = (overrides = {}) => ({
  symbol: '7203', price: 105, tradeAt: marketAt('01:02:00'),
  publishedAt: marketAt('01:03:00'), ingestedAt: marketAt('01:04:00'),
  proof: TEST_FIXTURE_SOURCE, ...overrides,
});
const marketBatch = (quotes, observedAt = marketAt('01:05:00')) => ({sourceId, observedAt, quotes});
const mockPolicy = (trustedQuotes, options) => ({
  enabled: true, usageAuthorized: true, sourceId, maxAgeMs: 15 * 60_000,
  verifyQuote: quote => quote.sourceId === sourceId && Object.hasOwn(trustedQuotes, quote.symbol) &&
    Object.entries(trustedQuotes[quote.symbol]).every(([key, value]) => quote[key] === value),
  marketStatusAt: () => 'OPEN',
  ...options,
});
const marketOrder = (receivedAt = received) =>
  queueForwardOrder(initial(MARKET_PAPER_MODE), order('open', 'ai_red'), receivedAt);
const applyMarket = (ledger, observation, policy = mockPolicy(observation.quotes), now = observation.observedAt) =>
  applyForwardBatch(ledger, observation, {providerPolicy: policy, now: Date.parse(now)});

for (const [name, tradeAt, publishedAt] of [
  ['same trade time as receipt', received, marketAt('01:03:00')],
  ['09:55 trade with a fresh publication and 10:05 batch', marketAt('00:55:00'), marketAt('01:03:00')],
  ['only ingestion is newer than receipt', marketAt('00:55:00'), marketAt('00:56:00')],
]) {
  test(`market order stays pending with ${name}`, () => {
    const quote = marketQuote({tradeAt, publishedAt});
    const result = applyMarket(marketOrder(), marketBatch({'7203': quote}));
    assert.equal(result.lastTradeAt['7203'], tradeAt);
    assert.equal(result.pending.length, 1);
    assert.equal(result.journal.length, 0);
    assert.equal(inspectForwardWallet(result, 'ai_red').position, null);
  });
}

test('market orders fill independently by symbol and journal all three timestamps', () => {
  const queued = queueForwardOrder(marketOrder(), order('second', 'ai_blue', '9432'), received);
  const quote = marketQuote();
  const earlier = marketQuote({symbol: '9432', tradeAt: marketAt('00:55:00')});
  const observation = marketBatch({'7203': quote, '9432': earlier});
  const filled = applyMarket(queued, observation);
  assert.deepEqual(filled.pending.map(item => item.id), ['second']);
  assert.equal(inspectForwardWallet(filled, 'ai_red').position.entryPrice, 105);
  assert.deepEqual(filled.journal, [{
    kind: 'OPENED', orderId: 'open', aiId: 'ai_red', modelHash: hA,
    observedAt: observation.observedAt, sourceId, price: 105, receivedAt: received,
    symbol: quote.symbol, tradeAt: quote.tradeAt, publishedAt: quote.publishedAt, ingestedAt: quote.ingestedAt,
  }]);
});

test('fixture and market ledgers reject each other’s observations and live flags grant no authority', () => {
  const quote = marketQuote();
  const observation = marketBatch({'7203': quote});
  const policy = mockPolicy(observation.quotes);
  assert.throws(() => applyForwardBatch(marketOrder(), {...observation, live: true, providerPolicy: policy}),
    /利用許可/);
  for (const options of [
    {enabled: false}, {usageAuthorized: false}, {sourceId: 'OTHER_PROVIDER'},
    {verifyQuote: undefined}, {marketStatusAt: undefined}, {maxAgeMs: undefined},
  ]) {
    assert.throws(() => applyMarket(marketOrder(), observation, {...policy, ...options}), /利用許可/);
  }
  assert.throws(() => applyMarket(marketOrder(), batch(received, {'7203': 105})), /利用許可/);
  assert.throws(() => applyMarket(initial(), observation, policy), /試験用/);
});

for (const [name, overrides] of [
  ['missing trade time', {tradeAt: undefined}],
  ['missing publication time', {publishedAt: undefined}],
  ['missing ingestion time', {ingestedAt: undefined}],
  ['missing price', {price: undefined}],
  ['missing provenance', {proof: undefined}],
  ['inverted publication date', {publishedAt: marketAt('01:03:00', '18')}],
  ['inverted ingestion time', {ingestedAt: marketAt('01:01:00')}],
  ['ingestion after the batch', {ingestedAt: marketAt('01:05:01')}],
  ['future market trade', {tradeAt: marketAt('01:06:00')}],
  ['impossible UTC date', {tradeAt: '2026-11-31T01:02:00Z'}],
  ['stale trade', {tradeAt: marketAt('00:49:59')}],
  ['quote for a different stock under the order symbol', {symbol: '9432'}],
]) {
  test(`market guard rejects ${name}`, () => {
    const result = applyMarket(marketOrder(), marketBatch({'7203': marketQuote(overrides)}));
    assert.equal(result.pending.length, 1);
    assert.deepEqual(result.lastTradeAt, {});
    assert.equal(result.journal.length, 0);
  });
}

test('market guard denies a future or stale batch using the server clock', () => {
  const observation = marketBatch({'7203': marketQuote()});
  for (const now of [marketAt('01:04:59'), marketAt('01:20:01')]) {
    assert.throws(() => applyMarket(marketOrder(), observation, undefined, now), /取得時刻/);
  }
});

test('market guard rejects a missing ticker and payload tampering even with a copied proof', () => {
  const quote = marketQuote();
  const other = marketQuote({symbol: '9432'});
  const unrelated = applyMarket(marketOrder(), marketBatch({'9432': other}));
  assert.equal(unrelated.pending.length, 1);
  assert.deepEqual(unrelated.lastTradeAt, {'9432': other.tradeAt});
  for (const change of [{price: 500}, {tradeAt: marketAt('01:01:00')}, {publishedAt: marketAt('01:02:30')},
    {ingestedAt: marketAt('01:03:30')}, {proof: 'REPLACED'}]) {
    const result = applyMarket(marketOrder(), marketBatch({'7203': {...quote, ...change}}),
      mockPolicy({'7203': quote}));
    assert.deepEqual(result.lastTradeAt, {});
    assert.equal(result.pending.length, 1);
  }
  const relabelled = applyMarket(marketOrder(), marketBatch({'7203': {...other, symbol: '7203'}}),
    mockPolicy({'9432': other}));
  assert.deepEqual(relabelled.lastTradeAt, {});
  assert.equal(relabelled.pending.length, 1);
});

for (const [name, trade, ingestion, now = ingestion] of [
  ['before opening', '23:59:59', '00:00:00'],
  ['lunch break', '02:31:00', '02:32:00'],
  ['crossing the recess', '02:29:59', '03:30:00'],
  ['after closing', '06:30:00.001', '06:31:00'],
  ['processing after closing', '06:29:58', '06:29:59', '06:30:00.001'],
]) {
  test(`market guard defers orders ${name}`, () => {
    const tradeAt = marketAt(trade, name === 'before opening' ? '18' : '19');
    const ingestedAt = marketAt(ingestion);
    const quote = marketQuote({tradeAt, publishedAt: tradeAt, ingestedAt});
    const observation = marketBatch({'7203': quote}, ingestedAt);
    const result = applyMarket(marketOrder(marketAt('00:00:00', '18')), observation,
      mockPolicy(observation.quotes, {maxAgeMs: 24 * 60 * 60_000}), marketAt(now));
    assert.equal(result.pending.length, 1);
    assert.deepEqual(result.lastTradeAt, {});
  });
}

test('JST boundaries include the exact session endpoints when the calendar confirms trading', () => {
  for (const time of ['00:00:00', '02:30:00', '03:30:00', '06:30:00']) {
    const at = marketAt(time);
    const quote = marketQuote({tradeAt: at, publishedAt: at, ingestedAt: at});
    const result = applyMarket(marketOrder(marketAt('23:59:59', '18')), marketBatch({'7203': quote}, at));
    assert.equal(result.pending.length, 0);
  }
});

test('market guard requires confirmed market and symbol status at trade, receipt, and application', () => {
  const quote = marketQuote();
  const observation = marketBatch({'7203': quote});
  const now = marketAt('01:05:01');
  for (const status of ['CLOSED', 'HALTED', undefined]) {
    for (const stamp of [quote.tradeAt, quote.publishedAt, quote.ingestedAt, observation.observedAt, now]) {
      const result = applyMarket(marketOrder(), observation, mockPolicy(observation.quotes, {
        marketStatusAt: ({symbol, at}) => symbol === '7203' && Date.parse(at) === Date.parse(stamp)
          ? status : 'OPEN',
      }), now);
      assert.deepEqual(result.lastTradeAt, {});
      assert.equal(result.pending.length, 1);
    }
  }
});

test('market guard keeps a close pending at its receipt time and settles on a later trade', () => {
  const opened = applyMarket(marketOrder(), marketBatch({'7203': marketQuote()}));
  const closeAt = marketAt('01:06:00');
  const queued = queueForwardOrder(opened, {id: 'close', aiId: 'ai_red', symbol: '7203', action: 'CLOSE'}, closeAt);
  const sameTime = marketQuote({price: 115, tradeAt: closeAt, publishedAt: closeAt, ingestedAt: closeAt});
  const marked = applyMarket(queued, marketBatch({'7203': sameTime}, marketAt('01:07:00')));
  assert.equal(marked.pending.length, 1);
  assert.equal(marked.journal.length, 1);
  const nextAt = marketAt('01:08:00');
  const later = {...sameTime, tradeAt: nextAt, publishedAt: nextAt, ingestedAt: nextAt};
  const closed = applyMarket(marked, marketBatch({'7203': later}, nextAt));
  assert.equal(closed.pending.length, 0);
  assert.equal(closed.journal.at(-1).kind, 'CLOSED');
  assert.ok(inspectForwardWallet(closed, 'ai_red').cash > 300);
});
