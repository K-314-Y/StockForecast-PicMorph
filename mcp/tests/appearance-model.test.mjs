import assert from 'node:assert/strict';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import {deriveAppearanceModel, deriveForwardAppearanceModel, identifyForwardAppearanceModel} from '../../game_runtime/appearance-model.mjs';
import {APPROACHES, createCompanionStore} from '../../game_runtime/companion.mjs';
import {deriveForwardCompanionModel, identifyForwardModel} from '../../game_runtime/forward-model.mjs';
import {openForwardStore, saveForwardAppearanceGeneration} from '../../game_runtime/forward-store.mjs';
import {LOOK_CHOICES, createLookStore} from '../../game_runtime/looks.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

const LOOK = Object.freeze({hair_style:'bob', expression:'cheerful', accessory:'none'});
const COLORS = Object.freeze({hair_color:'#808080', clothing_color:'#808080'});
const COMPANION = {name:'相棒', ...COLORS, approach:'reversion', risk_percent:75};
const PREVIEW = '/api/companion/forward-model';
const FORWARD_AI = '/api/companion/forward-ai';
const ALLOCATIONS = {mine:100, owl:0, turtle:0};
const MODEL = {fast_window:3, slow_window:9, risk_fraction:.35,
  plugin_weights:{trend:100, momentum:0, reversion:0, volatility:0},
  plugin_strengths:{trend:117, momentum:83, reversion:105, volatility:92}};

test('appearance mapping is deterministic, rounds weights to 100 and validates its inputs', () => {
  assert.deepEqual(deriveAppearanceModel(LOOK, COLORS), {
    model_version:'appearance-v1_42_23_23_12_50',
    model:{plugin_weights:{trend:42, momentum:23, reversion:23, volatility:12}, risk_fraction:.50},
  });
  const colors = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#a3bc51'];
  for (const hair_style of LOOK_CHOICES.hair_style) {
    for (const expression of LOOK_CHOICES.expression) {
      for (const accessory of LOOK_CHOICES.accessory) {
        for (const hair_color of colors) {
          for (const clothing_color of colors) {
            const {model} = deriveAppearanceModel({hair_style, expression, accessory}, {hair_color, clothing_color});
            const weights = Object.values(model.plugin_weights);
            assert.deepEqual(Object.keys(model.plugin_weights), APPROACHES);
            assert.ok(weights.every(weight => Number.isInteger(weight) && weight >= 0 && weight <= 100));
            assert.equal(weights.reduce((sum, weight) => sum + weight, 0), 100);
            assert.ok(model.risk_fraction >= .05 && model.risk_fraction <= 1);
          }
        }
      }
    }
  }
  for (const invalid of [null, [], {...LOOK, hair_style:'unknown'}, {...LOOK, expression:'unknown'},
    {...LOOK, accessory:'unknown'}, {...LOOK, medals:100}]) {
    assert.throws(() => deriveAppearanceModel(invalid, COLORS), {status:400});
  }
  for (const invalid of [null, {}, {...COLORS, hair_color:'#123'}, {...COLORS, clothing_color:123},
    {...COLORS, hair_color:'#123456\n'}, {...COLORS, clothing_color:'#abcdzz'}]) {
    assert.throws(() => deriveAppearanceModel(LOOK, invalid), {status:400});
  }
});

