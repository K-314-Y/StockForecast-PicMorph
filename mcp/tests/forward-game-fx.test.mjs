import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, createHmac} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {initializeForwardGameFxAudit, openAnchoredForwardGameFx, openForwardGameFx} from '../../game_runtime/forward-game-fx.mjs';
import {createForwardMarketAdapter} from '../../game_runtime/forward-market-adapter.mjs';
import {MARKET_PAPER_MODE, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE} from '../../game_runtime/forward-market-guard.mjs';
import {openForwardMockLifecycle} from '../../game_runtime/forward-mock-lifecycle.mjs';
import {deriveForwardCompanionModel} from '../../game_runtime/forward-model.mjs';
import {openForwardPredictor} from '../../game_runtime/forward-predict.mjs';
import {createForwardRecordReader} from '../../game_runtime/forward-records.mjs';
import {openForwardStore, saveForwardGeneration} from '../../game_runtime/forward-store.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

const exec = promisify(execFile);
const minute = 60_000;
const issue = Date.parse('2030-01-07T01:00:00.000Z');
const entry = issue + 5 * minute;
const target = issue + 10 * minute;
const iso = time => new Date(time).toISOString();
const symbol = 'FAKE';
const fixtureKey = 'public P9b fixture key';
const signingKey = Buffer.alloc(32, 17); // Public test fixture, production injects a separate server key.
const adapterConfig = {sourceId:MOCK_MARKET_SOURCE, licenseRef:'P9b MOCK_NONLIVE fixture',
  observationIntervalMs:5 * minute, maxAgeMs:10 * minute, maxPublicationDelayMs:minute};
const models = {
  ai_trend:deriveForwardCompanionModel({approach:'trend', risk_percent:35}),
  ai_revert:deriveForwardCompanionModel({approach:'reversion', risk_percent:35}),
};
const sign = raw => createHmac('sha256', fixtureKey).update(raw).digest('hex');
function trade(time, price, extra = {}) {
  const raw = JSON.stringify({sourceId:MOCK_MARKET_SOURCE, market:'XTKS', valueKind:'TRADE',
    symbol, price, tradeAt:iso(time), publishedAt:iso(time), ...extra});
  return {raw, proof:sign(raw)};
}
const reference = trade(issue - minute, 100);
const scenario = (time, price) => trade(time, price, {referenceProof:reference.proof});
const fixedDraw = byte => () => Buffer.alloc(32, byte);

async function setup(t, {root, accountId = 'alice', margin = 100, deriveRoundBytes = fixedDraw(4), anchored = false} = {}) {
  if (!root) {
    root = await mkdtemp('/tmp/forward-game-fx-');
    t.after(() => rm(root, {recursive:true, force:true}));
  }
  const journalDirectory = join(root, 'fx');
  const scope = join(root, accountId);
  const directory = join(scope, 'forecasts');
  const walletFile = join(scope, 'wallet.json');
  await mkdir(directory, {recursive:true});
  await mkdir(journalDirectory, {recursive:true, mode:0o700});
  const state = {now:issue, times:[], rows:[], reads:0, allowed:true};
  const marketAdapter = createForwardMarketAdapter({...adapterConfig,
    clock:() => state.times.shift() ?? state.now, marketStatusAt:() => 'OPEN',
    verifyUsage:() => state.allowed,
    readBatch:() => { state.reads++; return state.rows; },
    verifyRecord:({raw, proof}) => proof === sign(raw) ? JSON.parse(raw) : null,
  });
  await openForwardStore({filePath:walletFile, marketAdapter, initial:{mode:MOCK_MARKET_PAPER_MODE,
    initialMedals:1000, allocations:[{id:'control', modelHash:'c'.repeat(64), medals:200}]}});
  let revision = 0;
  for (const [aiId, generation] of Object.entries(models)) {
    ({revision} = await saveForwardGeneration({filePath:walletFile, aiId, generation, medals:300,
      expectedRevision:revision}));
  }
  const options = {walletFile, directory, marketAdapter, reference, margin, leverage:2};
  const lifecycle = await openForwardMockLifecycle(options);
  const config = {journalDirectory, signingKey, accountId, recordSource:lifecycle.recordSource,
    symbol, targetAt:iso(target), deriveRoundBytes};
  if (anchored) {
    config.auditAnchorDirectory = join(root, 'independent-audit');
    await mkdir(config.auditAnchorDirectory, {mode:0o700});
    await initializeForwardGameFxAudit(config);
  }
  const fx = await (anchored ? openAnchoredForwardGameFx : openForwardGameFx)(config);

  async function freeze(aiId = 'ai_trend', overrides = {}) {
    const {model_version, modelHash} = models[aiId];
    const {forecast} = await lifecycle.freeze({aiId, model_version, modelHash, symbol, targetAt:iso(target),
      sourceMode:'TEST_ONLY', probabilities:{UP:.1, FLAT:.2, DOWN:.7}, ...overrides});
    return forecast.forecastId;
  }
  async function batch(time, price) {
    state.now = time;
    state.rows = [scenario(time, price)];
    return lifecycle.applyBatch();
  }
  async function openPosition() {
    const id = await freeze();
    await lifecycle.reserveOpen(id);
    await batch(entry, 100);
    return id;
  }
  async function closePosition(id, price = 125) {
    await lifecycle.reserveClose(id);
    await batch(target, price);
    return lifecycle.score(id);
  }

  return {root, config, options, state, lifecycle, fx, freeze, batch, openPosition, closePosition};
}

async function journalPaths(fixture, kind) {
  const {journalDirectory, auditAnchorDirectory} = fixture.config;
  const prefix = auditAnchorDirectory ? 'p9c-journal-' : 'p9b-';
  return (await readdir(journalDirectory))
    .filter(name => new RegExp('^' + prefix + kind + '-[a-f0-9]{64}\\.json$').test(name))
    .map(name => join(journalDirectory, name));
}

