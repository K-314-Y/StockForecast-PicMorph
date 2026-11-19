import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {deriveForwardAppearanceModel, identifyForwardAppearanceModel} from '../../game_runtime/appearance-model.mjs';
import {openForwardForecastStore} from '../../game_runtime/forward-forecast-store.mjs';
import {scoreMockForecast} from '../../game_runtime/forward-score.mjs';
import {openForwardStore, saveForwardAppearanceGeneration} from '../../game_runtime/forward-store.mjs';

const ISSUE = Date.parse('2030-01-07T00:00:00.000Z');
const TARGET = ISSUE + 60_000;
const iso = time => new Date(time).toISOString();
const APPEARANCE = deriveForwardAppearanceModel(
  {hair_style:'bob', expression:'cheerful', accessory:'none'},
  {hair_color:'#808080', clothing_color:'#808080'},
);
const {modelHash, model_version} = identifyForwardAppearanceModel(APPEARANCE);
const INPUT = {
  aiId:'ai_test', modelHash, model_version, symbol:'FAKE', targetAt:iso(TARGET),
  sourceMode:'TEST_ONLY', probabilities:{UP:.7, FLAT:.2, DOWN:.1},
  direction:'UP', predictedChangePct:4,
};
const mockTrade = ({forecastId, symbol, targetAt}) => ({
  forecastId, symbol, targetAt, sourceMode:'MOCK_NONLIVE', status:'OBSERVED', evidence:'fixture-01',
  referenceTradeAt:iso(ISSUE - 1_000), referencePrice:100, targetTradeAt:targetAt, targetPrice:105,
});

async function setup(t, {legacy = false} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forward-forecast-')));
  t.after(() => rm(root, {recursive:true, force:true}));
  const directory = join(root, 'forecasts');
  await mkdir(directory, {mode:0o700});
  const walletFile = join(root, 'wallet.json');
  if (legacy) {
    await openForwardStore({filePath:walletFile,
      initial:{initialMedals:100, allocations:[{id:INPUT.aiId, modelHash, medals:10}]}});
  } else {
    await saveForwardAppearanceGeneration({filePath:walletFile, aiId:INPUT.aiId,
      appearance:APPEARANCE, medals:10, expectedRevision:null});
  }
  let time = ISSUE;
  const options = {directory, walletFile, clock:() => time, readMockOutcome:mockTrade};
  const store = await openForwardForecastStore(options);
  return {store, options, directory, walletFile, moveTo:instant => {time = instant;}};
}

test('walletFile must be explicit before any filesystem access', async () => {
  for (const walletFile of [undefined, null, '', '   ', 1]) {
    await assert.rejects(openForwardForecastStore({walletFile}), /explicit walletFile/);
  }
});

test('durably freezes the exact saved model generation without touching wallet bytes', async t => {
  const {store, options, walletFile, directory} = await setup(t);
  const walletBytes = await readFile(walletFile);
  const {forecast, receipt, outcome} = await store.freeze({...INPUT, targetAt:iso(TARGET).replace('.000', '')});
  assert.deepEqual(forecast, {...INPUT, forecastId:receipt.forecastId, issuedAt:iso(ISSUE),
    provenance:{walletRevision:0, model:APPEARANCE.model}});
  assert.equal(receipt.confirmedAt, iso(ISSUE));
  assert.equal(outcome, null);
  const file = await readFile(join(directory, forecast.forecastId + '.forecast.json'), 'utf8');
  const envelope = JSON.parse(file);
  assert.equal(receipt.forecastSha256, envelope.checksum);
  assert.equal(receipt.forecastSha256, createHash('sha256')
    .update(JSON.stringify({kind:'forecast', payload:envelope.payload, version:1})).digest('hex'));
  const reopened = await openForwardForecastStore(options);
  assert.deepEqual(await reopened.read(forecast.forecastId), {forecast, receipt, outcome});
  assert.deepEqual(await readFile(walletFile), walletBytes);
  assert.equal((await readdir(directory)).length, 3);
});

test('rejects wrong model identity, unknown AI and legacy wallets without a saved version', async t => {
  const {store, directory} = await setup(t);
  for (const change of [{model_version:'appearance-v2'}, {modelHash:'0'.repeat(64)}, {aiId:'ai_missing'}]) {
    await assert.rejects(store.freeze({...INPUT, ...change}), /saved wallet generation|no saved appearance/);
  }
  assert.deepEqual(await readdir(directory), []);
  const legacy = await setup(t, {legacy:true});
  await assert.rejects(legacy.store.freeze(INPUT), /no saved appearance model_version/);
});

