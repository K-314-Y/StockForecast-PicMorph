import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash, createHmac} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {deriveForwardAppearanceModel, identifyForwardAppearanceModel} from '../../game_runtime/appearance-model.mjs';
import {deriveForwardCompanionModel, identifyForwardModel} from '../../game_runtime/forward-model.mjs';
import {openForwardForecastStore} from '../../game_runtime/forward-forecast-store.mjs';
import {createForwardMarketAdapter} from '../../game_runtime/forward-market-adapter.mjs';
import {MARKET_PAPER_MODE, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE} from '../../game_runtime/forward-market-guard.mjs';
import {openForwardMockLifecycle} from '../../game_runtime/forward-mock-lifecycle.mjs';
import {openForwardPredictor} from '../../game_runtime/forward-predict.mjs';
import {openForwardStore, saveForwardGeneration} from '../../game_runtime/forward-store.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

const minute = 60_000;
const issue = Date.parse('2030-01-07T01:00:00.000Z');
const entry = issue + 5 * minute;
const target = issue + 10 * minute;
const iso = time => new Date(time).toISOString();
const colors = {hair_color:'#808080', clothing_color:'#808080'};
const appearance = deriveForwardAppearanceModel(
  {hair_style:'bob', expression:'cheerful', accessory:'none'}, colors);
const {modelHash, model_version} = identifyForwardAppearanceModel(appearance);
const input = {aiId:'ai_test', modelHash, model_version, symbol:'FAKE', targetAt:iso(target),
  sourceMode:'TEST_ONLY', probabilities:{UP:.7, FLAT:.2, DOWN:.1}};

const key = 'P4 MOCK_NONLIVE public fixture key';
const sign = raw => createHmac('sha256', key).update(raw).digest('hex');
function signedTrade(time, price, extra = {}) {
  const raw = JSON.stringify({sourceId:MOCK_MARKET_SOURCE, market:'XTKS', valueKind:'TRADE',
    symbol:input.symbol, price, tradeAt:iso(time), publishedAt:iso(time), ...extra});
  return {raw, proof:sign(raw)};
}

const reference = signedTrade(issue - minute, 100);
const scenarioTrade = (time, price) => signedTrade(time, price, {referenceProof:reference.proof});

async function seedWallet(walletFile, marketAdapter, model = appearance) {
  const initial = {initialMedals:1000, allocations:[{id:'control', modelHash:'b'.repeat(64), medals:200}]};
  if (marketAdapter) initial.mode = MOCK_MARKET_PAPER_MODE;
  await openForwardStore({filePath:walletFile, marketAdapter, initial});
  const {revision, ledger} = await saveForwardGeneration({filePath:walletFile, aiId:input.aiId,
    generation:model, medals:300, expectedRevision:0});
  return {revision, ledger};
}

async function setup(t, generation = appearance) {
  const root = await mkdtemp('/tmp/forward-mock-lifecycle-');
  t.after(() => rm(root, {recursive:true, force:true}));
  const directory = join(root, 'forecasts');
  const walletFile = join(root, 'wallet.json');
  await mkdir(directory);
  const state = {now:issue, stamps:[], authorized:true, status:'OPEN', rows:[], reads:0};
  const config = {
    sourceId:MOCK_MARKET_SOURCE, licenseRef:'MOCK_NONLIVE signed fixture only',
    observationIntervalMs:5 * minute, maxAgeMs:10 * minute, maxPublicationDelayMs:minute,
  };
  const marketAdapter = createForwardMarketAdapter({...config,
    verifyUsage:() => state.authorized,
    verifyRecord:({raw, proof}) => proof === sign(raw) ? JSON.parse(raw) : null,
    marketStatusAt:() => state.status,
    readBatch:() => {state.reads++; return state.rows;},
    clock:() => state.stamps.shift() ?? state.now,
  });
  const initial = await seedWallet(walletFile, marketAdapter, generation);
  const options = {walletFile, directory, marketAdapter, reference, margin:102, leverage:2};
  const lifecycle = await openForwardMockLifecycle(options);

  async function batch(time, ...rows) {
    state.now = time;
    state.rows = rows;
    return lifecycle.applyBatch();
  }

  return {lifecycle, state, options, initial, batch, config, root};
}

const idOf = saved => saved.receipt.forecastId;

const recordsPath = '/api/companion/forward-records';
async function serveRecords(t, options) {
  const server = createGameServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  return (path = recordsPath, init) => fetch(base + path, init);
}

test('P5 records are unconnected by default and only accept a local GET with no input', async t => {
  const root = await mkdtemp('/tmp/forward-records-default-');
  t.after(() => rm(root, {recursive:true, force:true}));
  const request = await serveRecords(t, {forwardLedgerFile:join(root, 'missing', 'ledger.json')});
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {status:'unconnected', records:[]});
  assert.equal((await request(recordsPath + '?forecastId=anything')).status, 400);
  assert.equal((await request(recordsPath, {method:'POST'})).status, 404);
  assert.equal((await request(recordsPath, {headers:{Origin:'http://example.test'}})).status, 403);
  assert.deepEqual(await readdir(root), []);
});