async function p4Bytes({options}) {
  const files = [options.walletFile, ...(await readdir(options.directory)).sort().map(name => join(options.directory, name))];
  return Promise.all(files.map(async file => [file, await readFile(file)]));
}

async function runChild(fixture, body, now, setupSource = '') {
  const {options, config} = fixture;
  const url = name => new URL('../../game_runtime/' + name + '.mjs', import.meta.url).href;
  const {marketAdapter, ...lifecycleConfig} = options;
  const {recordSource, deriveRoundBytes, ...fxConfig} = config;
  return exec(process.execPath, ['--input-type=module', '-e', `
    import {createHmac} from 'node:crypto';
    import {openForwardMockLifecycle} from ${JSON.stringify(url('forward-mock-lifecycle'))};
    import {createForwardMarketAdapter} from ${JSON.stringify(url('forward-market-adapter'))};
    ${setupSource}
    const {openForwardGameFx} = await import(${JSON.stringify(url('forward-game-fx'))});
    let stamps = 0;
    const marketAdapter = createForwardMarketAdapter({... ${JSON.stringify(adapterConfig)},
      clock:() => { stamps++; return (${now}); },
      verifyUsage:() => true, marketStatusAt:() => 'OPEN',
      readBatch:() => { throw Error('Unexpected batch read'); },
      verifyRecord:({raw,proof}) => proof === createHmac('sha256', ${JSON.stringify(fixtureKey)})
        .update(raw).digest('hex') ? JSON.parse(raw) : null,
    });
    const {recordSource} = await openForwardMockLifecycle({... ${JSON.stringify(lifecycleConfig)}, marketAdapter});
    const fx = await openForwardGameFx({... ${JSON.stringify({...fxConfig, signingKey:undefined})}, recordSource,
      signingKey:Buffer.alloc(32, 17), deriveRoundBytes:() => Buffer.alloc(32, 4)});
    ${body}
  `], {timeout:10_000});
}

test('P9b uses one round rate across P7 and P4 models and preserves every P4 byte and score', async t => {
  const f = await setup(t);
  const {options, state, config, fx, lifecycle} = f;
  const predictor = await openForwardPredictor({...options, clock:() => state.now,
    symbol, targetAt:iso(target), readHistory:() => [
      ...Array.from({length:24}, (_, i) => trade(issue - (25 - i) * minute, 76 + i)), reference,
    ]});
  const trend = await predictor.freeze({aiId:'ai_trend'});
  assert.ok(trend.forecast.provenance.mockReferenceSha256);
  const up = trend.forecast.forecastId;
  const down = await f.freeze('ai_revert');
  const committed = await fx.commitRound();
  assert.equal(committed.basisPoints, undefined);
  assert.equal(committed.nonce, undefined);
  assert.equal(committed.confirmedAt, iso(issue));

  for (const id of [up, down]) await lifecycle.reserveOpen(id);
  await f.batch(entry, 100);
  const beforeReservations = await p4Bytes(f);
  const peer = await openForwardGameFx(config);
  const [reservation, duplicate] = await Promise.all([fx.reserve(up), peer.reserve(up)]);
  assert.deepEqual(reservation, duplicate);
  assert.equal(reservation.reservedMargin, 100);
  await fx.reserve(down);
  assert.deepEqual(await p4Bytes(f), beforeReservations);
  await assert.rejects(fx.settle(up), /requires a verified P4 settlement and score/);

  for (const id of [up, down]) await lifecycle.reserveClose(id);
  const closed = await f.batch(target, 149.5);
  await assert.rejects(fx.settle(up), /requires a verified P4 settlement and score/);
  const scores = await Promise.all([lifecycle.score(up), lifecycle.score(down)]);
  const beforeSettlement = await p4Bytes(f);
  const [long, replay, short] = await Promise.all([fx.settle(up), peer.settle(up), fx.settle(down)]);
  assert.deepEqual(replay, long);
  for (const settled of [long, short]) {
    assert.equal(settled.basisPoints, 10200);
    assert.equal(settled.commitment, committed.commitment);
    assert.equal(settled.reservedMargin, 100);
    const {commitment, confirmedAt, ...binding} = committed;
    const proof = createHash('sha256').update(JSON.stringify([
      'P9b FX commitment/v1', binding, settled.basisPoints, settled.nonce,
    ])).digest('hex');
    assert.equal(commitment, proof);
  }
  assert.deepEqual([long.rawPnl, long.gamePnl, long.virtualProceeds], [99, 101, 201]);
  assert.deepEqual([short.rawPnl, short.gamePnl, short.virtualProceeds], [-99, -100, 0]);
  assert.equal(scores[0].score.directionCorrect, true);
  assert.equal(scores[1].score.directionCorrect, false);
  assert.ok(Math.abs(scores[1].score.brier - 1.34) < 1e-12);
  assert.deepEqual((await lifecycle.read(up)).outcome, scores[0]);
  assert.deepEqual((await lifecycle.read(down)).outcome, scores[1]);
  assert.deepEqual(await lifecycle.snapshot(), closed);
  assert.deepEqual(await p4Bytes(f), beforeSettlement);
  assert.equal(state.reads, 2);
  assert.equal((await journalPaths(f, 'settlement')).length, 2);

  const {stdout} = await runChild(f, `console.log(JSON.stringify(await fx.settle(${JSON.stringify(up)})));`, target);
  assert.deepEqual(JSON.parse(stdout), long);
  assert.deepEqual(await p4Bytes(f), beforeSettlement);
});

