import {createHash, createHmac} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createForwardMarketAdapter} from '../../game_runtime/forward-market-adapter.mjs';
import {
  MARKET_PAPER_MODE, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE, TEST_FIXTURE_SOURCE,
} from '../../game_runtime/forward-market-guard.mjs';
import {openForwardStore} from '../../game_runtime/forward-store.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

const at = (time, day = '19') => `2026-11-${day}T${time}Z`;
const iso = stamp => new Date(stamp).toISOString();
const receivedAt = at('01:00:00'); // 10:00 JST
const initial = {mode: MOCK_MARKET_PAPER_MODE, initialMedals: 1000, allocations: [
  {id: 'ai_red', modelHash: 'a'.repeat(64), medals: 300},
  {id: 'ai_blue', modelHash: 'b'.repeat(64), medals: 200},
]};
const order = {id: 'first', aiId: 'ai_red', symbol: '7203', action: 'OPEN_SHORT', margin: 100, leverage: 2};
const sign = (raw, key = 'MOCK_NONLIVE public test key') => createHmac('sha256', key).update(raw).digest('hex');
function row(fields = {}) {
  const raw = JSON.stringify({sourceId: MOCK_MARKET_SOURCE, market: 'XTKS', valueKind: 'TRADE',
    symbol: '7203', price: 100, tradeAt: at('01:05:00'), publishedAt: at('01:05:00'), ...fields}, null, 2);
  return {raw, proof: sign(raw)};
}
const verifyRecord = ({raw, proof}) => sign(raw) === proof ? JSON.parse(raw) : null;

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'market-adapter-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const filePath = join(dir, 'ledger.json');
  const state = {now: receivedAt, rows: [row()], reads: 0};
  const config = {
    sourceId: MOCK_MARKET_SOURCE, licenseRef: 'MOCK_NONLIVE test evidence only',
    verifyUsage: ({sourceId, mode, licenseRef}) => sourceId === MOCK_MARKET_SOURCE &&
      mode === MOCK_MARKET_PAPER_MODE && licenseRef === 'MOCK_NONLIVE test evidence only',
    observationIntervalMs: 5 * 60_000, maxAgeMs: 16 * 60_000, maxPublicationDelayMs: 12 * 60_000,
    verifyRecord, marketStatusAt: () => 'OPEN',
    readBatch: async () => {state.reads++; return state.rows;},
    clock: () => Date.parse(state.now), ...overrides,
  };
  const marketAdapter = createForwardMarketAdapter(config);
  const store = await openForwardStore({filePath, initial, marketAdapter});
  return {store, state, filePath, config, marketAdapter};
}

test('10:00 reservation skips a freshly published 09:55 trade at 10:05 and fills on a later batch', async t => {
  const {store, state} = await setup(t);
  const queued = await store.reserveMarketOrder(order, 0);
  assert.equal(queued.ledger.pending[0].receivedAt, iso(receivedAt));
  assert.equal(queued.ledger.pending[0].eligibleAt, iso(at('01:05:00')));
  state.now = at('01:05:00');
  state.rows = [row({tradeAt: at('00:55:00')})];
  const pending = await store.applyForwardBatch(1);
  assert.equal(pending.ledger.pending.length, 1);
  assert.deepEqual(pending.ledger.lastTradeAt, {'7203': at('00:55:00')});
  assert.deepEqual(pending.ledger.journal, []);
  state.now = at('01:10:00');
  state.rows = [row({tradeAt: at('01:09:59'), publishedAt: state.now})];
  assert.equal((await store.applyForwardBatch(2)).ledger.journal[0].price, 100);
});

for (const [label, tradeAt, fills] of [
  ['at order acceptance', receivedAt, false],
  ['one millisecond before cutoff', at('01:04:59.999'), false],
  ['at cutoff', at('01:05:00'), true],
  ['one millisecond after cutoff', at('01:05:00.001'), true],
]) {
  test(`cutoff uses the market trade time ${label}`, async t => {
    const {store, state} = await setup(t);
    await store.reserveMarketOrder(order, 0);
    state.now = at('01:05:01');
    state.rows = [row({tradeAt, publishedAt: state.now})];
    const result = await store.applyForwardBatch(1);
    assert.equal(result.ledger.pending.length, fills ? 0 : 1);
    assert.equal(result.ledger.journal.length, fills ? 1 : 0);
  });
}

