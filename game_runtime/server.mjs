/**
 * Node game API: authoritative JS accounting plus separate Node-owned tutorial
 * XP/gear persistence. Python is a read-only model forecaster only.
 * No broker calls, V6 writes, public binding or client-supplied predictions.
 */
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {createCompanionStore, applyCompanion} from './companion.mjs';
import {createGrowthStore} from './growth.mjs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {runSyntheticGame, validateAllocations} from './practice.mjs';
import {readAppearanceCatalog, readAppearanceImage, isValidAppearanceId} from './appearance.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BRIDGE = fileURLToPath(new URL('./predict_bridge.py', import.meta.url));
const TRAINED_BRIDGE = fileURLToPath(new URL('./trained_bridge.py', import.meta.url));
const DEMO = new URL('./demo.html', import.meta.url);
const DEMO_JS = new URL('./demo.mjs', import.meta.url);
const UPSTREAM = 'http://127.0.0.1:8765';
const MAX_REQUEST = 2048;
const REVISIONS = ['source_revision', 'lineup_revision', 'growth_revision'];
const TRAINED_ID = /^tv_[0-9a-f]{32}$/;
const GEAR = Object.freeze({
  none: null,
  focus_lens: {key: 'trend', bonus: 10},
  spark_charm: {key: 'momentum', bonus: 15},
  calm_halo: {key: 'volatility', bonus: 15},
});
const SLOTS = ['mine', 'owl', 'turtle'];

function failure(message, status = 503) {
  return Object.assign(new Error(message), {status});
}

async function readJson(url) {
  const signal = AbortSignal.timeout(2200);
  const response = await fetch(url, {signal, redirect: 'error'});
  if (!response.ok) throw failure('既存のモデル状態を読めません');
  const body = await response.text();
  if (body.length > 65536) throw failure('モデル状態が大きすぎます');
  return JSON.parse(body);
}

export async function loadLocalSnapshot(store) {
  // Trusted localhost models and independent Node-owned tutorial XP state.
  const [state, lineup, growth] = await Promise.all([
    readJson(UPSTREAM + '/api/state'),
    readJson(UPSTREAM + '/api/lineup'),
    store.public(),
  ]);
  if (!state || !state.model || !Array.isArray(lineup?.slots) ||
      !Array.isArray(growth?.slots) || !Number.isSafeInteger(state.revision) ||
      !Number.isSafeInteger(lineup.revision) || !Number.isSafeInteger(growth.revision)) {
    throw failure('予測モデルの情報が不足しています');
  }
  return {state, lineup, growth,
    source_revision: state.revision,
    lineup_revision: lineup.revision,
    growth_revision: growth.revision};
}

function withGear(source, trainedModel = null) {
  const lineup = new Map(source.lineup.slots.map(x => [x.slot, x.model]));
  const gears = new Map(source.growth.slots.map(x => [x.slot, x.gear]));
  if (lineup.size !== 2 || gears.size !== 3 || !gears.has('mine') ||
      !lineup.has('owl') || !lineup.has('turtle')) {
    throw failure('編成または装備が不正です');
  }
  const models = {};
  for (const slot of SLOTS) {
    const original = slot === 'mine' ? (trainedModel || source.state.model) : lineup.get(slot);
    if (!original || typeof original !== 'object' || !original.plugin_strengths) {
      throw failure('キャラモデルが不足しています');
    }
    const gearName = gears.get(slot);
    if (typeof gearName !== 'string' || !Object.hasOwn(GEAR, gearName)) {
      throw failure('未対応の装備です');
    }
    const strengths = {...original.plugin_strengths};
    const gear = GEAR[gearName];
    if (gear) {
      if (!Number.isInteger(strengths[gear.key])) throw failure('装備感度が不正です');
      strengths[gear.key] = Math.min(150, strengths[gear.key] + gear.bonus);
    }
    models[slot] = {...original, plugin_strengths: strengths};
  }
  return {base_model: source.state.model, models};
}

export async function pythonPredict(models) {
  // execFile never runs a shell; only model settings, not arbitrary code.
  // stdin is supplied through a spawned process rather than command args.
  const {spawn} = await import('node:child_process');
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn('python3', ['-B', BRIDGE],
      {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe']});
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    let stdout = '', stderr = '', capped = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', part => {
      stdout += part;
      if (stdout.length > 65536) {capped = true; child.kill('SIGKILL');}
    });
    child.stderr.on('data', part => {stderr = (stderr + part).slice(-1024);});
    child.on('error', err => {clearTimeout(timeout); rejectResult(err);});
    child.on('close', code => {
      clearTimeout(timeout);
      if (capped || code !== 0) return rejectResult(failure('予測エンジンが応答できません'));
      try {resolveResult(JSON.parse(stdout));}
      catch {rejectResult(failure('予測結果が不正です'));}
    });
    child.stdin.end(JSON.stringify(models));
  });
}

