import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, symlink, truncate, unlink, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectForwardWallet} from '../../game_runtime/forward-paper.mjs';
import {deriveForwardAppearanceModel} from '../../game_runtime/appearance-model.mjs';
import {openForwardStore, saveForwardAppearanceGeneration} from '../../game_runtime/forward-store.mjs';
import {MARKET_PAPER_MODE, TEST_FIXTURE_SOURCE} from '../../game_runtime/forward-market-guard.mjs';

const initial = {
  initialMedals: 1000,
  allocations: [
    {id: 'ai_red', modelHash: 'a'.repeat(64), medals: 300},
    {id: 'ai_blue', modelHash: 'b'.repeat(64), medals: 200},
  ],
};
const at = minutes => `2026-11-18T09:${minutes}:00Z`;
const order = (id, aiId = 'ai_red', action = 'OPEN_LONG') => ({
  id, aiId, symbol: '7203', action, margin: 100, leverage: 2,
});
const close = id => ({id, aiId: 'ai_red', symbol: '7203', action: 'CLOSE'});
const fixture = (observedAt, quotes) => ({observedAt, sourceId: 'TEST_FIXTURE_NOT_LIVE', quotes});
const wallet = (snapshot, aiId = 'ai_red') => inspectForwardWallet(snapshot.ledger, aiId);
const appearance = (hair_style = 'bob') => deriveForwardAppearanceModel(
  {hair_style, expression:'cheerful', accessory:'none'}, {hair_color:'#808080', clothing_color:'#808080'});

async function tempLedger(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'forward-store-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return {directory, filePath: join(directory, 'ledger.json')};
}