test('each part and color changes the intended settings and near colors stay close', () => {
  const baseline = deriveAppearanceModel(LOOK, COLORS);
  for (const [hair_style, signal] of [['long', 'reversion'], ['twintails', 'momentum']]) {
    const {model} = deriveAppearanceModel({...LOOK, hair_style}, COLORS);
    assert.ok(model.plugin_weights[signal] >= baseline.model.plugin_weights[signal] + 10);
  }
  for (const [accessory, signal] of [['ribbon', 'momentum'], ['glasses', 'reversion'], ['star', 'volatility']]) {
    const {model} = deriveAppearanceModel({...LOOK, accessory}, COLORS);
    assert.ok(model.plugin_weights[signal] >= baseline.model.plugin_weights[signal] + 10);
  }
  for (const field of ['hair_color', 'clothing_color']) {
    const red = deriveAppearanceModel(LOOK, {...COLORS, [field]:'#FF0000'}).model;
    const blue = deriveAppearanceModel(LOOK, {...COLORS, [field]:'#0000ff'}).model;
    assert.ok(red.plugin_weights.momentum >= blue.plugin_weights.momentum + 8);
    assert.ok(blue.plugin_weights.trend >= red.plugin_weights.trend + 8);
    const dark = deriveAppearanceModel(LOOK, {...COLORS, [field]:'#000000'}).model;
    const light = deriveAppearanceModel(LOOK, {...COLORS, [field]:'#ffffff'}).model;
    assert.ok(light.risk_fraction - dark.risk_fraction >= .15);
  }
  const calm = deriveAppearanceModel({...LOOK, expression:'calm'}, COLORS);
  assert.deepEqual(calm.model.plugin_weights, baseline.model.plugin_weights);
  assert.equal(calm.model.risk_fraction, .32);
  assert.equal(deriveAppearanceModel({...LOOK, expression:'determined'}, COLORS).model.risk_fraction, .68);
  assert.notEqual(calm.model_version, baseline.model_version);

  assert.deepEqual(deriveAppearanceModel(LOOK, {...COMPANION, risk_percent:5, medals:10000}), baseline);
  assert.deepEqual(deriveAppearanceModel(LOOK, {hair_color:'#81807f', clothing_color:'#7f8180'}), baseline);
  for (const [color, near] of [['#a3bc51', '#a2bd50'], ['#ff0000', '#fe0101'], ['#ffffff', '#fffeff']]) {
    const first = deriveAppearanceModel(LOOK, {hair_color:color, clothing_color:color});
    const second = deriveAppearanceModel(LOOK, {hair_color:near, clothing_color:near});
    for (const id of APPROACHES) assert.ok(Math.abs(first.model.plugin_weights[id] - second.model.plugin_weights[id]) <= 1);
    assert.ok(Math.abs(first.model.risk_fraction - second.model.risk_fraction) <= .011);
    assert.deepEqual(deriveAppearanceModel(LOOK, {hair_color:color.toUpperCase(), clothing_color:color}), first);
  }
});

async function request(server, path, payload, headers = {}) {
  const bytes = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
  const req = Readable.from(bytes ? [bytes] : []);
  req.method = bytes ? 'POST' : 'GET';
  req.url = path;
  req.headers = {host:'127.0.0.1:18890', ...(bytes && {
    'content-type':'application/json', 'content-length':String(bytes.length),
  }), ...headers};
  req.socket = {remoteAddress:'127.0.0.1'};
  server.address = () => ({port:18890});
  return new Promise((resolve, reject) => {
    let status, headers;
    server.listeners('request')[0](req, {
      writeHead(code, fields) {status = code; headers = fields;},
      end(body) {resolve({status, headers, data:JSON.parse(body.toString())});},
    }).catch(reject);
  });
}

test('legacy appearance-only HTTP API cannot drive practice', async () => {
  const unavailable = () => assert.fail('legacy input was used');
  const server = createGameServer({loadSnapshot:unavailable, predict:unavailable});
  assert.equal((await request(server, '/api/companion/appearance-model')).status, 404);
  for (const path of ['/api/practice', '/api/practice/preview']) {
    const result = await request(server, path, {allocations:ALLOCATIONS,
      appearance_model_version:'appearance-v1_42_23_23_12_50'});
    assert.equal(result.status, 400);
  }
});

test('forward AI GET reports an absent ledger when its parent directory is missing', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'forward-ai-missing-')));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const parent = join(dir, 'missing');
  const forwardLedgerFile = join(parent, 'nested', 'ledger.json');
  const result = await request(createGameServer({forwardLedgerFile}), FORWARD_AI);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {mode:'FORWARD_WALLETS_MARKET_UNCONNECTED', revision:null, created:false,
    initialMedals:10_000, unallocated:10_000, currentAiId:null, generations:[], wallets:{}});
  await assert.rejects(openForwardStore({filePath:forwardLedgerFile}), {code:'FORWARD_STORE_UNINITIALIZED'});
  await assert.rejects(lstat(parent), {code:'ENOENT'});
  assert.deepEqual(await readdir(dir), []);
});

test('forward AI GET reports invalid paths and corrupt ledgers as errors', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'forward-ai-invalid-')));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const corrupt = join(dir, 'ledger.json');
  const actual = join(dir, 'actual');
  const alias = join(dir, 'alias');
  const dangling = join(dir, 'dangling');
  await writeFile(corrupt, '{"broken":');
  await mkdir(actual);
  await symlink(actual, alias);
  await symlink(join(dir, 'missing'), dangling);
  for (const forwardLedgerFile of [corrupt, join(corrupt, 'ledger.json'),
    join(alias, 'missing', 'ledger.json'), join(dangling, 'nested', 'ledger.json')]) {
    const result = await request(createGameServer({forwardLedgerFile}), FORWARD_AI);
    assert.equal(result.status, 503, forwardLedgerFile);
    assert.equal(result.data.wallets, undefined);
  }
  assert.equal(await readFile(corrupt, 'utf8'), '{"broken":');
  assert.deepEqual(await readdir(actual), []);
});