export async function readTrainingVersions() {
  const data = await readJson('http://127.0.0.1:8884/api/blueprints/trained');
  if (!data || !Array.isArray(data.versions) || data.versions.length > 100) {
    throw failure('保存済み練習版の一覧が不正です');
  }
  const seen = new Set(), versions = [];
  let namesByDraft = new Map();
  try {
    const catalog = await readAppearanceCatalog();
    namesByDraft = new Map(catalog.drafts.map(item => [item.id, item.name]));
  } catch {
    // A broken artwork catalog cannot block an otherwise valid trained version list.
  }
  for (const entry of data.versions) {
    if (!TRAINED_ID.test(entry?.id) || seen.has(entry.id) ||
        !/^bp_[0-9a-f]{32}$/.test(entry?.source_draft_id) ||
        entry?.competition_eligible !== false || entry?.status !== 'practice_only' ||
        !/^[a-f0-9]{64}$/.test(entry?.parameters_sha256)) {
      throw failure('保存済み練習版の情報が不正です');
    }
    seen.add(entry.id);
    versions.push({id:entry.id,source_draft_id:entry.source_draft_id,
      parameters_sha256:entry.parameters_sha256,
      source_name:namesByDraft.get(entry.source_draft_id) || null});
  }
  return {versions, notice:'架空40点だけで学習。実相場の予測精度は未検証。'};
}