async function failNextSync(t, filePath, directory) {
  const handle = await open(filePath, 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const sync = prototype.sync;
  let failed = false;
  return t.mock.method(prototype, 'sync', async function () {
    if (!failed && (await this.stat()).isDirectory() === directory) {
      failed = true;
      throw Object.assign(new Error('test fsync failure'), {code: 'EIO'});
    }
    return sync.call(this);
  }).mock;
}

function encodeTestRecord(saved) {
  const {version, revision, ledger} = saved;
  const checksum = createHash('sha256').update(JSON.stringify({version, revision, ledger})).digest('hex');
  return JSON.stringify({version, revision, ledger, checksum}) + '\n';
}

test('restores pending orders, future fills, fractional equity and settlement over restarts', async t => {
  const {filePath} = await tempLedger(t);
  let observation;
  const getObservation = () => observation;
  let store = await openForwardStore({filePath, initial, getObservation});
  const starting = await store.snapshot();
  assert.equal(starting.revision, 0);
  assert.equal(wallet(starting).cash, 300);
  assert.equal(starting.ledger.unallocated, 500);

  const queued = await store.queueForwardOrder(order('open'), at('00'), 0);
  assert.equal(queued.revision, 1);
  assert.deepEqual(queued.ledger.pending.map(o => o.id), ['open']);
  assert.equal(queued.ledger.journal.length, 0);
  store = await openForwardStore({filePath, getObservation});
  assert.deepEqual(await store.snapshot(), queued);

  observation = fixture(at('00'), {'7203': 99});
  const sameTime = await store.applyForwardBatch(1);
  assert.equal(sameTime.ledger.pending.length, 1);
  assert.equal(sameTime.ledger.journal.length, 0);
  observation = fixture(at('01'), {'9432': 101});
  assert.equal((await store.applyForwardBatch(2)).ledger.pending.length, 1);
  observation = fixture(at('02'), {'7203': 101});
  const opened = await store.applyForwardBatch(3);
  assert.equal(opened.revision, 4);
  assert.equal(wallet(opened).position.entryPrice, 101);
  assert.equal(opened.ledger.journal[0].sourceId, 'TEST_FIXTURE_NOT_LIVE');
  observation = fixture(at('03'), {'7203': 102.25});
  const marked = await store.applyForwardBatch(4);
  assert.ok(Math.abs(wallet(marked).equity - (300 + 200 / 101 * 1.25)) < 1e-10);
  assert.equal(wallet(marked, 'ai_blue').cash, 200);

  store = await openForwardStore({filePath, getObservation});
  assert.deepEqual(await store.snapshot(), marked);
  await store.queueForwardOrder(close('close'), at('04'), 5);
  store = await openForwardStore({filePath, getObservation});
  observation = fixture(at('05'), {'7203': 103.5});
  const settled = await store.applyForwardBatch(6);
  assert.equal(settled.revision, 7);
  assert.equal(wallet(settled).position, null);
  assert.ok(Math.abs(wallet(settled).cash - (300 + 200 / 101 * 2.5)) < 1e-10);
  assert.equal(wallet(settled, 'ai_blue').cash, 200);
  assert.deepEqual(settled.ledger.journal.map(event => event.kind), ['OPENED', 'CLOSED']);
  assert.deepEqual(await (await openForwardStore({filePath})).snapshot(), settled);
  assert.equal(starting.ledger.pending.length, 0);
});

test('rejects a reused order ID and an equal or older batch after reopening', async t => {
  const {filePath} = await tempLedger(t);
  const store = await openForwardStore({filePath, initial,
    getObservation: () => fixture(at('01'), {'7203': 101})});
  await store.queueForwardOrder(order('used'), at('00'), 0);
  await assert.rejects(store.queueForwardOrder(order('used', 'ai_blue'), at('00'), 1), /注文IDが重複/);
  const opened = await store.applyForwardBatch(1);
  let stamp = '2026-11-18T09:01:00.000Z';
  const restored = await openForwardStore({filePath, getObservation: () => fixture(stamp, {'7203': 125})});
  await assert.rejects(restored.queueForwardOrder(order('used', 'ai_blue'), at('02'), 2), /注文IDが重複/);
  await assert.rejects(restored.applyForwardBatch(2), /時系列順/);
  stamp = at('00');
  await assert.rejects(restored.applyForwardBatch(2), /時系列順/);
  assert.deepEqual(await restored.snapshot(), opened);
});

test('persists liquidation and cancelled IDs without drawing on another AI or unallocated funds', async t => {
  const {filePath} = await tempLedger(t);
  let observation = fixture(at('01'), {'7203': 100});
  const store = await openForwardStore({filePath, initial, getObservation: () => observation});
  await store.queueForwardOrder(order('short', 'ai_red', 'OPEN_SHORT'), at('00'), 0);
  await store.applyForwardBatch(1);
  await store.queueForwardOrder(close('cancelled'), at('02'), 2);
  observation = fixture(at('03'), {'7203': 300});
  await store.applyForwardBatch(3);

  const restored = await openForwardStore({filePath});
  const snapshot = await restored.snapshot();
  assert.deepEqual(wallet(snapshot), {initial: 300, cash: 0, equity: 0, position: null, status: 'LIQUIDATED'});
  assert.equal(wallet(snapshot, 'ai_blue').cash, 200);
  assert.equal(snapshot.ledger.unallocated, 500);
  assert.deepEqual(snapshot.ledger.journal.map(event => event.kind), ['OPENED', 'LIQUIDATED', 'CANCELLED']);
  await assert.rejects(restored.queueForwardOrder(order('cancelled', 'ai_blue'), at('04'), 4), /注文IDが重複/);
});

test('serializes concurrent updates and rejects their stale revisions before reading an observation', async t => {
  const {filePath} = await tempLedger(t);
  const first = await openForwardStore({filePath, initial});
  let observations = 0;
  const second = await openForwardStore({filePath, getObservation: () => {
    observations++;
    return fixture(at('01'), {'7203': 100});
  }});

  const [queued, staleOrder, staleBatch] = await Promise.allSettled([
    first.queueForwardOrder(order('first'), at('00'), 0),
    second.queueForwardOrder(order('second', 'ai_blue'), at('00'), 0),
    second.applyForwardBatch(0),
  ]);
  assert.equal(queued.status, 'fulfilled');
  for (const outcome of [staleOrder, staleBatch]) {
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.reason.code, 'FORWARD_STORE_REVISION_CONFLICT');
  }
  assert.equal(observations, 0);
  await assert.rejects(second.applyForwardBatch(), {code: 'FORWARD_STORE_REVISION_CONFLICT'});
  const opened = await second.applyForwardBatch(1);
  assert.equal(observations, 1);
  assert.deepEqual(await first.snapshot(), opened);
  assert.equal(opened.revision, 2);
  assert.deepEqual(opened.ledger.journal.map(event => event.orderId), ['first']);
});