test('P9b ceiling, floor, unchanged principal, and symmetric rounding operate on realized PnL only', async t => {
  for (const [draw, rate, price, raw, adjusted] of [
    [0, 9800, 149.5, -99, -97],
    [1, 9900, 50.5, 99, 98],
    [2, 10000, 106.25, -12.5, -13],
    [3, 10100, 100, 0, 0],
    [4, 10200, 112.5, -25, -26],
  ]) {
    const f = await setup(t, {deriveRoundBytes:fixedDraw(draw)});
    await f.fx.commitRound();
    const id = await f.openPosition();
    await f.fx.reserve(id);
    await f.closePosition(id, price);
    const settlement = await f.fx.settle(id);
    assert.deepEqual([settlement.basisPoints, settlement.rawPnl, settlement.gamePnl, settlement.virtualProceeds],
      [rate, raw, adjusted, 100 + adjusted]);
  }
});

test('P9b keyed draw is stable and the injected byte source rejects invalid or biased draws', async t => {
  const f = await setup(t);
  const live = await openForwardGameFx({...f.config, deriveRoundBytes:undefined});
  const peer = await openForwardGameFx({...f.config, deriveRoundBytes:undefined});
  const [left, right] = await Promise.all([live.commitRound(), peer.commitRound()]);
  assert.deepEqual(left, right);
  const id = await f.openPosition();
  await live.reserve(id);
  await f.closePosition(id);
  assert.ok([9800, 9900, 10000, 10100, 10200].includes((await peer.settle(id)).basisPoints));

  const g = await setup(t, {deriveRoundBytes:() => Buffer.alloc(1)});
  await assert.rejects(g.fx.commitRound(), /Invalid server FX random bytes/);
  assert.equal((await journalPaths(g, 'round')).length, 0);
  const calls = [];
  const injected = await openForwardGameFx({...g.config, deriveRoundBytes:(roundId, counter) => {
    calls.push([roundId, counter]);
    return Buffer.alloc(32, counter === 0 ? 255 : 4);
  }});
  const committed = await injected.commitRound();
  assert.deepEqual(calls, [[committed.roundId, 0], [committed.roundId, 1]]);
  assert.deepEqual(await injected.commitRound(), committed);
  assert.equal(calls.length, 2);
});

test('P9b refuses unverified arguments, conflicting reference, source, mode and target', async t => {
  const f = await setup(t);
  const {fx, options, config, state} = f;
  await assert.rejects(fx.commitRound({basisPoints:10200}), /server-owned/);
  await assert.rejects(fx.reserve('a'.repeat(64), {margin:900}), /verified wallet margin/);
  await assert.rejects(fx.settle('a'.repeat(64), 9800), /verified P4 results/);
  await assert.rejects(openForwardGameFx({...config, recordSource:{...config.recordSource}}), /signed MOCK_NONLIVE/);
  await assert.rejects(openForwardGameFx({...config, signingKey:Buffer.alloc(32, 18)}), /authentication/);

  const otherReference = trade(issue - minute, 100, {fixture:'different'});
  const other = await openForwardMockLifecycle({...options, reference:otherReference});
  const wrongFx = await openForwardGameFx({...config, recordSource:other.recordSource});
  await fx.commitRound();
  await assert.rejects(wrongFx.commitRound(), /reference or commitment mismatch/);
  const nonMock = await f.freeze('ai_trend', {sourceMode:'MARKET_UNCONNECTED'});
  await assert.rejects(fx.reserve(nonMock), /forecast source/);
  const future = await openForwardGameFx({...config, targetAt:iso(target + minute)});
  await future.commitRound();
  const rightRound = await f.openPosition();
  await assert.rejects(future.reserve(rightRound), /forecast source, reference or round mismatch/);

  const external = createForwardMarketAdapter({...adapterConfig, sourceId:'OTHER_MARKET',
    clock:() => state.now, verifyUsage:() => true, marketStatusAt:() => 'OPEN',
    readBatch:() => assert.fail('Unexpected batch'), verifyRecord:() => null,
  });
  await assert.rejects(openForwardMockLifecycle({...options, marketAdapter:external}), /Explicit MOCK_NONLIVE/);
  const otherWallet = join(f.root, 'incompatible.json');
  await openForwardStore({filePath:otherWallet, marketAdapter:external,
    initial:{mode:MARKET_PAPER_MODE, initialMedals:1, allocations:[{id:'ai', modelHash:'a'.repeat(64), medals:1}]}});
  await assert.rejects(openForwardMockLifecycle({...options, walletFile:otherWallet}), /市場観測元/);
  state.allowed = false;
  await assert.rejects(fx.reserve(rightRound), /利用許可/);
});

test('P9b scopes identical forecast IDs and margins to distinct account wallets', async t => {
  const a = await setup(t);
  const b = await setup(t, {root:a.root, accountId:'bob', margin:80, deriveRoundBytes:() => assert.fail('Rerolled')});
  const committed = await a.fx.commitRound();
  assert.deepEqual(await b.fx.commitRound(), committed);
  await assert.rejects(openForwardGameFx({...a.config, accountId:'bob'}), /account binding/);
  const wrongSource = await openForwardMockLifecycle({...b.options, directory:a.options.directory});
  await assert.rejects(openForwardGameFx({...b.config, recordSource:wrongSource.recordSource}), /account binding/);
  const aId = await a.openPosition();
  await a.fx.reserve(aId);
  await assert.rejects(b.fx.settle(aId), /No confirmed MOCK_NONLIVE forecast in this account/);
  const bId = await b.openPosition();
  assert.equal(aId, bId);
  await b.fx.reserve(bId);
  await a.closePosition(aId);
  await b.closePosition(bId);
  const [left, right] = await Promise.all([a.fx.settle(aId), b.fx.settle(bId)]);
  assert.equal(left.accountId, 'alice');
  assert.equal(right.accountId, 'bob');
  assert.equal(left.reservedMargin, 100);
  assert.equal(right.reservedMargin, 80);
  assert.equal(left.basisPoints, right.basisPoints);
  assert.equal((await journalPaths(a, 'settlement')).length, 2);
});