export async function resolveTrainedVersion(versionId) {
  if (typeof versionId !== 'string' || !TRAINED_ID.test(versionId)) {
    throw failure('保存済み練習版IDが不正です',400);
  }
  const {spawn} = await import('node:child_process');
  return new Promise((resolveResult,rejectResult) => {
    const child = spawn('python3',['-B',TRAINED_BRIDGE,versionId],
      {cwd:ROOT,stdio:['ignore','pipe','pipe']});
    const timeout = setTimeout(()=>child.kill('SIGKILL'),3500);
    let out='',failed=false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',part=>{
      out+=part;
      if(out.length>8192) {failed=true;child.kill('SIGKILL');}
    });
    child.stderr.resume(); // No secrets or arbitrary command output returned.
    child.on('error',error=>{clearTimeout(timeout);rejectResult(error);});
    child.on('close',code=>{
      clearTimeout(timeout);
      if(failed || code!==0) return rejectResult(failure('保存済み練習版を検証できません',409));
      try {
        const found=JSON.parse(out);
        if(found.version_id!==versionId || found.kind!=='trained_practice_only' ||
           typeof found.model!=='object') throw Error('invalid model');
        resolveResult(found);
      } catch {rejectResult(failure('保存済み練習版の形式が不正です'));}
    });
  });
}

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function safeLocal(req, port) {
  const remote = req.socket.remoteAddress;
  const host = req.headers.host;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = req.headers.origin;
  return (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') &&
    hosts.includes(host) && (!origin || hosts.some(h => origin === 'http://' + h)) &&
    [undefined, 'none', 'same-origin'].includes(req.headers['sec-fetch-site']) &&
    !['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(k => req.headers[k]);
}

async function getBody(req) {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw failure('JSON形式のみ対応します', 415);
  }
  if (req.headers['transfer-encoding'] ||
      !/^\d+$/.test(req.headers['content-length'] ?? '') ||
      Number(req.headers['content-length']) > MAX_REQUEST ||
      Number(req.headers['content-length']) <= 0) {
    throw failure('入力サイズが不正です', 400);
  }
  let data = '';
  for await (const part of req) {
    data += part.toString('utf8');
    if (Buffer.byteLength(data) > MAX_REQUEST) throw failure('入力が大きすぎます', 413);
  }
  if (Buffer.byteLength(data) !== Number(req.headers['content-length'])) {
    throw failure('入力が途中で切れています', 400);
  }
  try {return JSON.parse(data);}
  catch {throw failure('JSONが不正です', 400);}
}

export function createGameServer({store = createGrowthStore(), loadSnapshot,
                                  predict = pythonPredict, companionStore = createCompanionStore(),
                                  appearanceCatalog = readAppearanceCatalog,
                                  appearanceImage = readAppearanceImage,
                                  trainedVersions = readTrainingVersions,
                                  trainedVersion = resolveTrainedVersion} = {}) {
  loadSnapshot ??= () => loadLocalSnapshot(store);
  let inFlight = 0;
  const tickets = new Map();
  const TICKET_TTL_MS = 10 * 60 * 1000;
  function createTicket(allocations) {
    if (tickets.size > 128) {
      for (const [key, item] of tickets) {
        if (item.expires < Date.now() || item.used) tickets.delete(key);
      }
      if (tickets.size > 128) tickets.delete(tickets.keys().next().value);
    }
    const token = randomBytes(24).toString('hex');
    tickets.set(token, {allocations: {...allocations},
      expires: Date.now() + TICKET_TTL_MS, used: false, busy: false});
    return token;
  }

  const server = createServer(async (req, res) => {
    const port = server.address()?.port;
    if (!safeLocal(req, port)) return json(res, 403, {error: 'ローカルの同一画面からのみ利用できます'});
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/favicon.ico') {
      res.writeHead(204, {'Cache-Control': 'no-store'});
      return res.end();
    }
    if (req.method === 'GET' && path === '/health') {
      return json(res, 200, {status: 'ok', mode: 'PRACTICE_SYNTHETIC_ONLY',
        game_runtime: 'node', forecaster: 'python-model-only',
        xp: 'node-tutorial-only', server_only: true, multiuser: false});
    }
    if (req.method === 'GET' && path === '/api/trained/versions') {
      try {return json(res, 200, await trainedVersions());}
      catch {return json(res, 503, {error:'保存した練習版を読み取れません'});}
    }
    if (req.method === 'GET' && path === '/api/growth') {
      try {return json(res, 200, await store.public());}
      catch {return json(res, 503, {error:'育成情報を読み取れません'});}
    }
    if (req.method === 'GET' && path === '/api/companion') {
      try {return json(res, 200, await companionStore.read());}
      catch {return json(res, 503, {error:'相棒の保存情報を読み取れません'});}
    }
    // Read-only appearance bridge: the browser never requests the Python origin directly.
    if (req.method === 'GET' && path === '/api/appearance/drafts') {
      try { return json(res, 200, await appearanceCatalog()); }
      catch (error) {
        return json(res, [404, 413].includes(error?.status) ? error.status : 503,
          {error: '保存キャラの一覧を取得できません'});
      }
    }
    if (req.method === 'GET' && path.startsWith('/api/appearance/image/')) {
      const id = path.slice('/api/appearance/image/'.length);
      if (!isValidAppearanceId(id)) return json(res, 404, {error:'イラストが見つかりません'});
      try {
        const {mime, bytes} = await appearanceImage(id);
        if (!['image/png','image/jpeg','image/webp'].includes(mime) ||
            !Buffer.isBuffer(bytes) || bytes.length > 1048576) {
          return json(res, 415, {error:'イラストの形式が不正です'});
        }
        res.writeHead(200, {'Content-Type':mime, 'Content-Length':bytes.length,
          'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'none'; sandbox",
          'X-Frame-Options':'DENY'});
        return res.end(bytes);
      } catch (error) {
        return json(res, error?.status === 404 ? 404 : error?.status === 415 ? 415 : 503,
          {error: 'イラストを読み込めません'});
      }
    }
    if (req.method === 'GET' && (path === '/game' || path === '/' || path === '/demo.mjs')) {
      const script = path === '/demo.mjs';
      const body = await readFile(script ? DEMO_JS : DEMO);
      res.writeHead(200, {'Content-Type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Length': body.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});
      return res.end(body);
    }
    if (req.method !== 'POST' ||
        !['/api/practice','/api/training/complete','/api/growth/equip','/api/companion'].includes(path)) {
      return json(res, 404, {error: '見つかりません'});
    }
    if (inFlight >= 2) return json(res, 429, {error: '処理が混雑しています'});
    inFlight++;
    try {
      const payload = await getBody(req);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw failure('JSONオブジェクトを指定してください', 400);
      }
      if (path === '/api/companion') return json(res, 200, await companionStore.save(payload));
      const names = Object.keys(payload).sort().join('|');
      if (path === '/api/training/complete') {
        if (names !== 'expected_growth_revision|ticket' ||
            typeof payload.ticket !== 'string' ||
            !/^[a-f0-9]{48}$/.test(payload.ticket)) {
          throw failure('練習終了時の受取券と育成revisionが必要です', 400);
        }
        const item = tickets.get(payload.ticket);
        if (!item || item.used || item.busy || item.expires < Date.now()) {
          throw failure('受取券が無効です。もう一度練習してください', 409);
        }
        item.busy = true;
        try {
          const earned = await store.complete(item.allocations, payload.expected_growth_revision);
          item.used = true; // successful claim: no repeat, even if earned XP was zero
          return json(res, 200, earned);
        } finally {item.busy = false;}
      }
      if (path === '/api/growth/equip') {
        if (names !== 'expected_growth_revision|gear_id|slot') {
          throw failure('装備・キャラ枠・育成revisionが必要です', 400);
        }
        return json(res, 200, await store.equip(
          payload.slot, payload.gear_id, payload.expected_growth_revision
        ));
      }
      if (names !== 'allocations' && names !== 'allocations|trained_version_id') {
        throw failure('allocationsと保存済み練習版IDだけ指定できます', 400);
      }
      const allocations = validateAllocations(payload.allocations);
      const selectedId = Object.hasOwn(payload, 'trained_version_id') ? payload.trained_version_id : null;
      if (names === 'allocations|trained_version_id' &&
          (typeof selectedId !== 'string' || !TRAINED_ID.test(selectedId))) {
        throw failure('保存済み練習版IDが不正です', 400);
      }
      // Saved training versions override the authored companion rules for this run.
      // Otherwise retain the authored companion as the active model.
      const brain = selectedId === null ? null : await trainedVersion(selectedId);
      if (selectedId !== null &&
          (brain?.version_id !== selectedId || brain?.kind !== 'trained_practice_only' ||
           !/^bp_[0-9a-f]{32}$/.test(brain.source_draft_id) ||
           !/^[0-9a-f]{64}$/.test(brain.parameters_sha256) || !brain.model)) {
        throw failure('練習版モデルを確認できません');
      }
      const companion = await companionStore.read();
      const snapshot = await loadSnapshot();
      const modelPlan = withGear(snapshot, brain?.model || null);
      const plan = await predict(selectedId === null ?
        applyCompanion(modelPlan, companion) : modelPlan);
      // Re-read current model and equipment so a concurrent edit never produces
      // a result incorrectly labelled with the latest model revision.
      const after = await loadSnapshot();
      for (const key of REVISIONS) {
        if (snapshot[key] !== after[key]) throw failure('モデル変更と重なりました。再実行してください', 409);
      }
      if (selectedId !== null) {
        const latest = await trainedVersion(selectedId);
        if (latest?.parameters_sha256 !== brain.parameters_sha256 ||
            latest?.source_draft_id !== brain.source_draft_id ||
            latest?.version_id !== selectedId) {
          throw failure('練習版が途中で変わりました。再実行してください',409);
        }
      }
      const result = runSyntheticGame({...plan, allocations});
      if (companion.revision !== (await companionStore.read()).revision) {
        throw failure('相棒変更と重なりました。再実行してください', 409);
      }
      return json(res, 200, {...result,
        // Companion metadata is retained, but never claims its rules were used when a
        // saved training version overrides it.  The brain field is authoritative.
        companion_name: selectedId === null ? companion.companion.name : null,
        companion_revision: companion.revision,
        companion_created: selectedId === null && companion.created,
        companion_applied: selectedId === null && companion.created,
        approach: selectedId === null && companion.created ? companion.companion.approach : null,
        risk_percent: selectedId === null && companion.created ?
          companion.companion.risk_percent : plan.models.mine.risk_fraction * 100,
        brain: selectedId !== null ? {
          kind:'trained_practice_only', version_id:selectedId,
          source_draft_id:brain.source_draft_id,
          parameters_sha256:brain.parameters_sha256,
          effective_sha256:result.characters.mine.effective_sha256,
        } : {kind:companion.created ? 'authored_companion' : 'standard_mine'},
        source_revision: snapshot.source_revision,
        lineup_revision: snapshot.lineup_revision,
        growth_revision: snapshot.growth_revision,
        training_ticket: Object.values(allocations).some(x => x > 0) ? createTicket(allocations) : null,
      });
    } catch (error) {
      const status = error?.status || (/不正|配分|100%|整数/.test(error?.message) ? 400 : 503);
      return json(res, status, {error: status >= 500 ? 'ゲームサーバーの準備ができていません' : error.message});
    } finally {
      inFlight--;
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createGameServer();
  server.listen(8890, '127.0.0.1', () =>
    process.stdout.write('Creature Lab JS game preview: http://127.0.0.1:8890/game\n'));
}