for (const [label, now, tradeAt, status] of [
  ['lunch recess', at('02:35:00'), at('02:34:59'), 'OPEN'],
  ['after close', at('06:35:00'), at('06:29:59'), 'OPEN'],
  ['holiday', at('01:05:00', '23'), at('01:05:00', '23'), 'CLOSED'],
  ['individual halt', at('01:05:00'), at('01:05:00'), 'HALTED'],
  ['unknown symbol status', at('01:05:00'), at('01:05:00'), undefined],
]) {
  test(`keeps reservations pending during ${label}`, async t => {
    const {store, state} = await setup(t, {marketStatusAt: ({symbol}) => symbol === '7203' ? status : 'OPEN'});
    await store.reserveMarketOrder(order, 0);
    state.now = now;
    state.rows = [row({tradeAt, publishedAt: now})];
    const result = await store.applyForwardBatch(1);
    assert.equal(result.ledger.pending.length, 1);
    assert.deepEqual(result.ledger.lastTradeAt, {});
    assert.deepEqual(result.ledger.journal, []);
  });
}

test('a halt blocks only the affected stock and a later session can fill its reservation', async t => {
  let halted = true;
  const {store, state} = await setup(t, {
    marketStatusAt: ({symbol}) => halted && symbol === '7203' ? 'HALTED' : 'OPEN',
  });
  await store.reserveMarketOrder(order, 0);
  await store.reserveMarketOrder({...order, id: 'second', aiId: 'ai_blue', symbol: '9432'}, 1);
  state.now = at('01:05:00');
  state.rows = [row(), row({symbol: '9432'})];
  const first = await store.applyForwardBatch(2);
  assert.deepEqual(first.ledger.pending.map(o => o.id), ['first']);
  assert.deepEqual(first.ledger.lastTradeAt, {'9432': at('01:05:00')});
  halted = false;
  state.now = at('03:30:00');
  state.rows = [row({tradeAt: state.now, publishedAt: state.now})];
  const second = await store.applyForwardBatch(3);
  assert.deepEqual(second.ledger.pending, []);
  assert.deepEqual(second.ledger.lastTradeAt, {'9432': at('01:05:00'), '7203': state.now});
});

test('an order received on a batch boundary waits for the next boundary, including CLOSE', async t => {
  const {store, state} = await setup(t);
  await store.reserveMarketOrder(order, 0);
  state.now = at('01:05:00');
  await store.applyForwardBatch(1);
  const close = {id: 'close', aiId: 'ai_red', symbol: '7203', action: 'CLOSE'};
  const queued = await store.reserveMarketOrder(close, 2);
  assert.equal(queued.ledger.pending[0].eligibleAt, iso(at('01:10:00')));
  state.now = at('01:10:00');
  state.rows = [row({tradeAt: at('01:05:01'), publishedAt: state.now})];
  const pending = await store.applyForwardBatch(3);
  assert.equal(pending.ledger.pending[0].id, 'close');
  assert.equal(pending.ledger.journal.length, 1);
  state.now = at('01:15:00');
  state.rows = [row({price: 90, tradeAt: state.now, publishedAt: state.now})];
  const closed = await store.applyForwardBatch(4);
  assert.equal(closed.ledger.journal.at(-1).kind, 'CLOSED');
  assert.equal(closed.ledger.wallets.ai_red.cash, 320);
});

for (const [label, makeRow] of [
  ['proof mismatch', () => ({...row({price: 300}), proof: row().proof})],
  ['provider source forgery', () => row({sourceId: 'FORGED_PROVIDER'})],
  ['untrusted signer', () => ({...row(), proof: sign(row().raw, 'wrong key')})],
  ['fixture proof', () => ({...row(), proof: TEST_FIXTURE_SOURCE})],
  ['unconfirmed price', () => row({price: null})],
  ['price of the wrong kind', () => row({valueKind: 'INDICATIVE'})],
  ['unsupported exchange', () => row({market: 'OTHER'})],
  ['future timestamp', () => row({tradeAt: at('01:05:01'), publishedAt: at('01:05:01')})],
  ['future publication', () => row({publishedAt: at('01:05:01')})],
  ['stale trade', () => row({tradeAt: at('00:48:59'), publishedAt: at('00:49:00')})],
  ['excessive publication delay', () => row({tradeAt: at('00:52:59')})],
  ['inverted publication date', () => row({publishedAt: at('01:05:00', '18')})],
]) {
  test(`MOCK_NONLIVE rejects ${label}`, async t => {
    const {store, state} = await setup(t);
    await store.reserveMarketOrder(order, 0);
    state.now = at('01:05:00');
    state.rows = [makeRow()];
    const result = await store.applyForwardBatch(1);
    assert.equal(result.ledger.pending.length, 1);
    assert.deepEqual(result.ledger.lastTradeAt, {});
    assert.deepEqual(result.ledger.journal, []);
  });
}

