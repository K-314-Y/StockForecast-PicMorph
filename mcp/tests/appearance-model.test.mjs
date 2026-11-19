import assert from 'node:assert/strict';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import {deriveAppearanceModel, identifyForwardAppearanceModel} from '../../game_runtime/appearance-model.mjs';
import {APPROACHES, createCompanionStore} from '../../game_runtime/companion.mjs';
import {openForwardStore} from '../../game_runtime/forward-store.mjs';
import {LOOK_CHOICES, createLookStore} from '../../game_runtime/looks.mjs';
import {createGameServer, pythonPredict} from '../../game_runtime/server.mjs';

const LOOK = Object.freeze({hair_style:'bob', expression:'cheerful', accessory:'none'});
const COLORS = Object.freeze({hair_color:'#808080', clothing_color:'#808080'});
const COMPANION = {name:'相棒', ...COLORS, approach:'reversion', risk_percent:75};
const PREVIEW = '/api/companion/appearance-model';
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

async function request(server, path, payload) {
  const bytes = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
  const req = Readable.from(bytes ? [bytes] : []);
  req.method = bytes ? 'POST' : 'GET';
  req.url = path;
  req.headers = {host:'127.0.0.1:18890', ...(bytes && {
    'content-type':'application/json', 'content-length':String(bytes.length),
  })};
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

test('read-only preview restores saved looks and opts the same model into actual synthetic practice', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'appearance-model-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const companionFile = join(dir, 'companion.json');
  const lookFile = join(dir, 'looks.json');
  const loadSnapshot = async () => ({state:{model:MODEL}, lineup:{slots:[
    {slot:'owl', model:MODEL}, {slot:'turtle', model:MODEL},
  ]}, source_revision:1, lineup_revision:2, growth_revision:3});
  const plans = [];
  const serve = () => createGameServer({
    companionStore:createCompanionStore({file:companionFile}), lookStore:createLookStore({file:lookFile}),
    loadSnapshot, predict:async plan => {plans.push(plan); return pythonPredict(plan);},
  });
  const first = serve();
  const defaults = await request(first, PREVIEW);
  assert.equal(defaults.status, 200);
  assert.equal(defaults.data.mode, 'APPEARANCE_MODEL_PREVIEW');
  assert.equal(defaults.data.companion_created, false);
  assert.equal(defaults.data.look_created, false);
  assert.equal((await request(first, '/api/practice', {
    allocations:ALLOCATIONS, appearance_model_version:defaults.data.model_version,
  })).status, 409);
  assert.equal(plans.length, 0);
  assert.deepEqual(await readdir(dir), []);
  assert.equal((await request(first, PREVIEW, {})).status, 404);

  const look = {...LOOK, hair_style:'twintails', accessory:'star'};
  assert.equal((await request(first, '/api/companion', {expected_revision:0, companion:COMPANION})).status, 200);
  assert.equal((await request(first, '/api/looks', {expected_revision:0, look})).status, 200);
  const files = await Promise.all([readFile(companionFile), readFile(lookFile)]);
  const preview = await request(first, PREVIEW);
  const derived = deriveAppearanceModel(look, COLORS);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['Cache-Control'], 'no-store');
  assert.deepEqual(preview.data, {mode:'APPEARANCE_MODEL_PREVIEW', companion_revision:1,
    companion_created:true, look_revision:1, look_created:true, ...derived});
  const restarted = serve();
  assert.deepEqual((await request(restarted, PREVIEW)).data, preview.data);
  assert.equal(plans.length, 0);

  const settings = {allocations:ALLOCATIONS, appearance_model_version:derived.model_version};
  assert.equal((await request(restarted, '/api/practice', {...settings, appearance_model_version:1})).status, 400);
  assert.equal((await request(restarted, '/api/practice', {...settings, trained_version_id:'tv_'+'a'.repeat(32)})).status, 400);
  assert.equal((await request(restarted, '/api/practice/preview', settings)).status, 400);
  const applied = await request(restarted, '/api/practice', settings);
  assert.equal(applied.status, 200);
  assert.equal(applied.data.mode, 'PRACTICE_SYNTHETIC_ONLY');
  assert.equal(applied.data.companion_name, COMPANION.name);
  assert.equal(applied.data.approach, null);
  assert.equal(applied.data.risk_percent, Math.round(derived.model.risk_fraction * 100));
  assert.deepEqual(plans[0], {base_model:MODEL, models:{mine:{...MODEL, ...derived.model}, owl:MODEL, turtle:MODEL}});
  assert.deepEqual(applied.data.characters.mine.plugin_weights, derived.model.plugin_weights);
  assert.equal(applied.data.characters.mine.risk_fraction, derived.model.risk_fraction);
  assert.deepEqual(applied.data.brain, {kind:'appearance_model', version_id:derived.model_version,
    effective_sha256:applied.data.characters.mine.effective_sha256});

  const legacy = await request(restarted, '/api/practice', {allocations:ALLOCATIONS});
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.brain.kind, 'authored_companion');
  assert.equal(legacy.data.risk_percent, COMPANION.risk_percent);
  assert.equal(plans[1].models.mine.plugin_weights[COMPANION.approach], 100);
  assert.notEqual(legacy.data.characters.mine.effective_sha256, applied.data.brain.effective_sha256);
  assert.deepEqual(await Promise.all([readFile(companionFile), readFile(lookFile)]), files);

  const updated = {...look, expression:'calm'};
  assert.equal((await request(restarted, '/api/looks', {expected_revision:1, look:updated})).status, 200);
  const stale = await request(restarted, '/api/practice', settings);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.training_ticket, undefined);
  assert.equal(plans.length, 2);
  await writeFile(lookFile, '{}');
  assert.equal((await request(restarted, PREVIEW)).status, 503);
  assert.equal(await readFile(lookFile, 'utf8'), '{}');
});