test('a temporary file fsync failure leaves the old bytes and revision intact', async t => {
  const {directory, filePath} = await tempLedger(t);
  const store = await openForwardStore({filePath, initial});
  const previous = await readFile(filePath);
  const sync = await failNextSync(t, filePath, false);
  try {
    await assert.rejects(store.queueForwardOrder(order('retry'), at('00'), 0), {code: 'EIO'});
  } finally {
    sync.restore();
  }
  assert.deepEqual(await readFile(filePath), previous);
  assert.deepEqual(await readdir(directory), ['ledger.json']);
  const restored = await openForwardStore({filePath});
  assert.equal((await restored.snapshot()).revision, 0);
  assert.equal((await restored.queueForwardOrder(order('retry'), at('00'), 0)).revision, 1);
});

test('a directory fsync failure reports uncertainty and exposes the new revision on reopening', async t => {
  const {directory, filePath} = await tempLedger(t);
  const store = await openForwardStore({filePath, initial});
  const sync = await failNextSync(t, filePath, true);
  try {
    await assert.rejects(store.queueForwardOrder(order('replaced'), at('00'), 0),
      {code: 'FORWARD_STORE_COMMIT_UNCERTAIN'});
  } finally {
    sync.restore();
  }
  assert.deepEqual(await readdir(directory), ['ledger.json']);
  const restored = await openForwardStore({filePath});
  const snapshot = await restored.snapshot();
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.ledger.pending.map(o => o.id), ['replaced']);
  await assert.rejects(restored.queueForwardOrder(order('replaced'), at('00'), 0),
    {code: 'FORWARD_STORE_REVISION_CONFLICT'});
  await assert.rejects(restored.queueForwardOrder(order('replaced', 'ai_blue'), at('00'), 1), /注文IDが重複/);
});

test('requires explicit initialization and refuses to replace an initialized ledger', async t => {
  const {directory, filePath} = await tempLedger(t);
  await assert.rejects(openForwardStore({filePath}), {code: 'FORWARD_STORE_UNINITIALIZED'});
  await assert.rejects(openForwardStore({filePath, initial: {...initial, initialMedals: 1.5}}), /メダル/);
  assert.deepEqual(await readdir(directory), []);
  const store = await openForwardStore({filePath, initial});
  await store.queueForwardOrder(order('keep'), at('00'), 0);
  const saved = await readFile(filePath);
  await assert.rejects(openForwardStore({filePath, initial: {...initial, initialMedals: 999}}),
    {code: 'FORWARD_STORE_ALREADY_INITIALIZED'});
  assert.deepEqual(await readFile(filePath), saved);
  assert.equal((await (await openForwardStore({filePath})).snapshot()).revision, 1);
});

test('refuses invalid JSON, schema changes, non-finite numbers, bad checksums and oversized files', async t => {
  const {filePath} = await tempLedger(t);
  await openForwardStore({filePath, initial});
  const original = await readFile(filePath, 'utf8');
  const invalid = JSON.parse(original);
  invalid.ledger.wallets.ai_red.cash = 1e99;
  const extremeCash = encodeTestRecord(invalid);
  const infiniteCash = extremeCash.replace('1e+99', '1e999');
  invalid.ledger.wallets.ai_red.cash = 300;
  invalid.ledger.extra = true;
  for (const content of [
    '{"version":',
    original.replace('"cash":300', '"cash":301'),
    original.replace('"revision":0', '"revision":0,"revision":0'),
    extremeCash,
    infiniteCash,
    encodeTestRecord(invalid),
  ]) {
    await writeFile(filePath, content);
    await assert.rejects(openForwardStore({filePath, initial}), {code: 'FORWARD_STORE_CORRUPT'});
    assert.equal(await readFile(filePath, 'utf8'), content);
  }
  await truncate(filePath, 4 * 1024 * 1024 + 1);
  await assert.rejects(openForwardStore({filePath}), {code: 'FORWARD_STORE_CORRUPT'});
});