test('the server clock alone stamps order, ingestion and observation, and evidence can be reverified', async t => {
  const {store, state} = await setup(t);
  for (const fake of [{receivedAt: at('00:00:00')}, {eligibleAt: at('00:00:00')}, {observedAt: receivedAt}]) {
    await assert.rejects(store.reserveMarketOrder({...order, ...fake}, 0), /入力/);
  }
  await assert.rejects(store.queueForwardOrder(order, at('00:00:00'), 0), /受付経路/);
  await store.reserveMarketOrder(order, 0);
  state.now = at('01:05:10');
  const envelope = row({observedAt: at('23:00:00'), ingestedAt: at('00:00:00'), receivedAt: at('00:00:00')});
  state.rows = [{...envelope, observedAt: at('22:00:00'), ingestedAt: at('00:00:00')}];
  const {ledger} = await store.applyForwardBatch(1);
  const [fill] = ledger.journal;
  assert.equal(fill.receivedAt, iso(receivedAt));
  assert.equal(fill.ingestedAt, iso(state.now));
  assert.equal(fill.observedAt, iso(state.now));
  assert.equal(fill.evidence.raw, envelope.raw);
  assert.equal(fill.evidence.proof, envelope.proof);
  const confirmed = verifyRecord(fill.evidence);
  for (const key of ['sourceId', 'symbol', 'price', 'tradeAt', 'publishedAt']) assert.equal(fill[key], confirmed[key]);
});