test('P8 serves the PNG parts lab and an unconnected forward summary on the same server', async t => {
  const root = await mkdtemp('/tmp/forward-p8-default-');
  t.after(() => rm(root, {recursive:true, force:true}));
  const unavailable = () => assert.fail('Unexpected model or market access');
  const request = await serveRecords(t, {forwardLedgerFile:join(root, 'wallet.json'),
    loadSnapshot:unavailable, predict:unavailable, historicalPredict:unavailable});
  const page = await request('/game');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /href="\/parts-lab\/preview\.html"/);
  assert.match(html, /id="forwardPanel"/);
  const parts = await request('/parts-lab/preview.html');
  assert.equal(parts.status, 200);
  assert.match(parts.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await parts.text(), /id="previewCanvas"/);
  assert.equal((await request('/forward-view-ui.mjs')).status, 200);
  const summary = await request('/api/companion/forward-ai?view=summary');
  assert.equal(summary.status, 200);
  const {mode, mock, revision, wallets} = await summary.json();
  assert.deepEqual({mode, mock, revision, wallets}, {
    mode:'FORWARD_WALLETS_MARKET_UNCONNECTED', mock:false, revision:null, wallets:{},
  });
  assert.deepEqual(await (await request()).json(), {status:'unconnected', records:[]});
  const selection = {aiId:'ai_new', medals:10, expected_revision:null,
    model_version:'companion-v1_100_0_0_0_35'};
  for (const field of [{sourceId:'SAMPLE_PROVIDER'}, {price:123}, {licenseRef:'claimed permission'},
    {sourceMode:'LIVE'}]) {
    const response = await request('/api/companion/forward-ai?view=summary', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...selection, ...field}),
    });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(await readdir(root), []);
});

test('P8 wallet API rejects a real-market ledger and preserves paper and signed mock wallet saves', async t => {
  const fixture = await setup(t);
  const paperFile = join(fixture.root, 'paper-wallet.json');
  const marketFile = join(fixture.root, 'market-wallet.json');
  const paper = await seedWallet(paperFile);
  const unavailable = () => assert.fail('Unexpected market access');
  const adapter = createForwardMarketAdapter({...fixture.config, sourceId:'P8_FIXTURE_ONLY',
    verifyUsage:() => true, verifyRecord:unavailable, marketStatusAt:unavailable, readBatch:unavailable});
  await openForwardStore({filePath:marketFile, marketAdapter:adapter, initial:{
    mode:MARKET_PAPER_MODE, initialMedals:1000, allocations:[{id:'control', modelHash:'b'.repeat(64), medals:200}],
  }});
  const companion = {approach:'momentum', risk_percent:40};
  const {model_version} = deriveForwardCompanionModel(companion);
  for (const [walletFile, revision, expectedMock] of [
    [marketFile, 0, null],
    [paperFile, paper.revision, false],
    [fixture.options.walletFile, fixture.initial.revision, true],
  ]) {
    const request = await serveRecords(t, {forwardLedgerFile:walletFile,
      companionStore:{read:async () => ({created:true, companion})}});
    const original = await readFile(walletFile);
    const path = '/api/companion/forward-ai';
    const summaryPath = path + '?view=summary';
    for (const route of [path, summaryPath]) {
      const response = await request(route);
      assert.equal(response.status, expectedMock === null ? 503 : 200);
      if (expectedMock === null) {
        assert.deepEqual(await response.json(), {error:'AI財布の台帳を読み取れません'});
      } else if (route === summaryPath) {
        assert.equal((await response.json()).mock, expectedMock);
      }
    }
    const response = await request(summaryPath, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({aiId:'ai_new', medals:10, expected_revision:revision, model_version}),
    });
    if (expectedMock === null) {
      assert.equal(response.status, 503);
      assert.deepEqual(await readFile(walletFile), original);
    } else {
      assert.equal(response.status, 201);
      const saved = await response.json();
      assert.equal(saved.mock, expectedMock);
      assert.equal(saved.currentAiId, 'ai_new');
      assert.equal(saved.revision, revision + 1);
      assert.equal(saved.wallets.ai_new.cash, 10);
      assert.notDeepEqual(await readFile(walletFile), original);
    }
  }
  assert.equal(fixture.state.reads, 0);
});