test('P9b never reserves overspending or a FLAT record', async t => {
  const f = await setup(t, {margin:301});
  await f.fx.commitRound();
  const flat = await f.freeze('ai_revert', {probabilities:{UP:.1, FLAT:.8, DOWN:.1}});
  assert.deepEqual(await f.lifecycle.reserveOpen(flat), {action:'NO_TRADE'});
  await assert.rejects(f.fx.reserve(flat), /opened position/);
  const other = await f.freeze();
  await assert.rejects(f.lifecycle.reserveOpen(other), /倍率または資金/);
  await assert.rejects(f.fx.reserve(other), /opened position/);
  assert.equal((await journalPaths(f, 'reservation')).length, 0);
});

test('P9b never credits a liquidated position or charges another wallet', async t => {
  const f = await setup(t);
  await f.fx.commitRound();
  const id = await f.openPosition();
  await f.fx.reserve(id);
  const before = await f.lifecycle.snapshot();
  await f.lifecycle.reserveClose(id);
  const closed = await f.batch(target, 251);
  assert.equal(closed.ledger.wallets.ai_trend.status, 'LIQUIDATED');
  assert.equal(closed.ledger.wallets.ai_trend.cash, 0);
  assert.deepEqual(closed.ledger.wallets.ai_revert, before.ledger.wallets.ai_revert);
  assert.deepEqual(closed.ledger.wallets.control, before.ledger.wallets.control);
  assert.equal(closed.ledger.unallocated, before.ledger.unallocated);
  assert.equal((await f.lifecycle.score(id)).status, 'PENDING');
  await assert.rejects(f.fx.settle(id), /requires a verified P4 settlement and score/);
  assert.equal((await journalPaths(f, 'settlement')).length, 0);
  assert.deepEqual(await f.lifecycle.snapshot(), closed);
});

test('P9b rejects a late commitment or reservation and does not retrofit an old scored receipt', async t => {
  const f = await setup(t);
  const {fx, state, config} = f;
  const id = await f.openPosition();
  state.now = target;
  await assert.rejects(fx.commitRound(), /cutoff/);
  assert.equal((await journalPaths(f, 'round')).length, 0);
  state.now = entry;
  await fx.commitRound();
  state.now = target;
  await assert.rejects(fx.reserve(id), /cutoff/);
  assert.equal((await journalPaths(f, 'reservation')).length, 0);
  state.now = entry;
  await f.closePosition(id);
  const restarted = await openForwardGameFx(config);
  await assert.rejects(restarted.reserve(id), /after outcome time/);
  await assert.rejects(restarted.settle(id), /reservation confirmed before cutoff/);
  assert.equal((await journalPaths(f, 'settlement')).length, 0);
});

test('P9b fails closed when either round or open-margin publication crosses cutoff', async t => {
  for (const kind of ['round', 'reservation']) {
    const f = await setup(t);
    const {fx, state, config} = f;
    let id;
    if (kind === 'reservation') {
      await fx.commitRound();
      id = await f.openPosition();
    }
    const invoke = instance => kind === 'round' ? instance.commitRound() : instance.reserve(id);
    state.times.push(target - 1, target);
    await assert.rejects(invoke(fx), /cutoff/);
    assert.equal((await journalPaths(f, kind)).length, 1);
    assert.equal((await journalPaths(f, kind + '-confirmed')).length, 0);
    state.now = target;
    const restarted = await openForwardGameFx({...config, deriveRoundBytes:() => assert.fail('Rerolled')});
    await assert.rejects(invoke(restarted), /cutoff/);
    if (kind === 'reservation') await assert.rejects(restarted.settle(id), /reservation confirmed before cutoff/);
  }
});

test('P9b recovers the original round after a process stops immediately after linking its synced draft', async t => {
  const f = await setup(t);
  const crashAfterLink = `
    const fs = (await import('node:fs/promises')).default;
    const {syncBuiltinESMExports} = await import('node:module');
    const originalLink = fs.link;
    fs.link = async (source, destination) => {
      await originalLink(source, destination);
      if (destination.includes('/p9b-round-')) process.exit(0);
    };
    syncBuiltinESMExports();
  `;
  await runChild(f, 'await fx.commitRound(); process.exit(42);', issue, crashAfterLink);
  const [draft] = await journalPaths(f, 'round');
  const before = await readFile(draft);
  assert.ok((await readdir(f.config.journalDirectory)).some(name => name.endsWith('.tmp')));
  assert.equal((await journalPaths(f, 'round-confirmed')).length, 0);
  const restarted = await openForwardGameFx({...f.config, deriveRoundBytes:() => assert.fail('Rerolled')});
  const proof = await restarted.commitRound();
  assert.equal(proof.commitment, JSON.parse(before).payload.commitment);
  assert.deepEqual(await readFile(draft), before);
  const id = await f.openPosition();
  await restarted.reserve(id);
  await f.closePosition(id);
  assert.equal((await restarted.settle(id)).basisPoints, 10200);
});

test('P9b rejects unconfirmed reservations after a process stops before proof and after P4 scores', async t => {
  const f = await setup(t);
  await f.fx.commitRound();
  const id = await f.openPosition();
  await runChild(f, `await fx.reserve(${JSON.stringify(id)}); process.exit(42);`,
    `stamps === 2 ? process.exit(0) : ${entry}`);
  assert.equal((await journalPaths(f, 'reservation')).length, 1);
  assert.equal((await journalPaths(f, 'reservation-confirmed')).length, 0);
  await f.closePosition(id);
  const restarted = await openForwardGameFx(f.config);
  await assert.rejects(restarted.reserve(id), /after outcome time/);
  await assert.rejects(restarted.settle(id), /reservation confirmed before cutoff/);
});