test('refuses symlinks, hardlinks and directories at the ledger path', async t => {
  const {directory, filePath} = await tempLedger(t);
  const other = join(directory, 'other.json');
  await openForwardStore({filePath: other, initial});
  const previous = await readFile(other);

  await symlink(other, filePath);
  await assert.rejects(openForwardStore({filePath, initial}), {code: 'FORWARD_STORE_CORRUPT'});
  await unlink(filePath);
  assert.deepEqual(await readFile(other), previous);
  await symlink(join(directory, 'not-created.json'), filePath);
  await assert.rejects(openForwardStore({filePath, initial}), {code: 'FORWARD_STORE_CORRUPT'});
  await unlink(filePath);
  await link(other, filePath);
  await assert.rejects(openForwardStore({filePath, initial}), {code: 'FORWARD_STORE_CORRUPT'});
  await unlink(filePath);
  await mkdir(filePath);
  await assert.rejects(openForwardStore({filePath, initial}), {code: 'FORWARD_STORE_CORRUPT'});
});

test('refuses an occupied or stale cross-process lock without clearing it', async t => {
  const {directory, filePath} = await tempLedger(t);
  const store = await openForwardStore({filePath, initial});
  await mkdir(filePath + '.lock');
  await assert.rejects(openForwardStore({filePath}), {code: 'FORWARD_STORE_LOCKED'});
  await assert.rejects(store.queueForwardOrder(order('held'), at('00'), 0), {code: 'FORWARD_STORE_LOCKED'});
  assert.deepEqual((await readdir(directory)).sort(), ['ledger.json', 'ledger.json.lock']);
  await rmdir(filePath + '.lock');
  assert.equal((await store.snapshot()).revision, 0);
});

test('keeps pending orders and the saved revision when observations are unavailable or invalid', async t => {
  const {filePath} = await tempLedger(t);
  const store = await openForwardStore({filePath, initial});
  const queued = await store.queueForwardOrder(order('pending'), at('00'), 0);
  await assert.rejects(store.applyForwardBatch(1), {code: 'FORWARD_STORE_NO_OBSERVATION'});
  let observation;
  const restored = await openForwardStore({filePath, getObservation: () => observation});
  await assert.rejects(restored.applyForwardBatch(1), {code: 'FORWARD_STORE_NO_OBSERVATION'});
  for (const price of [NaN, Infinity, 1e99]) {
    observation = fixture(at('01'), {'7203': price});
    await assert.rejects(restored.applyForwardBatch(1), /価格/);
  }
  assert.deepEqual(await restored.snapshot(), queued);
});