for (const generation of [appearance, deriveForwardCompanionModel({approach:'trend', risk_percent:35})]) {
  test(`forward GET shows reserved, settled and scored records without write locks for ${generation.model_version}`, async t => {
    const {lifecycle, batch, options, state, root} = await setup(t, generation);
    const {model_version, modelHash} = identifyForwardModel(generation);
    const forecastId = idOf(await lifecycle.freeze({...input, model_version, modelHash, probabilities:{UP:.1, FLAT:.2, DOWN:.7},
      predictedChangePct:-4}));
    const request = await serveRecords(t, {forwardLedgerFile:options.walletFile,
      forwardRecords:{forecastId, source:lifecycle.recordSource}});
    const result = async () => {
      const response = await request();
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.status, 'MOCK_NONLIVE');
      assert.equal(data.records.length, 1);
      assert.equal(data.records[0].model_version, model_version);
      const serialized = JSON.stringify(data);
      for (const secret of ['modelHash','provenance','forecastSha256','evidence','proof','fast_window','/tmp/']) {
        assert.ok(!serialized.includes(secret), secret);
      }
      return data.records[0];
    };
    assert.equal((await result()).open.status, 'NONE');
    const reserved = await lifecycle.reserveOpen(forecastId);
    assert.equal(reserved.ledger.pending[0].modelHash, undefined);
    const pending = await result();
    assert.equal(pending.status, 'PENDING');
    assert.deepEqual(pending.open, {status:'QUEUED', at:iso(issue)});
    assert.equal(pending.score, null);
    assert.equal(pending.realizedPnl, null);
    await batch(entry, scenarioTrade(entry, 90));
    await lifecycle.reserveClose(forecastId);
    assert.equal((await result()).close.status, 'QUEUED');
    const settled = await batch(target, scenarioTrade(target, 95));
    const unscored = await result();
    assert.equal(unscored.status, 'PENDING');
    assert.equal(unscored.close.status, 'CLOSED');
    assert.equal(unscored.score, null);
    assert.ok(unscored.realizedPnl < 0);
    assert.deepEqual(await lifecycle.snapshot(), settled);
    assert.ok(!(await readdir(options.directory)).some(name => name.endsWith('.outcome.json')));

    await lifecycle.score(forecastId);
    const path = join(options.directory, forecastId + '.outcome.json');
    const outcome = await readFile(path);
    const wallet = await readFile(options.walletFile);
    await mkdir(options.walletFile + '.lock');
    await mkdir(join(options.directory, forecastId + '.lock'));
    const before = (await readdir(root, {recursive:true})).sort();
    const scored = await result();
    assert.equal(scored.status, 'SCORED_MOCK_NONLIVE');
    assert.equal(scored.score.directionCorrect, true);
    assert.equal(scored.score.absoluteChangeErrorPctPoints, 1);
    assert.ok(Math.abs(scored.score.brier - .14) < 1e-12);
    assert.equal(scored.realizedPnl, unscored.realizedPnl);
    assert.equal(state.reads, 2);
    assert.deepEqual(await readFile(path), outcome);
    assert.deepEqual(await readFile(options.walletFile), wallet);
    assert.deepEqual((await readdir(root, {recursive:true})).sort(), before);
    const summary = await (await request('/api/companion/forward-ai?view=summary')).json();
    assert.equal(summary.mock, true);
    const {cash} = settled.ledger.wallets[input.aiId];
    assert.deepEqual(summary.wallets[input.aiId], {
      status:'ACTIVE', cash, equity:cash, position:null,
    });
    assert.deepEqual(summary.generations, [{aiId:input.aiId, model_version}]);

    await writeFile(path, '{}');
    const broken = await request();
    assert.equal(broken.status, 503);
    assert.deepEqual(await broken.json(), {error:'保存された模擬記録を確認できません'});
  });
}

async function enter({lifecycle, batch}, fields = {}, entryPrice = 102) {
  const id = idOf(await lifecycle.freeze({...input, ...fields}));
  const reserved = await lifecycle.reserveOpen(id);
  assert.equal(reserved.ledger.pending[0].receivedAt, iso(issue));
  assert.equal(reserved.ledger.pending[0].eligibleAt, iso(entry));
  const opened = await batch(entry, scenarioTrade(entry, entryPrice));
  assert.equal(opened.ledger.journal[0].orderId, reserved.orderId);
  return {id, reserved, opened};
}