test('editing the look during opted-in practice invalidates the result and ticket', async () => {
  let revision = 1;
  const server = createGameServer({
    lookStore:{read:async () => ({revision, created:true, look:LOOK})},
    companionStore:{read:async () => ({revision:1, created:true, companion:COMPANION})},
    loadSnapshot:async () => ({state:{model:MODEL}, lineup:{slots:[
      {slot:'owl', model:MODEL}, {slot:'turtle', model:MODEL},
    ]}, source_revision:1, lineup_revision:2, growth_revision:3}),
    predict:async plan => {revision++; return pythonPredict(plan);},
  });
  const version = (await request(server, PREVIEW)).data.model_version;
  const result = await request(server, '/api/practice', {allocations:ALLOCATIONS, appearance_model_version:version});
  assert.equal(result.status, 409);
  assert.match(result.data.error, /外見変更/);
  assert.equal(result.data.training_ticket, undefined);
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

for (const edited of ['look', 'companion']) {
  test(`forward AI POST rejects ${edited} edits during registration`, async t => {
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
            await companionStore.save({expected_revision:1, companion:{...COMPANION, hair_color:'#ff0000'}});
          }
        }
        return companionStore.read();
      }},
    });
    const input = {aiId:'ai_first', medals:300, expected_revision:null, companion_revision:1, look_revision:1};
    const stale = await request(server, FORWARD_AI, input);
    assert.equal(stale.status, 409);
    assert.deepEqual((await readdir(dir)).sort(), ['companion.json', 'looks.json']);
    const retry = await request(server, FORWARD_AI, {...input, [`${edited}_revision`]:2});
    assert.equal(retry.status, 201);
    assert.equal(retry.data.generations[0].model_version, (await request(server, PREVIEW)).data.model_version);
    assert.equal(retry.data.unallocated, 9700);
  });
}

