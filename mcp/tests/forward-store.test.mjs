import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, symlink, truncate, unlink, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectForwardWallet} from '../../game_runtime/forward-paper.mjs';
import {openForwardStore} from '../../game_runtime/forward-store.mjs';

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