test('P9b converges on a cross-process commitment race without replacing either durable record', async t => {
  const f = await setup(t);
  const intercept = `
    const fs = (await import('node:fs/promises')).default;
    const {syncBuiltinESMExports} = await import('node:module');
    const originalLink = fs.link;
    fs.link = async (source, destination) => {
      if (destination.includes('/p9b-round-') && !destination.includes('/p9b-round-confirmed-')) {
        await fs.writeFile(${JSON.stringify(join(f.root, 'child-staged'))}, '');
        while (true) {
          try { await fs.access(${JSON.stringify(join(f.root, 'release-child'))}); break; }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }
      }
      await originalLink(source, destination);
    };
    syncBuiltinESMExports();
  `;
  const child = runChild(f, 'console.log(JSON.stringify(await fx.commitRound()));', issue, intercept);
  const release = join(f.root, 'release-child');
  let waiting = true;
  let parent;
  try {
    await Promise.race([
      child.then(() => assert.fail('Child did not wait at link')),
      (async () => {
        while (waiting && !(await readdir(f.root)).includes('child-staged')) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      })(),
    ]);
    parent = await f.fx.commitRound();
  } finally {
    waiting = false;
    await writeFile(release, '');
    const {stdout} = await child;
    assert.deepEqual(JSON.parse(stdout), parent);
  }
  assert.equal((await journalPaths(f, 'round')).length, 1);
  assert.equal((await journalPaths(f, 'round-confirmed')).length, 1);
});

test('P9b rejects changed and transplanted proof records and P4 receipt or fill edits', async t => {
  const f = await setup(t);
  await f.fx.commitRound();
  const id = await f.openPosition();
  await f.fx.reserve(id);
  await f.closePosition(id);
  const settled = await f.fx.settle(id);
  for (const [kind, field, value] of [
    ['round', 'basisPoints', 9800],
    ['round-confirmed', 'confirmedAt', iso(target)],
    ['reservation', 'forecastSha256', '0'.repeat(64)],
    ['reservation-confirmed', 'confirmedAt', iso(target)],
    ['settlement', 'gamePnl', 1000],
  ]) {
    const [path] = await journalPaths(f, kind);
    const original = await readFile(path);
    const edited = JSON.parse(original);
    edited.payload[field] = value;
    edited.mac = createHash('sha256').update(JSON.stringify(edited.payload)).digest('hex');
    await writeFile(path, JSON.stringify(edited));
    await assert.rejects(f.fx.settle(id), /journal authentication/);
    await writeFile(path, original);
  }
  const [round] = await journalPaths(f, 'round');
  const [proof] = await journalPaths(f, 'round-confirmed');
  const confirmed = await readFile(proof);
  await writeFile(proof, await readFile(round));
  await assert.rejects(f.fx.commitRound(), /journal authentication/);
  await writeFile(proof, confirmed);
  const draft = await readFile(round);
  await unlink(round);
  await assert.rejects(f.fx.commitRound(), /cutoff proof/);
  assert.deepEqual(await journalPaths(f, 'round'), []);
  await writeFile(round, draft);

  const receipt = join(f.options.directory, id + '.receipt.json');
  const receiptBytes = await readFile(receipt);
  await writeFile(receipt, '{}');
  await assert.rejects(f.fx.settle(id), {code:'FORWARD_FORECAST_CORRUPT'});
  await writeFile(receipt, receiptBytes);

  const walletBytes = await readFile(f.options.walletFile);
  const {version, revision, ledger} = JSON.parse(walletBytes);
  ledger.journal.find(event => event.kind === 'CLOSED').realizedPnl = 50;
  const payload = {version, revision, ledger};
  const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await writeFile(f.options.walletFile, JSON.stringify({...payload, checksum}) + '\n');
  await assert.rejects(f.fx.settle(id), {code:'FORWARD_FORECAST_EVIDENCE_MISMATCH'});

  // Recomputing the unkeyed P4 evidence and outcome still cannot change the
  // PnL derived from the authenticated pre-cutoff position and signed prices.
  const ordered = value => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  };
  const outcomePath = join(f.options.directory, id + '.outcome.json');
  const outcomeBytes = await readFile(outcomePath);
  const outcome = JSON.parse(outcomeBytes);
  const fillHash = createHash('sha256').update(JSON.stringify(ledger.journal)).digest('hex');
  outcome.payload.observation.evidence = 'MOCK_NONLIVE:sha256:' + fillHash;
  const outcomeBody = {kind:outcome.kind, payload:outcome.payload, version:outcome.version};
  outcome.checksum = createHash('sha256').update(JSON.stringify(ordered(outcomeBody))).digest('hex');
  await writeFile(outcomePath, JSON.stringify(ordered(outcome)));
  await assert.rejects(f.fx.settle(id), /raw PnL differs from the reserved position/);
  await writeFile(outcomePath, outcomeBytes);
  await writeFile(f.options.walletFile, walletBytes);
  assert.deepEqual(await f.fx.settle(id), settled);
});

const auditMismatch = {code:'FORWARD_FX_AUDIT_MISMATCH'};

async function readyForFxSettlement(f) {
  await f.fx.commitRound();
  const id = await f.openPosition();
  await f.fx.reserve(id);
  await f.closePosition(id);
  return id;
}

async function auditPath(f, kind) {
  const {auditAnchorDirectory} = f.config;
  const [name] = (await readdir(auditAnchorDirectory)).filter(file => file.startsWith('p9c-anchor-' + kind + '-')
    && /^[a-f0-9]{64}\.json$/.test(file.slice(('p9c-anchor-' + kind + '-').length)));
  assert.ok(name, kind);
  return join(auditAnchorDirectory, name);
}