test('one frozen AI enters before the target, settles at the target, then scores and restores in a new process', async t => {
  const fixture = await setup(t);
  const {lifecycle, initial, state, options, config, batch} = fixture;
  const {id, reserved, opened} = await enter(fixture);
  const open = opened.ledger.journal[0];
  const frozen = await lifecycle.read(id);
  assert.equal(reserved.action, 'OPEN_LONG');
  assert.equal(open.tradeAt, iso(entry));
  assert.equal(open.modelHash, frozen.forecast.modelHash);
  assert.equal(open.aiId, frozen.forecast.aiId);
  assert.equal(open.symbol, frozen.forecast.symbol);
  assert.equal(open.kind, 'OPENED');
  assert.equal(open.mockForecast.forecastSha256, frozen.receipt.forecastSha256);
  assert.equal(open.mockForecast.targetAt, frozen.forecast.targetAt);
  assert.deepEqual(open.mockForecast.reference, reference);
  assert.equal(sign(open.evidence.raw), open.evidence.proof);
  assert.equal(opened.ledger.wallets[input.aiId].cash, 198);
  assert.equal(opened.ledger.wallets[input.aiId].position.direction, 'LONG');
  assert.equal(opened.ledger.appearanceGenerations[0].model_version, frozen.forecast.model_version);
  assert.equal(opened.ledger.appearanceGenerations.length, 1);
  assert.deepEqual(await lifecycle.score(id), {status:'PENDING', forecastId:id});

  const close = await lifecycle.reserveClose(id);
  assert.equal(close.ledger.pending[0].receivedAt, iso(entry));
  assert.equal(close.ledger.pending[0].eligibleAt, iso(target));
  state.now = target;
  assert.deepEqual(await lifecycle.score(id), {status:'PENDING', forecastId:id});
  const targetRow = scenarioTrade(target, 110);
  const settled = await batch(target, targetRow);
  const closed = settled.ledger.journal[1];
  assert.equal(closed.kind, 'CLOSED');
  assert.equal(closed.orderId, close.orderId);
  assert.equal(closed.tradeAt, iso(target));
  assert.equal(closed.modelHash, open.modelHash);
  assert.equal(closed.realizedPnl, 16);
  assert.equal(closed.evidence.raw, targetRow.raw);
  assert.equal(closed.evidence.proof, sign(targetRow.raw));
  assert.equal(JSON.parse(closed.evidence.raw).referenceProof, reference.proof);
  assert.deepEqual(closed.mockForecast, open.mockForecast);
  assert.equal(settled.ledger.wallets[input.aiId].cash, 316);
  assert.equal(settled.ledger.wallets[input.aiId].position, null);
  assert.deepEqual(settled.ledger.wallets.control, initial.ledger.wallets.control);
  assert.equal(settled.ledger.unallocated, initial.ledger.unallocated);
  assert.equal((await lifecycle.read(id)).outcome, null);
  assert.equal(state.reads, 2);

  const outcome = await lifecycle.score(id);
  assert.equal(outcome.forecastSha256, frozen.receipt.forecastSha256);
  assert.equal(outcome.observation.referencePrice, 100);
  assert.equal(outcome.observation.targetPrice, closed.price);
  assert.equal(outcome.observation.targetTradeAt, closed.tradeAt);
  assert.equal(outcome.observation.evidence, 'MOCK_NONLIVE:sha256:' +
    createHash('sha256').update(JSON.stringify([open, closed])).digest('hex'));
  assert.equal(outcome.score.actualDirection, 'UP');
  assert.ok(Math.abs(outcome.score.brier - .14) < 1e-12);
  assert.deepEqual(await lifecycle.snapshot(), settled);

  const restarted = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {createHmac} from 'node:crypto';
    import {createForwardMarketAdapter} from ${JSON.stringify(new URL('../../game_runtime/forward-market-adapter.mjs', import.meta.url).href)};
    import {openForwardMockLifecycle} from ${JSON.stringify(new URL('../../game_runtime/forward-mock-lifecycle.mjs', import.meta.url).href)};
    const marketAdapter = createForwardMarketAdapter({
      ...${JSON.stringify(config)}, clock: () => ${state.now}, marketStatusAt: () => 'OPEN',
      verifyUsage: () => true, readBatch: () => {throw new Error('unexpected observation');},
      verifyRecord: ({raw, proof}) => createHmac('sha256', ${JSON.stringify(key)}).update(raw).digest('hex') === proof
        ? JSON.parse(raw) : null,
    });
    const lifecycle = await openForwardMockLifecycle({ ...${JSON.stringify({...options, marketAdapter:undefined})}, marketAdapter });
    console.log(JSON.stringify({snapshot: await lifecycle.snapshot(), saved: await lifecycle.read(${JSON.stringify(id)})}));
  `], {encoding:'utf8'});
  assert.deepEqual(JSON.parse(restarted), {snapshot:settled, saved:{...frozen,outcome}});
});

test('DOWN opens a short and correct direction can coexist with a trading loss; FLAT does not reserve', async t => {
  const short = await setup(t);
  const {id, reserved} = await enter(short, {probabilities:{UP:.1, FLAT:.2, DOWN:.7}}, 90);
  assert.equal(reserved.action, 'OPEN_SHORT');
  await short.lifecycle.reserveClose(id);
  const settled = await short.batch(target, scenarioTrade(target, 95));
  assert.ok(settled.ledger.journal.at(-1).realizedPnl < 0);
  short.state.now++;
  assert.equal((await short.lifecycle.score(id)).score.directionCorrect, true);

  const flat = await setup(t);
  const flatId = idOf(await flat.lifecycle.freeze({...input, probabilities:{UP:.1, FLAT:.8, DOWN:.1}}));
  assert.deepEqual(await flat.lifecycle.reserveOpen(flatId), {action:'NO_TRADE'});
  assert.deepEqual(await flat.lifecycle.snapshot(), flat.initial);
});

test('rejects a different model version, a non-test forecast and a non-mock ledger', async t => {
  const {lifecycle, options, root} = await setup(t);
  const id = idOf(await lifecycle.freeze(input));
  const different = deriveForwardAppearanceModel(
    {hair_style:'long', expression:'cheerful', accessory:'none'}, colors);
  assert.notEqual(different.model_version, model_version);
  const changedWallet = join(root, 'changed.json');
  const changed = await seedWallet(changedWallet, options.marketAdapter, different);
  const other = await openForwardMockLifecycle({...options, walletFile:changedWallet});
  await assert.rejects(other.reserveOpen(id), /wallet model generation/);
  assert.deepEqual(await other.snapshot(), changed);
  const nonTest = idOf(await lifecycle.freeze({...input, sourceMode:'MARKET_UNCONNECTED'}));
  await assert.rejects(lifecycle.reserveOpen(nonTest), /TEST_ONLY/);

  const unconnected = join(root, 'unconnected.json');
  await seedWallet(unconnected);
  await assert.rejects(openForwardMockLifecycle({...options, walletFile:unconnected}), /市場観測元/);
});

test('server cutoff blocks late OPEN, and CLOSE must be reserved before target even before its quote is read', async t => {
  const fixture = await setup(t);
  const {lifecycle, state, initial} = fixture;
  const id = idOf(await lifecycle.freeze(input));
  for (const time of [target, target + 1]) {
    state.now = time;
    await assert.rejects(lifecycle.reserveOpen(id), /forecast window/);
  }
  state.now = entry; // The first eligible batch now falls exactly on the target.
  await assert.rejects(lifecycle.reserveOpen(id), /No eligible batch/);
  state.now = issue;
  state.stamps = [issue, target]; // Crosses the cutoff while preparing the durable write.
  await assert.rejects(lifecycle.reserveOpen(id), /forecast window/);
  assert.deepEqual(await lifecycle.snapshot(), initial);

  await lifecycle.reserveOpen(id);
  await fixture.batch(entry, scenarioTrade(entry, 102));
  const opened = await lifecycle.snapshot();
  state.now = target;
  await assert.rejects(lifecycle.reserveClose(id), /forecast window/);
  assert.deepEqual(await lifecycle.snapshot(), opened);
  assert.equal(state.reads, 1);
});

test('a halt blocks entry or settlement and an off-target trade leaves the forecast pending', async t => {
  const halted = await setup(t);
  const id = idOf(await halted.lifecycle.freeze(input));
  await halted.lifecycle.reserveOpen(id);
  halted.state.status = 'HALTED';
  assert.deepEqual((await halted.batch(entry, scenarioTrade(entry, 102))).ledger.journal, []);
  halted.state.status = 'OPEN';
  assert.deepEqual((await halted.batch(target, scenarioTrade(target, 110))).ledger.journal, []);

  const fixture = await setup(t);
  const opened = await enter(fixture);
  await fixture.lifecycle.reserveClose(opened.id);
  fixture.state.authorized = false;
  const pending = await fixture.lifecycle.snapshot();
  await assert.rejects(fixture.batch(target, scenarioTrade(target, 110)), /利用許可/);
  assert.deepEqual(await fixture.lifecycle.snapshot(), pending);
  fixture.state.authorized = true;
  fixture.state.status = 'HALTED';
  await fixture.batch(target, scenarioTrade(target, 110));
  fixture.state.status = 'OPEN';
  const late = await fixture.batch(target + 5 * minute, scenarioTrade(target + 5 * minute, 112));
  assert.deepEqual(late.ledger.journal, opened.opened.ledger.journal);
  assert.equal(late.ledger.pending[0].action, 'CLOSE');
  assert.deepEqual(await fixture.lifecycle.score(opened.id), {status:'PENDING', forecastId:opened.id});
});

test('concurrent reservations and reopened ledgers preserve one order ID per forecast and one position per AI', async t => {
  const {lifecycle, options, batch} = await setup(t);
  const id = idOf(await lifecycle.freeze(input));
  const second = idOf(await lifecycle.freeze({...input, targetAt:iso(target + 5 * minute)}));
  const reopened = await openForwardMockLifecycle(options);
  const results = await Promise.allSettled([lifecycle.reserveOpen(id), reopened.reserveOpen(id)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const pending = (await lifecycle.snapshot()).ledger.pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, results.find(item => item.status === 'fulfilled').value.orderId);
  await assert.rejects(reopened.reserveOpen(id), /重複/);
  await assert.rejects(reopened.reserveOpen(second), /受け付けられません/);
  await batch(entry, scenarioTrade(entry, 102));
  await assert.rejects(reopened.reserveOpen(id), /重複/);
  await assert.rejects(reopened.reserveOpen(second), /すでに株を保有/);
});

test('virtual margin must fit the frozen AI wallet even with other balances available', async t => {
  const {lifecycle, options, initial} = await setup(t);
  const id = idOf(await lifecycle.freeze(input));
  const overBudget = await openForwardMockLifecycle({...options, margin:301});
  await assert.rejects(overBudget.reserveOpen(id), /資金が不正/);
  assert.deepEqual(await overBudget.snapshot(), initial);
});

test('unsigned or differently linked prices cannot settle or produce a score', async t => {
  const fixture = await setup(t);
  const {lifecycle, state, batch} = fixture;
  const {id} = await enter(fixture);
  await lifecycle.reserveClose(id);
  const pending = await lifecycle.snapshot();
  const otherReference = signedTrade(issue - minute, 200);
  await assert.rejects(batch(target, signedTrade(target, 110, {referenceProof:otherReference.proof})), /signed|Signed/);
  assert.deepEqual(await lifecycle.snapshot(), pending);
  const targetRow = scenarioTrade(target, 110);
  const wrongProof = {...targetRow, raw:targetRow.raw.replace('"price":110', '"price":111')};
  const observation = await batch(target, wrongProof);
  assert.equal(observation.ledger.journal.length, 1);
  state.now++;
  assert.deepEqual(await lifecycle.score(id), {status:'PENDING', forecastId:id});
});

test('reverification rejects a ledger event price altered independently of its signed payload', async t => {
  const fixture = await setup(t);
  const {lifecycle, options, state, batch} = fixture;
  const {id} = await enter(fixture);
  await lifecycle.reserveClose(id);
  await batch(target, scenarioTrade(target, 110));
  const {checksum, ...payload} = JSON.parse(await readFile(options.walletFile, 'utf8'));
  assert.ok(checksum);
  payload.ledger.journal.at(-1).price = 111;
  await writeFile(options.walletFile, JSON.stringify({...payload,
    checksum:createHash('sha256').update(JSON.stringify(payload)).digest('hex')}) + '\n');
  state.now++;
  await assert.rejects(lifecycle.score(id), /does not match the ledger/);
  assert.equal((await lifecycle.read(id)).outcome, null);
});

test('P3 cannot save different prices in the mock paper ledger and P4 can still save the signed result', async t => {
  const fixture = await setup(t);
  const {lifecycle, state, options, batch} = fixture;
  const {id} = await enter(fixture);
  await lifecycle.reserveClose(id);
  await batch(target, scenarioTrade(target, 110));
  state.now++;
  let callbackCalls = 0;
  const legacy = await openForwardForecastStore({directory:options.directory, walletFile:options.walletFile,
    clock:() => state.now,
    readMockOutcome:({forecastId, symbol, targetAt}) => {
      callbackCalls++;
      return {forecastId, symbol, targetAt,
        status:'OBSERVED', sourceMode:MOCK_MARKET_SOURCE, evidence:'independent fixture',
        referenceTradeAt:iso(issue - minute), targetTradeAt:targetAt, referencePrice:120, targetPrice:130};
    },
  });
  await assert.rejects(legacy.scoreMock(id), /require signed settlement evidence/);
  assert.equal(callbackCalls, 0);
  await assert.rejects(readFile(join(options.directory, id + '.outcome.json')), {code:'ENOENT'});
  assert.equal((await lifecycle.read(id)).outcome, null);
  const outcome = await lifecycle.score(id);
  assert.equal(outcome.observation.referencePrice, 100);
  assert.equal(outcome.observation.targetPrice, 110);
  assert.deepEqual((await lifecycle.read(id)).outcome, outcome);
});

test('a receipt with missing cutoff confirmation never enables a reservation', async t => {
  const {lifecycle, options, initial} = await setup(t);
  const id = idOf(await lifecycle.freeze(input));
  await unlink(join(options.directory, id + '.confirmation.json'));
  await assert.rejects(lifecycle.reserveOpen(id), {code:'FORWARD_FORECAST_UNCONFIRMED'});
  assert.deepEqual(await lifecycle.snapshot(), initial);
});

test('rejects a late reference, a reversed receipt clock and an opening trade before eligibility', async t => {
  const {lifecycle, options, state, initial, batch} = await setup(t);
  const id = idOf(await lifecycle.freeze(input));
  const lateReference = signedTrade(issue - 10, 100, {publishedAt:iso(issue + 1)});
  const late = await openForwardMockLifecycle({...options, reference:lateReference});
  await assert.rejects(late.reserveOpen(id), /published by forecast issuance/);
  state.now = issue - 1;
  await assert.rejects(lifecycle.reserveOpen(id), /forecast window/);
  state.now = issue;
  state.stamps = [issue + 2, issue + 1];
  await assert.rejects(lifecycle.reserveOpen(id), /clock reversed/);
  assert.deepEqual(await lifecycle.snapshot(), initial);
  await lifecycle.reserveOpen(id);
  const older = await batch(entry, scenarioTrade(entry - 1, 102));
  assert.equal(older.ledger.pending.length, 1);
  assert.deepEqual(older.ledger.journal, []);
  const delayed = await batch(target, scenarioTrade(entry, 102));
  assert.deepEqual(delayed.ledger.journal, []);
});

const predictorUrl = new URL('../../game_runtime/forward-predict.mjs', import.meta.url);
const cli = fileURLToPath(new URL('./forward_predict_bridge.py', predictorUrl));
const trend = deriveForwardCompanionModel({approach:'trend', risk_percent:35});
const history = [
  ...Array.from({length:24}, (_, i) => signedTrade(issue - (25 - i) * minute, 76 + i)),
  reference,
];
const selection = {aiId:input.aiId};

function predictionConfig({options, state}, readHistory = () => history) {
  const {walletFile, directory, marketAdapter} = options;
  return {walletFile, directory, marketAdapter, readHistory, clock:() => state.now,
    targetAt:iso(target), symbol:input.symbol};
}

test('P7 uses the saved model version and returns engine probabilities without writing', async t => {
  const fixture = await setup(t, trend);
  const {initial, options, lifecycle, state} = fixture;
  const second = deriveForwardCompanionModel({approach:'reversion', risk_percent:35});
  const {revision, ledger} = await saveForwardGeneration({filePath:options.walletFile, aiId:'ai_second',
    generation:second, medals:100, expectedRevision:initial.revision});
  const predictor = await openForwardPredictor(predictionConfig(fixture, query => {
    assert.deepEqual(query, {symbol:input.symbol, throughAt:iso(issue)});
    assert.ok(Object.isFrozen(query));
    return history;
  }));
  const a = await predictor.predict(selection);
  const b = await predictor.predict({aiId:'ai_second'});
  const aExpected = execFileSync('/usr/bin/python3', ['-I', '-B', '-S', '-c', `
import json, sys
sys.path.insert(0, '.')
from engine import prediction
from game_runtime.predict_bridge import model_from_record
data = json.load(sys.stdin)
print(json.dumps({"probabilities": prediction(model_from_record(data["model"]), tuple(data["prices"]))}))
`], {cwd:new URL('../', predictorUrl), env:{}, encoding:'utf8',
    input:JSON.stringify({model:trend.model, prices:history.map(row => JSON.parse(row.raw).price)})});
  assert.deepEqual(a, JSON.parse(aExpected));
  assert.notDeepEqual(a.probabilities, b.probabilities);
  assert.deepEqual(await readdir(options.directory), []);
  assert.deepEqual(await lifecycle.snapshot(), {revision, ledger});
  assert.equal(state.reads, 0);
});

test('P7 rejects invalid rows throughout the history, disallowed clocks and external prediction fields', async t => {
  const fixture = await setup(t, trend);
  const {state, initial, lifecycle, options} = fixture;
  let rows = history;
  let calls = 0;
  const predictor = await openForwardPredictor(predictionConfig(fixture, () => {calls++; return rows;}));
  for (const override of [{prices:[110]}, {futurePrices:[110]}, {result:'UP'},
    {symbol:'OTHER'}, {targetAt:iso(target)}, {model:trend.model}, {sourceMode:'MARKET_UNCONNECTED'}]) {
    await assert.rejects(predictor.freeze({...selection, ...override}), /only a saved AI ID/);
  }
  await assert.rejects(predictor.freeze(selection, [110]), /only a saved AI ID/);
  await assert.rejects(predictor.freeze({aiId:'control'}), /saved MOCK_NONLIVE wallet generation/);
  assert.equal(calls, 0);
  const [first, ...rest] = history;
  const firstAt = issue - 25 * minute;
  for (const [badRows, error] of [
    [[{...first, raw:first.raw.replace('"price":76','"price":77')}, ...rest], /Invalid signed/],
    [[signedTrade(firstAt, 76, {sourceId:'OTHER_SOURCE'}), ...rest], /Invalid signed/],
    [[signedTrade(firstAt, 76, {symbol:'OTHER'}), ...rest], /Invalid signed/],
    [[signedTrade(firstAt, 76, {market:'OTHER'}), ...rest], /Invalid signed/],
    [[signedTrade(firstAt, 76, {valueKind:'BID'}), ...rest], /Invalid signed/],
    [[signedTrade(firstAt, 0), ...rest], /Invalid signed/],
    [[{...first, futurePrice:110}, ...rest], /signed history envelope/],
    [[first, ...history], /out of order/],
    [[rest[0], first, ...rest.slice(1)], /out of order/],
    [[...history, scenarioTrade(target, 110)], /not yet published/],
    [[...history, signedTrade(issue, 110, {publishedAt:iso(issue + 1)})], /not yet published/],
    [[...history, signedTrade(issue - 1, 110, {publishedAt:iso(issue - 2)})], /Invalid signed/],
    [history.slice(0, -10), /stale/],
    [history.slice(-8), /Insufficient history/],
    [Array(201).fill(first), /history size/],
  ]) {
    rows = badRows;
    await assert.rejects(predictor.freeze(selection), error);
  }
  rows = history;
  state.status = 'HALTED';
  await assert.rejects(predictor.freeze(selection), /not OPEN/);
  state.status = 'OPEN';
  state.authorized = false;
  await assert.rejects(predictor.freeze(selection), /利用許可/);
  state.authorized = true;
  state.now = target;
  await assert.rejects(predictor.freeze(selection), /closed prediction window/);
  state.now = issue;
  const late = await openForwardPredictor(predictionConfig(fixture, async () => {
    state.now = target;
    return history;
  }));
  await assert.rejects(late.freeze(selection), /closed prediction window/);
  const crossing = await openForwardPredictor({...predictionConfig(fixture),
    clock:() => state.stamps.shift()});
  state.stamps = [issue, issue, issue, target];
  await assert.rejects(crossing.freeze(selection), {code:'FORWARD_FORECAST_CUTOFF'});
  assert.deepEqual(await readdir(options.directory), []);
  assert.deepEqual(await lifecycle.snapshot(), initial);
  assert.equal(state.reads, 0);
});

test('P7 accepts only a dedicated signed mock adapter and a matching mock ledger', async t => {
  const fixture = await setup(t, trend);
  const config = predictionConfig(fixture, () => assert.fail('Unexpected history read'));
  await assert.rejects(openForwardPredictor({...config, marketAdapter:{}}), /signed MOCK_NONLIVE/);
  const liveHandle = createForwardMarketAdapter({...fixture.config, sourceId:'OTHER_SOURCE',
    verifyUsage:() => true, verifyRecord:() => null, marketStatusAt:() => 'OPEN', readBatch:() => []});
  await assert.rejects(openForwardPredictor({...config, marketAdapter:liveHandle}), /signed MOCK_NONLIVE/);
  const walletFile = join(fixture.root, 'unconnected.json');
  await seedWallet(walletFile, undefined, trend);
  const predictor = await openForwardPredictor({...config, walletFile});
  await assert.rejects(predictor.freeze(selection), /saved MOCK_NONLIVE wallet generation/);
});

test('P7 CLI rejects extra data, invalid models and invalid or oversized price sequences', () => {
  const valid = {model:trend.model, prices:Array(9).fill(100)};
  for (const raw of [
    JSON.stringify({...valid, futurePrices:[110]}),
    JSON.stringify({...valid, result:'UP'}),
    JSON.stringify({...valid, model:{...valid.model, slow_window:21}}),
    JSON.stringify({...valid, model:{...valid.model, plugin_strengths:{}}}),
    JSON.stringify({...valid, model:{...valid.model, fast_window:true}}),
    JSON.stringify({...valid, prices:Array(8).fill(100)}),
    JSON.stringify({...valid, prices:Array(201).fill(100)}),
    JSON.stringify({...valid, prices:[0, ...valid.prices]}),
    JSON.stringify({...valid, prices:[true, ...valid.prices]}),
    JSON.stringify({...valid, prices:['INFINITY', ...valid.prices]}).replace('"INFINITY"', '1e999'),
    JSON.stringify(valid) + ' '.repeat(16 * 1024),
    JSON.stringify(valid).replace('"prices":','"prices":[],"prices":'),
  ]) {
    const result = spawnSync('/usr/bin/python3', ['-I', '-B', '-S', cli],
      {input:raw, encoding:'utf8', timeout:3000, env:{}});
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});

test('P7 closes on Python failure, timeout, excess stdout and invalid output without publishing', async t => {
  const fixture = await setup(t, trend);
  const runtime = join(fixture.root, 'runtime');
  await mkdir(runtime);
  const path = join(runtime, 'forward-predict.mjs');
  await copyFile(predictorUrl, path);
  for (const name of ['forward-forecast-store', 'forward-market-adapter', 'forward-market-guard',
    'forward-model', 'forward-paper', 'forward-score', 'forward-store']) {
    await symlink(fileURLToPath(new URL('./' + name + '.mjs', predictorUrl)), join(runtime, name + '.mjs'));
  }
  const bridge = join(runtime, 'forward_predict_bridge.py');
  const {openForwardPredictor:openWithTestBridge} = await import(pathToFileURL(path));
  const predictor = await openWithTestBridge(predictionConfig(fixture));
  for (const script of [
    'import sys\nsys.exit(1)',
    'import time\ntime.sleep(60)',
    'print("x" * 2048)',
    'print("not JSON")',
    'print(\'{"probabilities":{"UP":0.9,"FLAT":0.9,"DOWN":0.9}}\')',
  ]) {
    await writeFile(bridge, 'import sys\nsys.stdin.read()\n' + script);
    await assert.rejects(predictor.freeze(selection), /Forward Python prediction failed/);
    assert.deepEqual(await readdir(fixture.options.directory), []);
  }
  assert.deepEqual(await fixture.lifecycle.snapshot(), fixture.initial);
});

test('P7 freeze binds the P4 reference and survives duplicate calls, process restart and mock scoring', async t => {
  const fixture = await setup(t, trend);
  const {lifecycle, options, initial, batch, state, root} = fixture;
  const predictor = await openForwardPredictor(predictionConfig(fixture));
  const saved = await predictor.freeze(selection);
  const {forecast, receipt} = saved;
  assert.equal(forecast.sourceMode, 'TEST_ONLY');
  assert.equal(forecast.modelHash, trend.modelHash);
  assert.equal(forecast.model_version, trend.model_version);
  assert.equal(forecast.targetAt, iso(target));
  assert.equal(forecast.symbol, input.symbol);
  assert.ok(!Object.hasOwn(forecast, 'predictedChangePct'));
  assert.equal(saved.outcome, null);
  assert.deepEqual(await lifecycle.snapshot(), initial);
  assert.equal(state.reads, 0);
  const id = receipt.forecastId;

  const reopened = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {openForwardForecastStore} from ${JSON.stringify(new URL('./forward-forecast-store.mjs', predictorUrl).href)};
    const store = await openForwardForecastStore(${JSON.stringify({
      walletFile:options.walletFile, directory:options.directory,
    })});
    console.log(JSON.stringify(await store.read(${JSON.stringify(id)}, {readOnly:true})));
  `], {encoding:'utf8'});
  assert.deepEqual(JSON.parse(reopened), saved);
  const restarted = await openForwardPredictor(predictionConfig(fixture));
  await assert.rejects(restarted.freeze(selection), {code:'FORWARD_FORECAST_EXISTS'});
  const wrongReference = signedTrade(issue - minute, 100, {fixture:'different'});
  const wrong = await openForwardMockLifecycle({...options, reference:wrongReference});
  await assert.rejects(wrong.reserveOpen(id), /differs from the frozen prediction reference/);
  const reserved = await lifecycle.reserveOpen(id);
  assert.equal(reserved.action, 'OPEN_LONG');
  assert.deepEqual(reserved.ledger.pending[0].mockForecast.reference, history.at(-1));
  await batch(entry, scenarioTrade(entry, 102));
  await lifecycle.reserveClose(id);
  const settled = await batch(target, scenarioTrade(target, 110));
  const otherWallet = join(root, 'unconnected.json');
  await seedWallet(otherWallet, undefined, trend);
  const legacy = await openForwardForecastStore({directory:options.directory, walletFile:otherWallet,
    clock:() => state.now, readMockOutcome:() => assert.fail('Unexpected unsigned score lookup')});
  await assert.rejects(legacy.scoreMock(id), /require signed settlement evidence/);
  const result = await lifecycle.score(id);
  assert.equal(result.status, 'SCORED_MOCK_NONLIVE');
  assert.equal(result.observation.referenceTradeAt, iso(issue - minute));
  assert.equal(result.observation.referencePrice, 100);
  assert.equal(result.observation.targetPrice, 110);
  assert.equal(result.score.directionCorrect, true);
  assert.equal(result.score.absoluteChangeErrorPctPoints, null);
  assert.ok(settled.ledger.journal.every(event => event.modelHash === forecast.modelHash && event.aiId === forecast.aiId));
  const request = await serveRecords(t, {forwardLedgerFile:options.walletFile,
    forwardRecords:{forecastId:id, source:lifecycle.recordSource}});
  const response = await request();
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.status, 'MOCK_NONLIVE');
  assert.equal(report.records[0].predictedChangePct, null);
  assert.ok(!JSON.stringify(report).includes(forecast.provenance.mockReferenceSha256));
  for (const path of ['/api/companion/forward-predict', '/forward-predict.mjs']) {
    assert.equal((await request(path)).status, 404);
    assert.equal((await request(path, {method:'POST'})).status, 404);
  }
});