test('rejects untrusted timestamps, future data, bad source modes and inconsistent predictions', async t => {
  const {store, directory} = await setup(t);
  for (const extra of [
    {issuedAt:iso(ISSUE)}, {generatedAt:iso(ISSUE)}, {forecastId:'fake'}, {provenance:{}},
    {targetPrice:105}, {observation:{}}, {sourceMode:'LIVE'}, {sourceMode:'MOCK_NONLIVE'},
    {symbol:'invalid'}, {targetAt:'2030-02-30T00:00:00Z'}, {direction:'down'},
    {direction:'DOWN', predictedChangePct:4}, {predictedChangePct:0}, {predictedChangePct:-100},
    {predictedChangePct:10_001}, {predictedChangePct:Infinity}, {predictedChangePct:'4'},
    {predictedChangePct:undefined}, {probabilities:{UP:.7, FLAT:.2, DOWN:.2}},
    {probabilities:{UP:1.1, FLAT:0, DOWN:-.1}}, {probabilities:{UP:NaN, FLAT:0, DOWN:1}},
    {probabilities:{UP:'0.7', FLAT:.2, DOWN:.1}},
    {probabilities:{...INPUT.probabilities, targetPrice:105}},
  ]) {
    await assert.rejects(store.freeze({...INPUT, ...extra}), RangeError);
  }
  await assert.rejects(store.freeze({...INPUT, targetAt:iso(ISSUE)}), {code:'FORWARD_FORECAST_CUTOFF'});
  assert.deepEqual(await readdir(directory), []);
});

test('concurrent stores confirm a slot once and cannot overwrite it on retry', async t => {
  const {store, options, directory} = await setup(t);
  const other = await openForwardForecastStore(options);
  const results = await Promise.allSettled([
    store.freeze(INPUT), other.freeze({...INPUT, predictedChangePct:8}),
  ]);
  const winner = results.find(result => result.status === 'fulfilled')?.value;
  assert.ok(winner);
  assert.equal(results.find(result => result.status === 'rejected')?.reason.code, 'FORWARD_FORECAST_LOCKED');
  await assert.rejects(other.freeze(INPUT), {code:'FORWARD_FORECAST_EXISTS'});
  assert.deepEqual(await store.read(winner.forecast.forecastId), winner);
  assert.equal((await readdir(directory)).length, 3);
});

test('disk failure before forecast publication leaves no confirmation and can be retried before cutoff', async t => {
  const {store, directory, moveTo} = await setup(t);
  const probe = await open(directory);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const failure = t.mock.method(prototype, 'sync', async () => {
    throw Object.assign(new Error('injected EIO'), {code:'EIO'});
  });
  await assert.rejects(store.freeze(INPUT), {code:'EIO'});
  failure.mock.restore();
  assert.deepEqual(await readdir(directory), []);
  moveTo(ISSUE + 10);
  assert.equal((await store.freeze(INPUT)).receipt.confirmedAt, iso(ISSUE + 10));
});

test('crossing cutoff while saving the forecast or receipt cannot be recovered into a confirmed forecast', async t => {
  for (const stampsBeforeCutoff of [1, 2]) {
    const {options, store, directory, moveTo} = await setup(t);
    let stamps = 0;
    const slow = await openForwardForecastStore({...options,
      clock:() => ++stamps <= stampsBeforeCutoff ? ISSUE : TARGET});
    await assert.rejects(slow.freeze(INPUT), {code:'FORWARD_FORECAST_CUTOFF'});
    const files = await readdir(directory);
    const file = files.find(name => name.endsWith('.forecast.json'));
    assert.match(file, /^[a-f0-9]{64}\.forecast\.json$/);
    assert.equal(files.length, stampsBeforeCutoff);
    const id = file.split('.')[0];
    moveTo(TARGET);
    await assert.rejects(store.scoreMock(id), {code:'FORWARD_FORECAST_UNCONFIRMED'});
    await assert.rejects(store.freeze(INPUT), {code:'FORWARD_FORECAST_UNCONFIRMED'});
  }
});