test('P9c explicitly provisions independent directories; P9b remains available on legacy journals', async t => {
  const f = await setup(t);
  const anchor = join(f.root, 'unprovisioned');
  const fresh = join(f.root, 'fresh');
  await mkdir(anchor, {mode:0o700});
  await mkdir(fresh, {mode:0o700});
  const config = {...f.config, journalDirectory:fresh, auditAnchorDirectory:anchor};
  await assert.rejects(openAnchoredForwardGameFx(f.config), /explicit FX audit anchor/);
  await assert.rejects(openAnchoredForwardGameFx(config), /Missing or mismatched FX audit manifests/);
  assert.deepEqual(await readdir(fresh), []);
  assert.deepEqual(await readdir(anchor), []);
  await assert.rejects(initializeForwardGameFxAudit({...config, journalDirectory:f.config.journalDirectory}),
    /two empty directories/);
  await assert.rejects(initializeForwardGameFxAudit({...config, auditAnchorDirectory:fresh}), /independent directories/);
  await assert.rejects(initializeForwardGameFxAudit({...config, auditAnchorDirectory:join(fresh, 'child')}),
    /independent directories/);
  await assert.rejects(initializeForwardGameFxAudit({...config, auditAnchorDirectory:f.root}), /separate from P4 data/);
  const alias = join(f.root, 'alias');
  await symlink(fresh, alias);
  await assert.rejects(initializeForwardGameFxAudit({...config, auditAnchorDirectory:alias}), /server-owned local/);

  await initializeForwardGameFxAudit(config);
  await assert.rejects(initializeForwardGameFxAudit(config), /two empty directories/);
  const anchored = await openAnchoredForwardGameFx(config);
  assert.ok(anchored.fxSource);
  await assert.rejects(openForwardGameFx({...config, auditAnchorDirectory:undefined}), /requires its configured/);
  const manifest = join(fresh, (await readdir(fresh)).find(name => name.startsWith('p9c-manifest-')));
  const manifestBytes = await readFile(manifest);
  await unlink(manifest);
  await assert.rejects(openForwardGameFx({...config, auditAnchorDirectory:undefined}), /requires its configured/);
  await writeFile(manifest, manifestBytes, {mode:0o600});
  for (const path of [f.root, f.options.directory, join(f.options.directory, 'child'), join(f.root, 'alice', 'child')]) {
    await assert.rejects(openAnchoredForwardGameFx({...config, auditAnchorDirectory:path}), /separate from P4 data/);
  }
  assert.equal(f.fx.fxSource, undefined);
  assert.ok((await f.fx.commitRound()).commitment);
});

test('P9c blocks a deleted settlement, round proof, wallet owner or independent witness on active handles and restart', async t => {
  const f = await setup(t, {anchored:true});
  const id = await readyForFxSettlement(f);
  const settled = await f.fx.settle(id);
  const read = createForwardRecordReader({forecastId:id, source:f.config.recordSource, fxSource:f.fx.fxSource});
  const p4 = await p4Bytes(f);
  const [settlement] = await journalPaths(f, 'settlement');
  const [roundProof] = await journalPaths(f, 'round-confirmed');
  const [owner] = await journalPaths(f, 'wallet-owner');
  const witness = await auditPath(f, 'settlement');
  for (const path of [settlement, roundProof, owner, witness]) {
    const original = await readFile(path);
    await unlink(path);
    await assert.rejects(f.fx.settle(id), auditMismatch);
    await assert.rejects(read(), auditMismatch);
    await assert.rejects(openAnchoredForwardGameFx(f.config), auditMismatch);
    await assert.rejects(readFile(path), {code:'ENOENT'});
    await writeFile(path, original, {mode:0o600});
  }
  const witnessBytes = await readFile(witness);
  const tampered = JSON.parse(witnessBytes);
  tampered.payload.sha256 = '0'.repeat(64);
  await writeFile(witness, JSON.stringify(tampered));
  await assert.rejects(read(), /journal authentication/);
  await writeFile(witness, witnessBytes);
  assert.deepEqual(await f.fx.settle(id), settled);
  assert.deepEqual(await p4Bytes(f), p4);
});

test('P9c detects loss of either entire side and authentic-but-different journal records', async t => {
  const f = await setup(t, {anchored:true});
  const old = await setup(t);
  old.state.now = issue + 1;
  await f.fx.commitRound();
  await old.fx.commitRound();
  const [validOther] = await journalPaths(old, 'round');
  const [local] = await journalPaths(f, 'round');
  const original = await readFile(local);
  const alternate = await readFile(validOther);
  assert.notDeepEqual(original, alternate);
  await writeFile(local, alternate);
  await assert.rejects(f.fx.commitRound(), /does not match its independent audit commitment/);
  await writeFile(local, original);

  for (const directory of [f.config.auditAnchorDirectory, f.config.journalDirectory]) {
    const names = await readdir(directory);
    const files = await Promise.all(names.map(async name => [name, await readFile(join(directory, name))]));
    await rm(directory, {recursive:true});
    await mkdir(directory, {mode:0o700});
    await assert.rejects(f.fx.commitRound(), /Missing or mismatched FX audit manifests/);
    await assert.rejects(openAnchoredForwardGameFx(f.config), /Missing or mismatched FX audit manifests/);
    assert.deepEqual(await readdir(directory), []);
    for (const [name, bytes] of files) await writeFile(join(directory, name), bytes, {mode:0o600});
  }
  assert.ok((await f.fx.commitRound()).commitment);
});

function stopAtLink(prefix, after) {
  return `
    const fs = (await import('node:fs/promises')).default;
    const {syncBuiltinESMExports} = await import('node:module');
    const originalLink = fs.link;
    fs.link = async (source, destination) => {
      const stop = destination.split('/').at(-1).startsWith(${JSON.stringify(prefix)});
      if (stop && !${after}) process.exit(0);
      await originalLink(source, destination);
      if (stop) process.exit(0);
    };
    syncBuiltinESMExports();
  `;
}