for (const edited of ['look', 'colors', 'rules']) {
  test(`forward AI commit rechecks changes to ${edited}`, async t => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'forward-ai-edit-')));
    t.after(() => rm(dir, {recursive:true, force:true}));
    const companionStore = createCompanionStore({file:join(dir, 'companion.json')});
    const lookStore = createLookStore({file:join(dir, 'looks.json')});
    await companionStore.save({expected_revision:0, companion:COMPANION});
    await lookStore.save({expected_revision:0, look:LOOK});
    let companionReads = 0;
    const server = createGameServer({forwardLedgerFile:join(dir, 'ledger.json'), lookStore,
      companionStore:{...companionStore, async read() {
        if (++companionReads === 2) {
          if (edited === 'look') {
            await lookStore.save({expected_revision:1, look:{...LOOK, hair_style:'long'}});
          } else {
            const change = edited === 'rules' ? {risk_percent:50} : {hair_color:'#ff0000'};
            await companionStore.save({expected_revision:1, companion:{...COMPANION, ...change}});
          }
        }
        return companionStore.read();
      }},
    });
    const {model_version} = deriveForwardCompanionModel(COMPANION);
    const input = {aiId:'ai_first', medals:300, expected_revision:null, model_version};
    const result = await request(server, FORWARD_AI, input);
    if (edited === 'rules') {
      assert.equal(result.status, 409);
      assert.deepEqual((await readdir(dir)).sort(), ['companion.json', 'looks.json']);
      const updated = await request(server, PREVIEW);
      assert.notEqual(updated.data.model_version, model_version);
      const retry = await request(server, FORWARD_AI, {...input, model_version:updated.data.model_version});
      assert.equal(retry.status, 201);
      assert.equal(retry.data.unallocated, 9700);
    } else {
      assert.equal(result.status, 201);
      assert.equal(result.data.generations[0].model_version, model_version);
      assert.equal(result.data.unallocated, 9700);
    }
  });
}