test('abrupt process stop after forecast sync cannot be confirmed or scored on restart', async t => {
  const {options, directory, moveTo} = await setup(t);
  const module = new URL('../../game_runtime/forward-forecast-store.mjs', import.meta.url);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {openForwardForecastStore} from ${JSON.stringify(module.href)};
    let first = true;
    const store = await openForwardForecastStore({
      directory:${JSON.stringify(directory)}, walletFile:${JSON.stringify(options.walletFile)},
      clock:() => { if (!first) process.exit(0); first = false; return ${ISSUE}; },
    });
    await store.freeze(${JSON.stringify(INPUT)});
    process.exit(42);
  `]);
  const files = await readdir(directory);
  assert.equal(files.length, 2);
  const id = files.find(file => file.endsWith('.forecast.json')).split('.')[0];
  const restarted = await openForwardForecastStore(options);
  moveTo(TARGET);
  await assert.rejects(restarted.scoreMock(id), {code:'FORWARD_FORECAST_LOCKED'});
  await rmdir(join(directory, id + '.lock'));
  await assert.rejects(restarted.read(id), {code:'FORWARD_FORECAST_UNCONFIRMED'});
  await assert.rejects(restarted.scoreMock(id), {code:'FORWARD_FORECAST_UNCONFIRMED'});
});

test('receipt fsync failure before or after publication never confirms the forecast', async t => {
  for (const failingSync of [3, 4]) {
    const {options, store, directory, moveTo} = await setup(t);
    const probe = await open(directory);
    const prototype = Object.getPrototypeOf(probe);
    const sync = probe.sync;
    await probe.close();
    let syncs = 0;
    const failure = t.mock.method(prototype, 'sync', async function () {
      if (++syncs === failingSync) throw Object.assign(new Error('injected receipt EIO'), {code:'EIO'});
      return sync.call(this);
    });
    await assert.rejects(store.freeze(INPUT),
      {code:failingSync === 3 ? 'EIO' : 'FORWARD_FORECAST_COMMIT_UNCERTAIN'});
    failure.mock.restore();
    const files = await readdir(directory);
    assert.equal(files.length, failingSync - 2);
    const id = files.find(file => file.endsWith('.forecast.json')).split('.')[0];
    moveTo(TARGET);
    const restarted = await openForwardForecastStore(options);
    await assert.rejects(restarted.scoreMock(id), {code:'FORWARD_FORECAST_UNCONFIRMED'});
  }
});

test('the receipt detects a changed forecast even when its checksum is recomputed', async t => {
  const {store, directory, moveTo} = await setup(t);
  const {forecast:{forecastId}} = await store.freeze(INPUT);
  const path = join(directory, forecastId + '.forecast.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.payload.predictedChangePct = 5;
  envelope.checksum = createHash('sha256')
    .update(JSON.stringify({kind:'forecast', payload:envelope.payload, version:1})).digest('hex');
  await writeFile(path, JSON.stringify(envelope));
  moveTo(TARGET);
  await assert.rejects(store.read(forecastId), {code:'FORWARD_FORECAST_CORRUPT'});
  await assert.rejects(store.scoreMock(forecastId), {code:'FORWARD_FORECAST_CORRUPT'});
});

test('a tampered receipt or outcome is rejected and never replaced', async t => {
  const {store, directory, moveTo} = await setup(t);
  const {forecast:{forecastId}} = await store.freeze(INPUT);
  moveTo(TARGET);
  await store.scoreMock(forecastId);
  for (const kind of ['receipt', 'confirmation', 'outcome']) {
    const path = join(directory, forecastId + '.' + kind + '.json');
    const valid = await readFile(path, 'utf8');
    const tampered = valid + '\n';
    await writeFile(path, tampered);
    await assert.rejects(store.scoreMock(forecastId), {code:'FORWARD_FORECAST_CORRUPT'});
    assert.equal(await readFile(path, 'utf8'), tampered);
    await writeFile(path, valid);
  }
});

test('only TEST_ONLY can score and only through the server mock source after its target', async t => {
  const {options, directory, moveTo} = await setup(t);
  let reads = 0;
  let observation;
  const store = await openForwardForecastStore({...options, readMockOutcome:request => {
    reads++;
    assert.ok(Object.isFrozen(request));
    return observation && {...mockTrade(request), ...observation};
  }});
  const {forecast:{forecastId}} = await store.freeze(INPUT);
  const market = await store.freeze({...INPUT, sourceMode:'MARKET_UNCONNECTED'});
  assert.notEqual(market.forecast.forecastId, forecastId);
  await assert.rejects(store.scoreMock(market.forecast.forecastId), /scoring is closed/);
  assert.deepEqual(await store.scoreMock(forecastId), {status:'PENDING', forecastId});
  assert.equal(reads, 0);
  moveTo(TARGET);
  assert.deepEqual(await store.scoreMock(forecastId), {status:'PENDING', forecastId});
  observation = {sourceMode:'LIVE'};
  await assert.rejects(store.scoreMock(forecastId), /MOCK_NONLIVE/);
  assert.equal((await readdir(directory)).length, 6);
  assert.equal(reads, 2);
});

test('invalid mock observation fields never append an outcome', async t => {
  const {options, directory, moveTo} = await setup(t);
  let change;
  const store = await openForwardForecastStore({...options,
    readMockOutcome:request => ({...mockTrade(request), ...change})});
  const {forecast:{forecastId}} = await store.freeze(INPUT);
  moveTo(TARGET + 1);
  for (change of [
    {forecastId:'0'.repeat(64)}, {symbol:'DIFF'}, {status:'PENDING'},
    {targetAt:iso(TARGET + 1)}, {targetTradeAt:iso(TARGET - 1)}, {targetTradeAt:iso(TARGET + 1)},
    {referenceTradeAt:iso(ISSUE + 1)}, {targetTradeAt:'invalid'}, {evidence:''}, {evidence:'  '},
    {evidence:'e'.repeat(257)}, {referencePrice:0}, {referencePrice:-1}, {referencePrice:1e-12},
    {targetPrice:NaN}, {targetPrice:Infinity}, {targetPrice:'105'}, {targetPrice:1e10}, {cash:1000},
  ]) {
    await assert.rejects(store.scoreMock(forecastId), RangeError);
  }
  assert.equal((await readdir(directory)).length, 3);
});

test('scoring appends once across concurrent calls and restart while original bytes and wallet stay fixed', async t => {
  const {options, walletFile, directory, moveTo, store} = await setup(t);
  const {forecast:{forecastId}} = await store.freeze(INPUT);
  const files = [walletFile, ...['forecast', 'receipt', 'confirmation']
    .map(kind => join(directory, forecastId + '.' + kind + '.json'))];
  const before = await Promise.all(files.map(file => readFile(file)));
  moveTo(TARGET);
  let release;
  let started;
  const entered = new Promise(resolve => {started = resolve;});
  const hold = new Promise(resolve => {release = resolve;});
  const scorer = await openForwardForecastStore({...options, readMockOutcome:async request => {
    started();
    await hold;
    return mockTrade(request);
  }});
  const pending = scorer.scoreMock(forecastId);
  await entered;
  try {
    await assert.rejects(store.scoreMock(forecastId), {code:'FORWARD_FORECAST_LOCKED'});
  } finally {
    release();
  }
  const scored = await pending;
  const restarted = await openForwardForecastStore({...options, readMockOutcome:() => assert.fail('already scored')});
  assert.deepEqual(await restarted.scoreMock(forecastId), scored);
  assert.equal(scored.status, 'SCORED_MOCK_NONLIVE');
  assert.equal(scored.sourceMode, 'MOCK_NONLIVE');
  assert.equal(scored.score.directionCorrect, true);
  assert.equal(scored.score.absoluteChangeErrorPctPoints, 1);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
  assert.equal((await readdir(directory)).length, 4);
});

test('Brier, direction correctness and percentage-point error are separate for all classes', () => {
  const forecast = {...INPUT, forecastId:'a'.repeat(64), issuedAt:iso(ISSUE)};
  for (const {price, actualDirection, brier, hit, error} of [
    {price:105, actualDirection:'UP', brier:.14, hit:true, error:1},
    {price:100, actualDirection:'FLAT', brier:1.14, hit:false, error:4},
    {price:95, actualDirection:'DOWN', brier:1.34, hit:false, error:9},
  ]) {
    const score = scoreMockForecast(forecast, {...mockTrade(forecast), targetPrice:price}, iso(TARGET));
    assert.equal(score.actualDirection, actualDirection);
    assert.ok(Math.abs(score.brier - brier) < 1e-12);
    assert.equal(score.directionCorrect, hit);
    assert.equal(score.absoluteChangeErrorPctPoints, error);
  }
  const {direction, predictedChangePct, ...probabilityOnly} = forecast;
  const tie = {...probabilityOnly, probabilities:{UP:.5, FLAT:.5, DOWN:0}};
  const tied = scoreMockForecast(tie, mockTrade(tie), iso(TARGET));
  assert.equal(tied.brier, .5);
  assert.equal(tied.directionCorrect, null);
  assert.equal(tied.absoluteChangeErrorPctPoints, null);
  const inferred = scoreMockForecast(probabilityOnly, mockTrade(probabilityOnly), iso(TARGET));
  assert.equal(inferred.predictedDirection, 'UP');
});