test('P9c restarts safely before any settlement witness, blocks orphaned witnesses, and replays a completed pair', async t => {
  for (const phase of ['before-anchor', 'after-anchor', 'after-journal']) {
    const f = await setup(t, {anchored:true});
    const id = await readyForFxSettlement(f);
    const p4 = await p4Bytes(f);
    const prefix = phase === 'after-journal' ? 'p9c-journal-settlement-' : 'p9c-anchor-settlement-';
    const command = `await fx.settle(${JSON.stringify(id)}); process.exit(42);`;
    await runChild(f, command, target, stopAtLink(prefix, phase !== 'before-anchor'));
    const paths = await journalPaths(f, 'settlement');
    if (phase === 'after-anchor') {
      assert.equal(paths.length, 0);
      const path = await auditPath(f, 'settlement');
      const witness = await readFile(path);
      await assert.rejects(openAnchoredForwardGameFx(f.config), auditMismatch);
      await assert.rejects(f.fx.settle(id), auditMismatch);
      assert.deepEqual(await readFile(path), witness);
      assert.equal((await journalPaths(f, 'settlement')).length, 0);
    } else {
      assert.equal(paths.length, Number(phase === 'after-journal'));
      const existing = paths.length ? await readFile(paths[0]) : null;
      const restarted = await openAnchoredForwardGameFx(f.config);
      const result = await restarted.settle(id);
      assert.equal(result.forecastId, id);
      assert.equal((await journalPaths(f, 'settlement')).length, 1);
      if (existing) assert.deepEqual(await readFile(paths[0]), existing);
      assert.deepEqual(await f.fx.settle(id), result);
    }
    assert.deepEqual(await p4Bytes(f), p4);
  }
});

async function raceAuditWriter(f, prefix, body, now, parent) {
  const staged = join(f.root, prefix + 'staged');
  const release = join(f.root, prefix + 'release');
  const intercept = `
    const fs = (await import('node:fs/promises')).default;
    const {syncBuiltinESMExports} = await import('node:module');
    const originalLink = fs.link;
    fs.link = async (source, destination) => {
      if (destination.split('/').at(-1).startsWith(${JSON.stringify(prefix)})) {
        await fs.writeFile(${JSON.stringify(staged)}, '');
        for (;;) {
          try { await fs.access(${JSON.stringify(release)}); break; }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }
      }
      await originalLink(source, destination);
    };
    syncBuiltinESMExports();
  `;
  const child = runChild(f, body, now, intercept);
  let waiting = true;
  let expected;
  try {
    await Promise.race([
      child.then(() => assert.fail('Writer did not reach the selected audit link')),
      (async () => {
        while (waiting && !(await readdir(f.root)).includes(staged.split('/').at(-1))) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      })(),
    ]);
    expected = await parent();
  } finally {
    waiting = false;
    await writeFile(release, '');
    const {stdout} = await child;
    assert.deepEqual(JSON.parse(stdout), expected);
  }
  return expected;
}

test('P9c cross-process races keep one matched pair, even with different boundAt and confirmedAt candidates', async t => {
  const f = await setup(t, {anchored:true});
  const commitment = await raceAuditWriter(f, 'p9c-anchor-round-', 'console.log(JSON.stringify(await fx.commitRound()));',
    issue + 13, async () => (await Promise.all(Array.from({length:6}, () => f.fx.commitRound())))[0]);
  assert.equal(commitment.confirmedAt, iso(issue));
  const [draft] = await journalPaths(f, 'round');
  assert.equal(JSON.parse(await readFile(draft)).payload.boundAt, iso(issue));
  assert.equal((await journalPaths(f, 'round')).length, 1);
  assert.equal((await journalPaths(f, 'round-confirmed')).length, 1);
  const id = await f.openPosition();
  await f.fx.reserve(id);
  await f.closePosition(id);
  const result = await raceAuditWriter(f, 'p9c-anchor-settlement-',
    `console.log(JSON.stringify(await fx.settle(${JSON.stringify(id)})));`, target + 13,
    async () => (await Promise.all(Array.from({length:6}, () => f.fx.settle(id))))[0]);
  assert.equal((await journalPaths(f, 'settlement')).length, 1);
  assert.deepEqual(await (await openAnchoredForwardGameFx(f.config)).settle(id), result);

  const g = await setup(t, {anchored:true});
  g.state.now = issue + 26;
  const confirmed = await raceAuditWriter(g, 'p9c-anchor-round-confirmed-',
    'console.log(JSON.stringify(await fx.commitRound()));', issue + 13, () => g.fx.commitRound());
  const [earlierDraft] = await journalPaths(g, 'round');
  assert.equal(JSON.parse(await readFile(earlierDraft)).payload.boundAt, iso(issue + 13));
  assert.equal(confirmed.confirmedAt, iso(issue + 26));
  assert.equal((await journalPaths(g, 'round-confirmed')).length, 1);
});