test('forward AI API preserves legacy wallets, freezes saved rules and debits only a new generation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'forward-ai-api-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const forwardLedgerFile = join(dir, 'forward-ledger.json');
  const unavailable = () => assert.fail('wallet API must work without market or upstream model access');
  const serve = () => createGameServer({forwardLedgerFile,
    companionStore:createCompanionStore({file:join(dir, 'companion.json')}),
    lookStore:createLookStore({file:join(dir, 'looks.json')}),
    loadSnapshot:unavailable, predict:unavailable, historicalPredict:unavailable,
  });
  let server = serve();
  const get = () => request(server, FORWARD_AI);
  const preview = () => request(server, PREVIEW);
  const post = body => request(server, FORWARD_AI, body);
  const {model_version, model, modelHash} = deriveForwardCompanionModel(COMPANION);
  assert.equal(model_version, 'companion-v1_0_0_100_0_75');
  const input = {aiId:'ai_first', medals:300, expected_revision:null, model_version};
  assert.equal((await get()).data.revision, null);
  assert.equal((await get()).data.unallocated, 10_000);
  assert.equal((await preview()).data.model_version, null);
  assert.equal((await post(input)).status, 409);
  assert.equal((await request(server, FORWARD_AI, input, {origin:'http://example.test'})).status, 403);
  assert.equal((await request(server, FORWARD_AI, input, {'content-type':'text/plain'})).status, 415);
  for (const change of [{aiId:['ai_first']}, {aiId:'../wallet'}, {aiId:'__proto__'}, {aiId:'a'.repeat(41)},
    {medals:0}, {medals:-1}, {medals:1.5}, {medals:'300'}, {medals:1_000_000_000_001},
    {expected_revision:'0'}, {model:MODEL}, {modelHash:'a'.repeat(64)}, {look:LOOK}, {initialMedals:20_000},
    {model_version:'appearance-v1_42_23_23_12_50'}, {companion_revision:1, look_revision:1}]) {
    assert.equal((await post({...input, ...change})).status, 400);
  }
  assert.deepEqual(await readdir(dir), []);

  const legacy = await saveForwardAppearanceGeneration({filePath:forwardLedgerFile, aiId:'ai_legacy',
    appearance:deriveForwardAppearanceModel(LOOK, COLORS), medals:100, expectedRevision:null});
  assert.deepEqual((await get()).data.generations, legacy.ledger.appearanceGenerations);
  assert.equal((await request(server, '/api/companion', {expected_revision:0, companion:COMPANION})).status, 200);
  assert.equal((await preview()).data.model_version, model_version);
  assert.equal((await post(input)).status, 409);
  const first = await post({...input, expected_revision:0});
  assert.equal(first.status, 201);
  assert.equal(first.data.unallocated, 9600);
  assert.equal(first.data.wallets.ai_first.modelHash, modelHash);
  assert.deepEqual(first.data.generations[1], {aiId:'ai_first', model_version, model});
  assert.deepEqual(first.data.wallets.ai_legacy, legacy.ledger.wallets.ai_legacy);
  const originalBytes = await readFile(forwardLedgerFile);
  const next = {aiId:'ai_next', medals:500, expected_revision:1, model_version};
  const cosmetic = {...COMPANION, hair_color:'#ff0000', name:'編集済'};
  assert.equal((await request(server, '/api/companion', {expected_revision:1, companion:cosmetic})).status, 200);
  assert.equal((await request(server, '/api/looks', {expected_revision:0, look:{...LOOK, hair_style:'long'}})).status, 200);
  assert.equal((await preview()).data.model_version, model_version);
  const unchanged = await post(next);
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.data, {...first.data, created:false});
  assert.deepEqual(await readFile(forwardLedgerFile), originalBytes);

  const edited = {...cosmetic, approach:'momentum', risk_percent:25};
  assert.equal((await request(server, '/api/companion', {expected_revision:2, companion:edited})).status, 200);
  assert.equal((await post(next)).status, 409);
  const updated = {...next, model_version:(await preview()).data.model_version};
  assert.equal((await post({...updated, aiId:'ai_first'})).status, 409);
  assert.equal((await post({...updated, medals:9601})).status, 409);
  assert.deepEqual(await readFile(forwardLedgerFile), originalBytes);
  const second = await post(updated);
  assert.equal(second.status, 201);
  assert.equal(second.data.currentAiId, 'ai_next');
  assert.equal(second.data.unallocated, 9100);
  assert.deepEqual(second.data.generations.slice(0, 2), first.data.generations);
  assert.equal(second.data.wallets.ai_next.cash, 500);
  assert.notEqual(second.data.wallets.ai_next.modelHash, modelHash);

  server = serve();
  assert.deepEqual((await get()).data, {...second.data, created:false});
});

test('companion version and hash identify exactly the normalized fixed model', () => {
  const frozen = deriveForwardCompanionModel(COMPANION);
  const {model_version, model} = frozen;
  const reverse = obj => Object.fromEntries(Object.entries(obj).reverse());
  assert.deepEqual(identifyForwardModel({model_version, model:reverse({...model,
    plugin_weights:reverse(model.plugin_weights), plugin_strengths:reverse(model.plugin_strengths),
  })}), frozen);
  assert.throws(() => identifyForwardModel({model_version, model:{...model, fast_window:4}}), /一致/);
  assert.throws(() => identifyForwardModel({model_version, model:{...model, risk_fraction:.751}}), /一致/);
  assert.throws(() => identifyForwardModel({model_version, model:{...model,
    plugin_strengths:{...model.plugin_strengths, trend:99}}}), /一致/);
});

test('forward model hashes use canonical engine settings and the appearance rule version', () => {
  const {model_version, model} = deriveAppearanceModel(LOOK, COLORS);
  const full = {...MODEL, ...model};
  const hash = settings => identifyForwardAppearanceModel(settings).modelHash;
  const original = hash({model_version, model:full});
  assert.match(original, /^[a-f0-9]{64}$/);
  const reverse = obj => Object.fromEntries(Object.entries(obj).reverse());
  assert.equal(hash({model_version, model:reverse({...full,
    plugin_weights:reverse(full.plugin_weights), plugin_strengths:reverse(full.plugin_strengths),
  })}), original);
  assert.notEqual(hash({model_version:model_version.replace('-v1_', '-v2_'), model:full}), original);
  assert.notEqual(hash({model_version, model:{...full, slow_window:10}}), original);
  assert.throws(() => hash({model_version, model:{...full, risk_fraction:.51}}), /一致/);
  assert.throws(() => hash({model_version, model:{...full, risk_fraction:.501}}), /一致/);
});