test('duplicates, callback errors and revision conflicts cannot partially update a batch', async t => {
  let failAt;
  const error = new Error('MOCK_NONLIVE callback failed');
  const {store, state} = await setup(t, {
    verifyRecord: envelope => {if (failAt === 'verifier') throw error; return verifyRecord(envelope);},
    marketStatusAt: ({symbol}) => {if (failAt === 'calendar' && symbol === '9432') throw error; return 'OPEN';},
    verifyUsage: () => {if (failAt === 'licence') throw error; return true;},
  });
  const queued = await store.reserveMarketOrder(order, 0);
  await assert.rejects(store.reserveMarketOrder({...order, aiId: 'ai_blue'}, 1), /重複/);
  state.now = at('01:05:00');
  state.rows = [row(), row({price: 101})];
  await assert.rejects(store.applyForwardBatch(0), {code: 'FORWARD_STORE_REVISION_CONFLICT'});
  assert.equal(state.reads, 0);
  await assert.rejects(store.applyForwardBatch(1), /重複銘柄/);
  state.rows = [row(), row({symbol: '9432'})];
  for (const callback of ['verifier', 'calendar', 'licence']) {
    failAt = callback;
    await assert.rejects(store.applyForwardBatch(1), error);
    assert.deepEqual(await store.snapshot(), queued);
  }
  failAt = undefined;
  const results = await Promise.allSettled([store.applyForwardBatch(1), store.applyForwardBatch(1)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'FORWARD_STORE_REVISION_CONFLICT');
  assert.equal((await store.snapshot()).ledger.journal.length, 1);
});

test('restart retains chronology, ignores repeated and inverted trades and validates saved fill evidence fields', async t => {
  const {store, state, filePath, config} = await setup(t);
  const queued = await store.reserveMarketOrder(order, 0);
  const reopen = () => openForwardStore({filePath, marketAdapter: createForwardMarketAdapter(config)});
  const resumed = await reopen();
  assert.deepEqual(await resumed.snapshot(), queued);
  state.now = at('01:05:00');
  const opened = await resumed.applyForwardBatch(1);
  assert.equal(opened.ledger.lastTradeAt['7203'], at('01:05:00'));
  const restored = await reopen();
  assert.deepEqual(await restored.snapshot(), opened);
  await assert.rejects(restored.applyForwardBatch(2), /時系列/);
  await assert.rejects((await openForwardStore({filePath})).applyForwardBatch(2), /利用許可/);
  await assert.rejects(openForwardStore({filePath, marketAdapter: createForwardMarketAdapter({
    ...config, observationIntervalMs: 60_000,
  })}), /観測間隔/);
  state.now = at('01:05:01');
  await assert.rejects(restored.applyForwardBatch(2), /処理済み/);
  assert.deepEqual(await restored.snapshot(), opened);
  state.now = at('01:10:00');
  state.rows = [row({price: 300})];
  const replay = await restored.applyForwardBatch(2);
  assert.equal(replay.ledger.wallets.ai_red.position.lastPrice, 100);
  assert.deepEqual(replay.ledger.journal, opened.ledger.journal);
  state.now = at('01:15:00');
  state.rows = [row({price: 300, tradeAt: at('01:04:59')})];
  const inverted = await restored.applyForwardBatch(3);
  assert.equal(inverted.ledger.wallets.ai_red.position.lastPrice, 100);
  assert.deepEqual(inverted.ledger.lastTradeAt, opened.ledger.lastTradeAt);
  state.now = at('01:20:00');
  state.rows = [row({price: 300, tradeAt: state.now, publishedAt: state.now})];
  const liquidated = await restored.applyForwardBatch(4);
  assert.equal(liquidated.ledger.wallets.ai_red.status, 'LIQUIDATED');
  assert.equal(liquidated.ledger.wallets.ai_blue.cash, 200);
  assert.equal(liquidated.ledger.journal.at(-1).kind, 'LIQUIDATED');
  assert.equal(liquidated.ledger.journal.at(-1).tradeAt, state.now);
  const original = await readFile(filePath, 'utf8');
  for (const tamper of [
    fill => {fill.tradeAt = fill.receivedAt;},
    fill => {fill.tradeAt = at('01:04:59');},
    fill => {fill.sourceId = 'OTHER_PROVIDER';},
    fill => {delete fill.evidence.proof;},
  ]) {
    const {version, revision, ledger} = JSON.parse(original);
    tamper(ledger.journal[0]);
    const payload = {version, revision, ledger};
    const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await writeFile(filePath, JSON.stringify({...payload, checksum}) + '\n');
    await assert.rejects(openForwardStore({filePath}), {code: 'FORWARD_STORE_CORRUPT'});
  }
});

test('no licence, incomplete verification and mock-to-market mode mismatch fail closed', async t => {
  const {filePath, config, marketAdapter} = await setup(t);
  for (const overrides of [{licenseRef: ''}, {verifyUsage: () => false}, {verifyUsage: undefined},
    {verifyRecord: undefined}, {marketStatusAt: undefined}, {sourceId: TEST_FIXTURE_SOURCE},
    {verifyUsage: async () => {throw new Error('unsupported callback');}}]) {
    assert.throws(() => createForwardMarketAdapter({...config, enabled: true, ...overrides}));
  }
  await assert.rejects(openForwardStore({filePath, marketAdapter: {enabled: true}}), /不正/);
  await assert.rejects(openForwardStore({filePath: filePath + '.real', marketAdapter,
    initial: {...initial, mode: MARKET_PAPER_MODE}}), /利用許可/);
  await assert.rejects(openForwardStore({marketAdapter, initial}), /保存先/);
});

test('a failed provider read leaves the pending order and revision intact', async t => {
  const {store} = await setup(t, {readBatch: async () => {throw Error('MOCK_NONLIVE read failed');}});
  const queued = await store.reserveMarketOrder(order, 0);
  await assert.rejects(store.applyForwardBatch(1), /read failed/);
  assert.deepEqual(await store.snapshot(), queued);
});

test('the standard HTTP server exposes no market order or observation endpoint', async () => {
  const server = createGameServer();
  server.address = () => ({port: 18890});
  for (const url of ['/api/forward/order', '/api/forward/batch']) {
    const req = Object.assign(Readable.from([]), {
      method: 'POST', url, headers: {host: '127.0.0.1:18890'}, socket: {remoteAddress: '127.0.0.1'},
    });
    let status;
    await server.listeners('request')[0](req, {writeHead: code => {status = code;}, end: () => {}});
    assert.equal(status, 404);
  }
});