test('forward AI API funds immutable engine models from saved parts and restores each generation', async t => {
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
  const post = body => request(server, FORWARD_AI, body);
  const input = {aiId:'ai_first', medals:300, expected_revision:null, companion_revision:1, look_revision:1};
  const empty = await get();
  assert.equal(empty.status, 200);
  assert.equal(empty.data.mode, 'FORWARD_WALLETS_MARKET_UNCONNECTED');
  assert.equal(empty.data.revision, null);
  assert.equal(empty.data.unallocated, 10_000);
  assert.equal((await post(input)).status, 409);
  assert.deepEqual(await readdir(dir), []);
  for (const change of [{aiId:['ai_first']}, {aiId:'../wallet'}, {aiId:'__proto__'}, {aiId:'a'.repeat(41)},
    {medals:0}, {medals:-1}, {medals:1.5}, {medals:'300'}, {medals:1_000_000_000_001},
    {expected_revision:'0'}, {model:MODEL}, {modelHash:'a'.repeat(64)}, {look:LOOK}, {initialMedals:20_000}]) {
    assert.equal((await post({...input, ...change})).status, 400);
  }
  assert.deepEqual(await readdir(dir), []);

  assert.equal((await request(server, '/api/companion', {expected_revision:0, companion:COMPANION})).status, 200);
  assert.equal((await request(server, '/api/looks', {expected_revision:0, look:{...LOOK, accessory:'bad'}})).status, 400);
  assert.equal((await post(input)).status, 409);
  assert.equal((await request(server, '/api/looks', {expected_revision:0, look:LOOK})).status, 200);
  assert.equal((await post({...input, look_revision:0})).status, 409);
  assert.equal((await post({...input, medals:10_001})).status, 409);
  assert.deepEqual((await get()).data, empty.data);

  const first = await post(input);
  assert.equal(first.status, 201);
  assert.equal(first.data.currentAiId, input.aiId);
  assert.equal(first.data.revision, 0);
  assert.equal(first.data.unallocated, 9700);
  const [frozen] = first.data.generations;
  const preview = (await request(server, PREVIEW)).data;
  assert.equal(frozen.model_version, preview.model_version);
  assert.deepEqual(frozen.model.plugin_weights, preview.model.plugin_weights);
  assert.equal(frozen.model.risk_fraction, preview.model.risk_fraction);
  assert.deepEqual(first.data.wallets.ai_first, {initial:300, cash:300, position:null, status:'ACTIVE',
    modelHash:identifyForwardAppearanceModel(frozen).modelHash});
  const originalBytes = await readFile(forwardLedgerFile);
  assert.equal((await post(input)).status, 409);

  const cosmetic = {...COMPANION, name:'変更後の名前', hair_color:'#81807f', clothing_color:'#7f8180', approach:'trend'};
  assert.equal((await request(server, '/api/companion', {expected_revision:1, companion:cosmetic})).status, 200);
  const next = {...input, expected_revision:0, companion_revision:2, aiId:'ai_next', medals:500};
  const unchanged = await post(next);
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.data, {...first.data, created:false});
  assert.deepEqual(await readFile(forwardLedgerFile), originalBytes);

  const changed = {...LOOK, hair_style:'long'};
  assert.equal((await request(server, '/api/looks', {expected_revision:1, look:changed})).status, 200);
  assert.equal((await post(next)).status, 409);
  const updated = {...next, look_revision:2};
  assert.equal((await post({...updated, aiId:'ai_first'})).status, 409);
  assert.equal((await post({...updated, medals:9701})).status, 409);
  assert.deepEqual(await readFile(forwardLedgerFile), originalBytes);
  const second = await post(updated);
  assert.equal(second.status, 201);
  assert.equal(second.data.currentAiId, 'ai_next');
  assert.equal(second.data.revision, 1);
  assert.equal(second.data.unallocated, 9200);
  assert.deepEqual(second.data.generations[0], frozen);
  assert.deepEqual(second.data.wallets.ai_first, first.data.wallets.ai_first);
  assert.equal(second.data.wallets.ai_next.cash, 500);
  assert.notEqual(second.data.wallets.ai_next.modelHash, first.data.wallets.ai_first.modelHash);

  server = serve();
  assert.deepEqual((await get()).data, {...second.data, created:false});
  const {model} = (await get()).data.generations[0];
  const plan = await pythonPredict({base_model:MODEL, models:{mine:model, owl:MODEL, turtle:MODEL}});
  assert.equal(plan.signals.length, 12);
  assert.deepEqual(plan.models.mine.plugin_weights, frozen.model.plugin_weights);
  assert.equal(plan.models.mine.risk_fraction, frozen.model.risk_fraction);
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