test('market store rejects re-ingested trades after restart and checks saved execution chronology', async t => {
  const {filePath} = await tempLedger(t);
  const stamp = min => `2026-11-19T01:${min}:00Z`;
  const sourceId = 'MOCK_PROVIDER_NOT_LIVE';
  let quote = {
    symbol: '7203', price: 100, tradeAt: stamp('01'), publishedAt: stamp('02'),
    ingestedAt: stamp('03'), proof: TEST_FIXTURE_SOURCE,
  };
  let observedAt = stamp('04');
  const getObservation = () => ({sourceId, observedAt, quotes: {'7203': quote}});
  const clock = () => Date.parse(observedAt);
  const providerPolicy = {
    enabled: true, usageAuthorized: true, sourceId, maxAgeMs: 15 * 60_000,
    verifyQuote: observation => observation.sourceId === sourceId &&
      Object.entries(quote).every(([key, value]) => observation[key] === value),
    marketStatusAt: () => 'OPEN',
  };
  const store = await openForwardStore({
    filePath, initial: {...initial, mode: MARKET_PAPER_MODE}, getObservation, providerPolicy, clock,
  });
  await store.queueForwardOrder(order('short', 'ai_red', 'OPEN_SHORT'), stamp('00'), 0);
  const opened = await store.applyForwardBatch(1);
  assert.equal(opened.ledger.lastTradeAt['7203'], quote.tradeAt);
  assert.equal(opened.ledger.journal[0].ingestedAt, stamp('03'));
  const disabled = await openForwardStore({filePath, getObservation, clock});
  const restored = await openForwardStore({filePath, getObservation, providerPolicy, clock});
  assert.deepEqual(await restored.snapshot(), opened);
  await assert.rejects(restored.applyForwardBatch(2), /時系列/);
  observedAt = stamp('05');
  await assert.rejects(disabled.applyForwardBatch(2), /利用許可/);
  assert.deepEqual(await restored.snapshot(), opened);

  // A later ingestion can carry a repeated trade or an out-of-order correction.
  quote = {...quote, price: 300, ingestedAt: observedAt};
  const replayed = await restored.applyForwardBatch(2);
  assert.equal(wallet(replayed).position.lastPrice, 100);
  assert.deepEqual(replayed.ledger.journal, opened.ledger.journal);
  observedAt = stamp('06');
  quote = {...quote, tradeAt: stamp('00'), ingestedAt: observedAt};
  const older = await restored.applyForwardBatch(3);
  assert.equal(wallet(older).position.lastPrice, 100);
  assert.deepEqual(older.ledger.lastTradeAt, opened.ledger.lastTradeAt);

  observedAt = stamp('07');
  quote = {...quote, tradeAt: observedAt, publishedAt: observedAt, ingestedAt: observedAt};
  const liquidated = await restored.applyForwardBatch(4);
  assert.equal(wallet(liquidated).status, 'LIQUIDATED');
  assert.equal(liquidated.ledger.journal.at(-1).kind, 'LIQUIDATED');
  assert.equal(liquidated.ledger.journal.at(-1).tradeAt, stamp('07'));
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  saved.ledger.journal[0].tradeAt = saved.ledger.journal[0].receivedAt;
  await writeFile(filePath, encodeTestRecord(saved));
  await assert.rejects(openForwardStore({filePath}), {code: 'FORWARD_STORE_CORRUPT'});
});

test('appends generations to a traded legacy ledger and preserves old trades on further edits', async t => {
  const {filePath} = await tempLedger(t);
  let observation = fixture(at('01'), {'7203':100});
  const store = await openForwardStore({filePath, initial, getObservation:() => observation});
  await store.queueForwardOrder(order('legacy_position'), at('00'), 0);
  await store.applyForwardBatch(1);
  const legacy = await store.queueForwardOrder(order('legacy_pending', 'ai_blue'), at('02'), 2);
  const add = (aiId, expectedRevision, model = appearance()) => saveForwardAppearanceGeneration({
    filePath, aiId, appearance:model, medals:100, expectedRevision,
  });
  const before = await readFile(filePath);
  await assert.rejects(add('ai_first', null), {code:'FORWARD_STORE_REVISION_CONFLICT'});
  assert.deepEqual(await readFile(filePath), before);
  const first = await add('ai_first', 3);
  assert.equal(first.ledger.initialMedals, legacy.ledger.initialMedals);
  assert.equal(first.ledger.unallocated, legacy.ledger.unallocated - 100);
  for (const aiId of Object.keys(legacy.ledger.wallets)) {
    assert.deepEqual(first.ledger.wallets[aiId], legacy.ledger.wallets[aiId]);
  }
  assert.deepEqual(first.ledger.pending, legacy.ledger.pending);
  assert.deepEqual(first.ledger.journal, legacy.ledger.journal);
  assert.equal(first.ledger.lastBatchAt, legacy.ledger.lastBatchAt);

  await store.queueForwardOrder(order('first_position', 'ai_first'), at('02'), 4);
  observation = fixture(at('03'), {'7203':110});
  const opened = await store.applyForwardBatch(5);
  const second = await add('ai_second', 6, appearance('long'));
  assert.deepEqual(second.ledger.appearanceGenerations[0], first.ledger.appearanceGenerations[0]);
  assert.deepEqual(second.ledger.wallets.ai_first, opened.ledger.wallets.ai_first);
  assert.equal(second.ledger.wallets.ai_first.position.modelHash, first.ledger.wallets.ai_first.modelHash);
  assert.deepEqual(second.ledger.journal, opened.ledger.journal);
  const reverted = await add('ai_third', 7);
  assert.equal(reverted.ledger.appearanceGenerations.length, 3);
  assert.equal(reverted.ledger.wallets.ai_third.modelHash, first.ledger.wallets.ai_first.modelHash);
  assert.deepEqual(reverted.ledger.wallets.ai_first, opened.ledger.wallets.ai_first);
  assert.deepEqual(await (await openForwardStore({filePath})).snapshot(), {revision:8, ledger:reverted.ledger});

  const tampered = JSON.parse(await readFile(filePath, 'utf8'));
  tampered.ledger.appearanceGenerations[1].model.slow_window++;
  await writeFile(filePath, encodeTestRecord(tampered));
  await assert.rejects(openForwardStore({filePath}), {code:'FORWARD_STORE_CORRUPT'});
});