test('P9c record projection is opt-in, score gated, read-only, and restricted to the exact P4 source', async t => {
  const f = await setup(t, {anchored:true});
  const {recordSource:source} = f.config;
  const id = await f.freeze();
  const fxSource = f.fx.fxSource;
  const legacy = createForwardRecordReader({forecastId:id, source});
  const optIn = createForwardRecordReader({forecastId:id, source, fxSource});
  assert.throws(() => createForwardRecordReader({forecastId:id, source, fxSource:{read:() => ({})}}),
    /trusted FX source/);
  const alternate = await openForwardMockLifecycle(f.options);
  assert.throws(() => createForwardRecordReader({forecastId:id, source:alternate.recordSource, fxSource}),
    /this P4 source/);

  async function compare(expected) {
    const view = await optIn();
    const {fx, ...rest} = view.records[0];
    assert.deepEqual(fx, expected);
    assert.deepEqual({...view, records:[rest]}, await legacy());
    return view;
  }

  await compare(null);
  const commitment = await f.fx.commitRound();
  await f.lifecycle.reserveOpen(id);
  await f.batch(entry, 100);
  await f.fx.reserve(id);
  await f.lifecycle.reserveClose(id);
  await f.batch(target, 125);
  await compare(null);
  await f.lifecycle.score(id);
  await compare(null);

  const {rawPnl, gamePnl, basisPoints} = await f.fx.settle(id);
  const expected = {rawPnl, gamePnl, basisPoints, commitment:commitment.commitment};
  const p4 = await p4Bytes(f);
  const fxNames = await readdir(f.config.journalDirectory);
  const anchorNames = await readdir(f.config.auditAnchorDirectory);
  const view = await compare(expected);
  assert.deepEqual([rawPnl, gamePnl, basisPoints], [-50, -51, 10200]);
  assert.equal(view.records[0].realizedPnl, rawPnl);
  assert.equal(view.records[0].score.directionCorrect, false);
  assert.doesNotMatch(JSON.stringify(view), /nonce|modelHash|forecastSha|referenceSha|receiptSha|accountId|\/tmp\//);

  const child = await runChild(f, `
    const fs = await import('node:fs/promises');
    const handle = await fs.open(${JSON.stringify(f.options.walletFile)}, 'r');
    const proto = Object.getPrototypeOf(handle);
    await handle.close();
    proto.sync = () => { throw new Error('Read-only projection called fsync'); };
    const {createForwardRecordReader} = await import(${JSON.stringify(new URL('../../game_runtime/forward-records.mjs', import.meta.url).href)});
    const read = createForwardRecordReader({forecastId:${JSON.stringify(id)}, source:recordSource, fxSource:fx.fxSource});
    console.log(JSON.stringify(await read()));
  `, target);
  assert.deepEqual(JSON.parse(child.stdout), view);
  assert.deepEqual(await p4Bytes(f), p4);
  assert.deepEqual(await readdir(f.config.journalDirectory), fxNames);
  assert.deepEqual(await readdir(f.config.auditAnchorDirectory), anchorNames);

  const scorePath = join(f.options.directory, id + '.outcome.json');
  await writeFile(scorePath, '{}');
  await assert.rejects(optIn(), {code:'FORWARD_FORECAST_CORRUPT'});
});

test('P9d binds the local HTTP projection to the authorized P4 source and its explicit wallet', async t => {
  const f = await setup(t, {anchored:true});
  const forecastId = await readyForFxSettlement(f);
  const {walletFile} = f.options;
  const {recordSource:source} = f.config;
  const forwardRecords = {forecastId, source, fxSource:f.fx.fxSource};
  assert.throws(() => createGameServer({forwardRecords}), /same explicit MOCK_NONLIVE wallet/);
  const other = await setup(t, {accountId:'bob'});
  assert.throws(() => createGameServer({forwardRecords, forwardLedgerFile:other.options.walletFile}),
    /same explicit MOCK_NONLIVE wallet/);
  assert.throws(() => createGameServer({forwardLedgerFile:walletFile, forwardRecords:{...forwardRecords, fxSource:{}}}),
    /trusted FX source/);
  const alternate = await openForwardMockLifecycle(f.options);
  assert.throws(() => createGameServer({forwardLedgerFile:walletFile,
    forwardRecords:{...forwardRecords, source:alternate.recordSource}}), /this P4 source/);
  f.state.allowed = false;
  assert.throws(() => createGameServer({forwardLedgerFile:walletFile, forwardRecords}), /利用許可/);
  f.state.allowed = true;

  const server = createGameServer({forwardLedgerFile:walletFile, forwardRecords,
    companionStore:{read:async () => ({created:false, companion:{approach:'trend', risk_percent:35}})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const recordsPath = '/api/companion/forward-records';
  const walletPath = '/api/companion/forward-ai?view=summary';
  const api = path => fetch(base + path);
  const initial = await (await api(walletPath)).json();
  const walletBefore = await readFile(walletFile);
  const readsBefore = f.state.reads;
  const responseBefore = await api(recordsPath);
  assert.equal(responseBefore.status, 200);
  const before = await responseBefore.json();
  assert.equal(before.records[0].fx, null);
  const {commitment} = await f.fx.settle(forecastId);

  const response = await api(recordsPath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const json = await response.text();
  const after = JSON.parse(json);
  assert.deepEqual(after, {...before, records:[{...before.records[0],
    fx:{rawPnl:-50, gamePnl:-51, basisPoints:10200, commitment}}]});
  assert.doesNotMatch(json, /nonce|accountId|modelHash|forecastSha256|receiptSha256|referenceSha256|\/tmp\//);
  assert.deepEqual(await (await api(walletPath)).json(), initial);
  assert.deepEqual(await readFile(walletFile), walletBefore);
  assert.equal(f.state.reads, readsBefore);
  assert.equal((await api(recordsPath + '?rate=9800&account=bob')).status, 400);
  assert.equal((await fetch(base + recordsPath, {headers:{'Sec-Fetch-Site':'cross-site'}})).status, 403);
  assert.equal((await fetch(base + recordsPath, {method:'POST', body:'{}'})).status, 404);

  const page = await (await api('/game')).text();
  assert.match(page, /id="forwardPanel"/);
  assert.match(page, /<script type="module" src="\/forward-view-ui.mjs"><\/script>/);
  assert.match(await (await api('/forward-view-ui.mjs')).text(), /ゲーム内為替（架空）/);

  await unlink(await auditPath(f, 'settlement'));
  assert.equal((await api(recordsPath)).status, 503);
  assert.deepEqual(await readFile(walletFile), walletBefore);
});