test('racing first allocations create one ledger and the wallet count limit preserves all balances', async t => {
  const {directory, filePath} = await tempLedger(t);
  const create = aiId => saveForwardAppearanceGeneration({
    filePath, aiId, appearance:appearance(), medals:100, expectedRevision:null,
  });
  const outcomes = await Promise.allSettled([create('ai_one'), create('ai_two')]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'FORWARD_STORE_REVISION_CONFLICT');
  const root = await (await openForwardStore({filePath})).snapshot();
  assert.equal(root.revision, 0);
  assert.equal(root.ledger.unallocated, 9900);
  assert.equal(Object.keys(root.ledger.wallets).length, 1);

  const cappedFile = join(directory, 'capped.json');
  const capped = await openForwardStore({filePath:cappedFile, initial:{initialMedals:1000,
    allocations:Array.from({length:50}, (_, i) => ({id:`ai_${i}`, modelHash:'b'.repeat(64), medals:1})),
  }});
  const cappedBytes = await readFile(cappedFile);
  await assert.rejects(saveForwardAppearanceGeneration({filePath:cappedFile, aiId:'ai_over',
    appearance:appearance(), medals:1, expectedRevision:0,
  }), {code:'FORWARD_STORE_ALLOCATION_REJECTED', message:/上限/});
  assert.deepEqual(await readFile(cappedFile), cappedBytes);
  assert.equal((await capped.snapshot()).ledger.unallocated, 950);
});

test('fsync failures cannot leave a model without its wallet or debit the same allocation twice', async t => {
  const {directory, filePath} = await tempLedger(t);
  const store = await openForwardStore({filePath, initial});
  const previous = await readFile(filePath);
  const save = expectedRevision => saveForwardAppearanceGeneration({
    filePath, aiId:'ai_new', appearance:appearance(), medals:300, expectedRevision,
  });
  const tempSync = await failNextSync(t, filePath, false);
  try {
    await assert.rejects(save(0), {code:'EIO'});
  } finally {tempSync.restore();}
  assert.deepEqual(await readFile(filePath), previous);
  assert.equal((await store.snapshot()).ledger.appearanceGenerations, undefined);
  const dirSync = await failNextSync(t, filePath, true);
  try {
    await assert.rejects(save(0), {code:'FORWARD_STORE_COMMIT_UNCERTAIN'});
  } finally {dirSync.restore();}
  assert.deepEqual(await readdir(directory), ['ledger.json']);
  const restored = await (await openForwardStore({filePath})).snapshot();
  assert.equal(restored.revision, 1);
  assert.equal(restored.ledger.appearanceGenerations[0].aiId, 'ai_new');
  assert.equal(restored.ledger.wallets.ai_new.cash, 300);
  assert.equal(restored.ledger.unallocated, 200);
  await assert.rejects(save(0), {code:'FORWARD_STORE_REVISION_CONFLICT'});
  assert.deepEqual(await save(1), {...restored, created:false});
});
