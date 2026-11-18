/**
 * Node game API: authoritative JS accounting plus separate Node-owned tutorial
 * XP persistence. Python is a read-only model forecaster only.
 * No broker calls, V6 writes, public binding or client-supplied predictions.
 */
import {createServer} from 'node:http';
import {createChatGPTPlanDialogue, validateDialogueInput, validateDialogueResult} from './chatgpt-dialogue.mjs';
import {randomBytes} from 'node:crypto';
import {createCompanionStore, applyCompanion, validateCompanion} from './companion.mjs';
import {createLookStore} from './looks.mjs';
import {createArtworkStore,ARTWORK_SLOTS} from './artwork.mjs';
import {createArtworkExpressionStore,EXPRESSION_MOODS,MAX_EXPRESSION_REQUEST} from './artwork-expressions.mjs';
import {createGrowthStore} from './growth.mjs';
import {createModelShopStore} from './model-shop.mjs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {runSyntheticGame, validateAllocations} from './practice.mjs';
import {settleLeveragedPractice} from './leverage-practice.mjs';
import {makeFairComparison, validateContenders} from './arena.mjs';
import {validateLabModel, validateLabRevisions, labRevisions, sameLabRevisions, compareLabPlan} from './model-lab.mjs';
import {compareHistoricalMarket} from './historical-market.mjs';
import {readAppearanceCatalog, readAppearanceImage, isValidAppearanceId} from './appearance.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BRIDGE = fileURLToPath(new URL('./predict_bridge.py', import.meta.url));
const TRAINED_BRIDGE = fileURLToPath(new URL('./trained_bridge.py', import.meta.url));
const MARKET_BRIDGE = fileURLToPath(new URL('./market_bridge.py', import.meta.url));
const DEMO = new URL('./demo.html', import.meta.url);
const DEMO_JS = new URL('./demo.mjs', import.meta.url);
const ARENA_JS = new URL('./arena-ui.mjs', import.meta.url);
const MODEL_LAB_JS = new URL('./model-lab-ui.mjs', import.meta.url);
const MODEL_SHOP_JS = new URL('./model-shop-ui.mjs', import.meta.url);
const QUICK_HOME_JS = new URL('./quick-home.mjs', import.meta.url);
const CROP_JS = new URL('./crop-editor.mjs', import.meta.url);
// Fixed read-only assets only: never resolve a request path on the filesystem.
const ARTWORK_LAB = new Map([
  ['/artwork-lab/preview_extract.html', new URL('../experiments/image_parts/preview_extract.html', import.meta.url)],
  ['/artwork-lab/preview_extract.js', new URL('../experiments/image_parts/preview_extract.js', import.meta.url)],
  ['/artwork-lab/refine_prediction.html', new URL('../experiments/image_parts/refine_prediction.html', import.meta.url)],
  ['/artwork-lab/refine_prediction.js', new URL('../experiments/image_parts/refine_prediction.js', import.meta.url)],
  ['/artwork-lab/choose_seeds.html', new URL('../experiments/image_parts/choose_seeds.html', import.meta.url)],
  ['/artwork-lab/choose_seeds.js', new URL('../experiments/image_parts/choose_seeds.js', import.meta.url)],
  ['/artwork-lab/annotate.html', new URL('../experiments/image_parts/annotate.html', import.meta.url)],
  ['/artwork-lab/annotate.js', new URL('../experiments/image_parts/annotate.js', import.meta.url)],
]);
// Original meta policies remain intact and also apply (including blob-only images).
const ARTWORK_LAB_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const UPSTREAM = 'http://127.0.0.1:8765';
const MAX_REQUEST = 2048;
const MAX_ARTWORK_REQUEST = 750 * 1024;
const EXPRESSIONS_API = '/api/artwork-expressions';
const REVISIONS = ['source_revision', 'lineup_revision', 'growth_revision'];
const MARKET_ID = /^mkt_[a-f0-9]{24}$/;
const TRAINED_ID = /^tv_[0-9a-f]{32}$/;
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

function modelPlanFromSnapshot(source, trainedModel = null) {
  const lineup = new Map(source.lineup.slots.map(x => [x.slot, x.model]));
  if (lineup.size !== 2 || !lineup.has('owl') || !lineup.has('turtle')) {
    throw failure('編成が不正です');
  }
  const models = {};
  for (const slot of SLOTS) {
    const original = slot === 'mine' ? (trainedModel || source.state.model) : lineup.get(slot);
    if (!original || typeof original !== 'object' || !original.plugin_strengths) {
      throw failure('キャラモデルが不足しています');
    }
    const strengths = {...original.plugin_strengths};
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

export async function pythonHistoricalPredict(input) {
  const {spawn}=await import('node:child_process');
  return new Promise((resolveResult,rejectResult)=>{
    const child=spawn('python3',['-B',MARKET_BRIDGE],
      {cwd:ROOT,stdio:['pipe','pipe','pipe']});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
    let output='',failed=false,settled=false;
    const finish=(err,result)=>{
      if(settled)return;
      settled=true;clearTimeout(timeout);
      if(err)rejectResult(err);else resolveResult(result);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',part=>{
      output+=part;
      if(output.length>65536){failed=true;child.kill('SIGKILL');}
    });
    child.stderr.resume();
    child.on('error',()=>finish(failure('過去株価の予測処理を開始できません')));
    child.on('close',code=>{
      if(failed||code!==0)return finish(failure('過去株価データを読み込めません。取得元・APIキー・レート制限を確認してください'));
      try{finish(null,JSON.parse(output));}
      catch{finish(failure('過去株価の予測結果が不正です'));}
    });
    child.stdin.end(JSON.stringify(input));
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

function artworkImage(res, {mime,bytes}) {
  res.writeHead(200,{'Content-Type':mime,'Content-Length':bytes.length,
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; sandbox",
    'X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});
  return res.end(bytes);
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

async function getBody(req, limit = MAX_REQUEST) {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw failure('JSON形式のみ対応します', 415);
  }
  if (req.headers['transfer-encoding'] ||
      !/^\d+$/.test(req.headers['content-length'] ?? '') ||
      Number(req.headers['content-length']) <= 0) {
    throw failure('入力サイズが不正です', 400);
  }
  if (Number(req.headers['content-length']) > limit) throw failure('入力が大きすぎます', 413);
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw failure('入力が大きすぎます', 413);
    chunks.push(part);
  }
  if (size !== Number(req.headers['content-length'])) {
    throw failure('入力が途中で切れています', 400);
  }
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}
  catch {throw failure('JSONが不正です', 400);}
}

export function createGameServer({store = createGrowthStore(), loadSnapshot,
                                  predict = pythonPredict, historicalPredict = pythonHistoricalPredict,
                                  companionStore = createCompanionStore(),
                                  modelShopStore = createModelShopStore(),
                                  lookStore = createLookStore(),
                                  artworkStore = createArtworkStore(),
                                  artworkExpressionStore = createArtworkExpressionStore(),
                                  appearanceCatalog = readAppearanceCatalog,
                                  appearanceImage = readAppearanceImage,
                                  trainedVersions = readTrainingVersions,
                                  trainedVersion = resolveTrainedVersion,
                                  chatgptDialogue = null, chatgptClient = null} = {}) {
  if (chatgptClient !== null) {
    if (chatgptDialogue !== null) throw Error('Use only one ChatGPT injection');
    chatgptDialogue = createChatGPTPlanDialogue({client:chatgptClient});
  }
  if (chatgptDialogue !== null && typeof chatgptDialogue !== 'function') throw Error('Invalid chatgptDialogue injection');
  let dialogueBusy = false;
  let dialogueAttempts = [];
  let sessionBusy = false;
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
    let path;
    try {
      // Accept origin-form targets only; WHATWG URL otherwise accepts authorities.
      if (typeof req.url !== 'string' || !/^\/(?![\/\\])/.test(req.url) ||
          /[\x00-\x20\x7f#\\]/.test(req.url) || /%(?![0-9a-f]{2})/i.test(req.url)) {
        throw new Error('Invalid request target');
      }
      path = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return json(res, 400, {error: 'リクエストURLが不正です'});
    }
    const rawPath = req.url.split('?')[0];
    if ([rawPath,path].some(target=>target===EXPRESSIONS_API || target.startsWith(EXPRESSIONS_API+'/'))) {
      if (rawPath===EXPRESSIONS_API && req.method==='GET') {
        try {return json(res,200,await artworkExpressionStore.read());}
        catch {return json(res,503,{error:'表情イラストの保存情報を読み込めません。保存ファイルを確認してください'});}
      }
      const imagePath=EXPRESSIONS_API+'/image/';
      if (req.method==='GET' && rawPath.startsWith(imagePath)) {
        const mood=rawPath.slice(imagePath.length);
        if (!EXPRESSION_MOODS.includes(mood)) return json(res,404,{error:'画像が見つかりません'});
        try {return artworkImage(res,await artworkExpressionStore.image(mood));}
        catch (error) {
          return json(res,error?.status===404?404:503,{error:'表情イラストを読み込めません'});
        }
      }
      if (rawPath!==EXPRESSIONS_API || req.method!=='POST') return json(res,404,{error:'見つかりません'});
      if (inFlight>=2) return json(res,429,{error:'処理が混雑しています'});
      inFlight++;
      try {
        const payload=await getBody(req,MAX_EXPRESSION_REQUEST);
        return json(res,200,await artworkExpressionStore.save(payload));
      } catch (error) {
        const status=error?.status ?? 503;
        return json(res,status,{error:status>=500?'表情イラストの保存情報を更新できません。保存ファイルを確認してください':error.message});
      } finally {
        inFlight--;
      }
    }
    if (rawPath.startsWith('/artwork-lab/') || path.startsWith('/artwork-lab/')) {
      const asset = ARTWORK_LAB.get(rawPath);
      if (req.method !== 'GET' || !asset) return json(res, 404, {error: '見つかりません'});
      try {
        const body = await readFile(asset);
        res.writeHead(200, {
          'Content-Type': rawPath.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
          'Content-Length': body.length, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': ARTWORK_LAB_CSP,
        });
        return res.end(body);
      } catch {
        return json(res, 404, {error: '見つかりません'});
      }
    }
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
    if (req.method === 'GET' && path === '/api/model-shop') {
      try{return json(res,200,await modelShopStore.public());}
      catch{return json(res,503,{error:'ショップ情報を読み込めません'});}
    }
    if (req.method === 'GET' && path === '/api/model-lab/baseline') {
      try {
        const snapshot=await loadSnapshot();
        const companion=await companionStore.read();
        const base=applyCompanion(modelPlanFromSnapshot(snapshot,null),companion).models.mine;
        return json(res,200,{
          model:validateLabModel(base),revisions:labRevisions(snapshot,companion),
          source:companion.created?'authored_companion':'standard_mine',
          notice:'自分の標準・保存相棒モデルを読み取りました。実験は保存されません。',
        });
      }catch(error){
        return json(res,error?.status||503,{error:'基準モデルを読み込めません'});
      }
    }
    if (req.method === 'GET' && path === '/api/companion') {
      try {return json(res, 200, await companionStore.read());}
      catch {return json(res, 503, {error:'相棒の保存情報を読み取れません'});}
    }
    if (req.method === 'GET' && path === '/api/looks') {
      try {return json(res,200,await lookStore.read());}
      catch {return json(res,503,{error:'外見の保存情報を読み取れません'});}
    }
    if (req.method === 'GET' && path === '/api/artwork') {
      try {return json(res,200,await artworkStore.read());}
      catch {return json(res,503,{error:'イラストの保存情報を読み取れません。保存ファイルを確認してください'});}
    }
    if (req.method === 'GET' && path.startsWith('/api/artwork/image/')) {
      const slot=path.slice('/api/artwork/image/'.length);
      if (!ARTWORK_SLOTS.includes(slot)) return json(res,404,{error:'画像が見つかりません'});
      try {
        return artworkImage(res,await artworkStore.image(slot));
      } catch(error) {
        return json(res,error?.status===404?404:503,{error:'イラストを読み込めません'});
      }
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
    if (path === '/api/chatgpt-session' || path === '/api/chatgpt-dialogue') {
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)
        return json(res,403,{status:'unavailable'});
    }
    if (chatgptClient !== null && path === '/api/chatgpt-session' && req.method === 'GET') {
      if (sessionBusy) return json(res,429,{status:'unavailable'});
      sessionBusy = true;
      let timer;
      const work = Promise.resolve().then(()=>chatgptClient.getSession()).finally(()=>{sessionBusy=false;});
      try {
        const session = await Promise.race([work,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(Error('timeout')),3000);
        })]);
        const connected = session?.status === 'connected';
        return json(res,200,{connected,sharing:connected && session.sharing === true});
      } catch {return json(res,503,{status:'unavailable'});}
      finally {clearTimeout(timer);}
    }
    // Stateless dialogue: never enters snapshot, prediction, XP or save paths.
    if (chatgptDialogue !== null && path === '/api/chatgpt-dialogue' && req.method === 'POST') {
      if (dialogueBusy) return json(res,429,{status:'unavailable'});
      dialogueBusy = true;
      let timer, work;
      const controller = new AbortController();
      const cancel = ()=>controller.abort();
      res.on?.('close',cancel);
      req.on('aborted',cancel);
      try {
        const input = validateDialogueInput(await getBody(req,1024));
        dialogueAttempts = dialogueAttempts.filter(time=>Date.now()-time<60000);
        if (dialogueAttempts.length>=6) return json(res,429,{status:'unavailable'});
        dialogueAttempts.push(Date.now());
        work = Promise.resolve().then(()=>{
          controller.signal.throwIfAborted();
          return chatgptDialogue(input,{signal:controller.signal});
        }).finally(()=>{dialogueBusy=false;});
        const result = validateDialogueResult(await Promise.race([
          work,
          new Promise(resolve=>{timer=setTimeout(()=>{
            controller.abort();resolve({status:'unavailable'});
          },50000);}),
        ]));
        if (controller.signal.aborted) return json(res,503,{status:'unavailable'});
        return json(res,result.status === 'ok' ? 200 : 503,result);
      } catch (error) {
        return json(res,[400,413,415].includes(error?.status) ? error.status : 503,
          {status:'unavailable'});
      } finally {
        clearTimeout(timer);controller.abort();
        res.off?.('close',cancel);req.off('aborted',cancel);
        // A non-cooperative provider keeps the guard until it actually settles.
        if (!work) dialogueBusy = false;
      }
    }

    if (req.method === 'GET' && (path === '/game' || path === '/' || path === '/demo.mjs' || path === '/arena-ui.mjs' || path === '/crop-editor.mjs' || path === '/model-lab-ui.mjs' || path === '/model-shop-ui.mjs' || path === '/quick-home.mjs')) {
      const script = path === '/demo.mjs' || path === '/arena-ui.mjs' || path === '/crop-editor.mjs' || path === '/model-lab-ui.mjs' || path === '/model-shop-ui.mjs' || path === '/quick-home.mjs';
      let body;
      try {
        body = await readFile(path === '/quick-home.mjs' ? QUICK_HOME_JS : path === '/model-shop-ui.mjs' ? MODEL_SHOP_JS : path === '/model-lab-ui.mjs' ? MODEL_LAB_JS : path === '/crop-editor.mjs' ? CROP_JS :
        path === '/arena-ui.mjs' ? ARENA_JS : script ? DEMO_JS : DEMO);
      } catch (error) {
        console.error('Creature Lab static asset read failed', error);
        return json(res, 503, {error: 'ゲーム画面を読み込めません'});
      }
      if (!script && chatgptDialogue !== null) {
        body = Buffer.from(body.toString('utf8').replace('data-chatgpt-dialogue="disabled"', 'data-chatgpt-dialogue="enabled"'));
      }
      if (!script && chatgptClient !== null) {
        body = Buffer.from(body.toString('utf8').replace('data-chatgpt-session="disabled"', 'data-chatgpt-session="enabled"'));
      }
      res.writeHead(200, {'Content-Type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Length': body.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});
      return res.end(body);
    }
    if (req.method !== 'POST' ||
        !['/api/practice','/api/practice/preview','/api/compare','/api/model-lab/compare','/api/model-lab/historical','/api/model-shop/buy','/api/model-shop/practice','/api/quick-practice','/api/training/complete','/api/companion','/api/looks','/api/artwork'].includes(path)) {
      return json(res, 404, {error: '見つかりません'});
    }
    if (inFlight >= 2) return json(res, 429, {error: '処理が混雑しています'});
    inFlight++;
    try {
      const payload = await getBody(req, path === '/api/artwork' ? MAX_ARTWORK_REQUEST : MAX_REQUEST);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw failure('JSONオブジェクトを指定してください', 400);
      }
      if (path === '/api/companion') return json(res, 200, await companionStore.save(payload));
      if (path === '/api/looks') return json(res, 200, await lookStore.save(payload));
      if (path === '/api/artwork') return json(res, 200, await artworkStore.save(payload));
      const names = Object.keys(payload).sort().join('|');
      if (path === '/api/quick-practice') {
        if (!['amount|leverage|model_id','amount|model_id',
              'amount|leverage|model_id|scenario_token','amount|model_id|scenario_token'].includes(names) ||
            (Object.hasOwn(payload,'scenario_token') &&
              (typeof payload.scenario_token !== 'string' || payload.scenario_token.length !== 19 ||
               !/^v1_[0-9a-f]{16}$/.test(payload.scenario_token))) ||
            !Number.isSafeInteger(payload.amount) || payload.amount < 1 ||
            payload.amount > 10000 ||
            (payload.leverage !== undefined && (
              !Number.isSafeInteger(payload.leverage) || payload.leverage < 1 ||
              payload.leverage > 25
            )) ||
            typeof payload.model_id !== 'string' ||
            !/^(self|demo_[a-z_]{1,40})$/.test(payload.model_id)) {
          throw failure('AI、1〜10,000の整数コイン額、1〜25の整数倍率を指定してください',400);
        }
        const leverage = payload.leverage ?? 1;
        const snapshot = await loadSnapshot();
        const companion = await companionStore.read();
        const originals = modelPlanFromSnapshot(snapshot,null);
        const mine = payload.model_id === 'self' ?
          applyCompanion(originals,companion).models.mine :
          await modelShopStore.licensedModel(payload.model_id);
        const scenarioKind = Object.hasOwn(payload,'scenario_token') ? 'replay' : 'new';
        const scenarioToken = payload.scenario_token ?? 'v1_'+randomBytes(8).toString('hex');
        const plan = await predict({...originals,models:{...originals.models,mine},
          scenario_token:scenarioToken});
        const after = await loadSnapshot();
        const currentCompanion = await companionStore.read();
        if(REVISIONS.some(key=>snapshot[key]!==after[key]) ||
           companion.revision !== currentCompanion.revision) {
          throw failure('練習中にモデルが変更されました。再度お試しください',409);
        }
        // Unallocated coins remain in cash; only the entered amount is simulated.
        // This practice does not mutate either shop currency or XP.
        const result = runSyntheticGame({...plan,initial_coins:payload.amount,
          allocations:{mine:100,owl:0,turtle:0}});
        const settled = settleLeveragedPractice({
          equityPath:result.raw_equity_path,amount:payload.amount,leverage,
        });
        // Compare the same capital and already simulated trades; never predict again.
        const normal = settleLeveragedPractice({
          equityPath:result.raw_equity_path,amount:payload.amount,leverage:1,
        });
        return json(res,200,{
          mode:'SIMPLE_SYNTHETIC_PRACTICE_ONLY',
          scenario_token:scenarioToken, scenario_kind:scenarioKind,
          scenario_notice:scenarioKind==='replay' ?
            '同じ架空相場での再挑戦です。既に値動きを知っている場合、初見の予想とは比較できません。' :
            '今回は新しい架空相場です',
          companion_name:payload.model_id==='self' && companion.created ? companion.companion.name : null,
          companion_strategy:payload.model_id==='self' && companion.created ? {
            source:'saved_companion',approach:companion.companion.approach,
            risk_percent:companion.companion.risk_percent,
          } : null,
          model_id:payload.model_id, initial_balance:10000,
          invested_coins:settled.invested_coins, cash_held:settled.cash_held,
          leverage:settled.leverage,
          profit_coins:settled.profit_coins,
          final_balance:settled.final_balance,
          daily_balances:settled.allocated_equity_path.map((capital,day,path)=>
            day===0 ? 10000 : day===path.length-1 ? settled.final_balance :
              Math.round((settled.cash_held+capital+Number.EPSILON)*100)/100),
          daily_ai_signals:result.decisions.map(decision=>decision.signals.mine),
          daily_synthetic_prices:[plan.initial_price,...result.decisions.map(decision=>decision.price)],
          max_drawdown_pct:settled.max_drawdown_pct,
          normal_profit_coins:normal.profit_coins,
          normal_final_balance:normal.final_balance,
          normal_max_drawdown_pct:normal.max_drawdown_pct,
          liquidated_at_step:settled.liquidated_at_step,
          steps:result.decisions.length,
          real_market:false, persisted:false, order_placed:false,
          xp_awarded:false,
          notice:'統計的に架空の価格です。現実的な市場再現やバックテストではありません。架空相場の終値ベースで損益倍率を試算しています。資金が0になれば途中終了し復活しません。実際の強制決済とは異なり、所持コインも注文も変更しません。',
        });
      }
      if (path === '/api/model-shop/buy') {
        return json(res,200,await modelShopStore.purchase(payload));
      }
      if (path === '/api/model-shop/practice') {
        if (names !== 'id' || typeof payload.id!=='string')
          throw failure('練習には解放したモデルのIDが必要です',400);
        // The server resolves the current published model once per practice.
        // A mid-session update does not change already generated decisions.
        const licensed=await modelShopStore.licensedModel(payload.id);
        const snapshot=await loadSnapshot();
        const originals=modelPlanFromSnapshot(snapshot,null);
        const plan=await predict({...originals,models:{...originals.models,mine:licensed}});
        const after=await loadSnapshot();
        if(REVISIONS.some(key=>snapshot[key]!==after[key]))
          throw failure('モデルの変更と重なりました。再実行してください',409);
        const result=runSyntheticGame({...plan,allocations:{mine:100,owl:0,turtle:0}});
        return json(res,200,{
          mode:'LOCAL_SHOP_LICENSED_PRACTICE',model_id:payload.id,
          initial_coins:result.initial_coins,
          final_coins:result.final_coins,profit_coins:result.profit_coins,
          return_pct:result.return_pct,max_drawdown_pct:result.max_drawdown_pct,
          decisions:result.decisions.length,charged_for_practice:false,
          investment_balance_changed:false,real_market:false,
          notice:'解放したモデルを架空の12日間で試しました。作者の公開更新は次の練習から反映します。予測精度・実株価での成績を示すものではありません。',
        });
      }
      if (path === '/api/model-lab/historical') {
        if(!['candidate|revisions','candidate|exclude_id|revisions',
             'candidate|replay_id|revisions'].includes(names)) {
          throw failure('変数・版数と再現用の期間IDだけ指定してください',400);
        }
        const candidate=validateLabModel(payload.candidate);
        const expected=validateLabRevisions(payload.revisions);
        for(const field of ['replay_id','exclude_id']) {
          if(Object.hasOwn(payload,field) &&
             (typeof payload[field]!=='string'||!MARKET_ID.test(payload[field])))
            throw failure('相場期間IDが不正です',400);
        }
        const snapshot=await loadSnapshot();
        const companion=await companionStore.read();
        if(!sameLabRevisions(expected,labRevisions(snapshot,companion)))
          throw failure('実験中に基準モデルが変更されました。再読込してください',409);
        const baseline=validateLabModel(
          applyCompanion(modelPlanFromSnapshot(snapshot,null),companion).models.mine);
        const raw=await historicalPredict({
          base_model:validateLabModel(snapshot.state.model),
          models:{mine:candidate,owl:baseline,turtle:baseline},
          selection:{...(payload.replay_id?{replay_id:payload.replay_id}:{}),
                     ...(payload.exclude_id?{exclude_id:payload.exclude_id}:{})},
        });
        const after=await loadSnapshot();
        const current=await companionStore.read();
        if(!sameLabRevisions(expected,labRevisions(after,current)))
          throw failure('予測中に元モデルの版数が変わりました。再読込してください',409);
        return json(res,200,compareHistoricalMarket(raw,baseline,candidate));
      }
      if (path === '/api/model-lab/compare') {
        if(names!=='candidate|revisions')throw failure('試す変数と読込時の版数だけ指定してください',400);
        // Reject malformed changes before calling an external predictor.
        const candidate=validateLabModel(payload.candidate);
        const expected=validateLabRevisions(payload.revisions);
        const snapshot=await loadSnapshot();
        const companion=await companionStore.read();
        if(!sameLabRevisions(expected,labRevisions(snapshot,companion)))
          throw failure('実験中に基準モデルが変更されました。再読込してください',409);
        const baseline=validateLabModel(
          applyCompanion(modelPlanFromSnapshot(snapshot,null),companion).models.mine);
        // The third slot is an unused protocol placeholder, not a third result.
        const plan=await predict({base_model:snapshot.state.model,
          models:{mine:candidate,owl:baseline,turtle:baseline}});
        const after=await loadSnapshot();
        const currentCompanion=await companionStore.read();
        if(!sameLabRevisions(expected,labRevisions(after,currentCompanion)))
          throw failure('実験中にモデルの版数が変更されました。再読込してください',409);
        return json(res,200,compareLabPlan(plan,baseline,candidate));
      }
      if (path === '/api/compare') {
        if (names !== 'contenders') throw failure('比較する3モデルだけ指定してください',400);
        const choices = validateContenders(payload.contenders);
        const selected = [...new Set(Object.values(choices).filter(x => TRAINED_ID.test(x)))];
        const versions = new Map();
        for (const id of selected) {
          const found = await trainedVersion(id);
          if (found?.version_id !== id || found?.kind !== 'trained_practice_only' ||
              !/^bp_[0-9a-f]{32}$/.test(found?.source_draft_id) ||
              !/^[a-f0-9]{64}$/.test(found?.parameters_sha256) ||
              !found?.model) {
            throw failure('比較用の学習版を検証できません',409);
          }
          versions.set(id, found);
        }
        const companion = await companionStore.read();
        const ownLook = choices.mine === 'self' ? await lookStore.read() : null;
        const snapshot = await loadSnapshot();
        let models = modelPlanFromSnapshot(snapshot, null);
        if (choices.mine === 'self') models = applyCompanion(models, companion);
        const metadata = {};
        for (const slot of SLOTS) {
          const choice = choices[slot];
          const trained = versions.get(choice);
          if (trained) {
            models.models[slot] = trained.model;
            metadata[slot] = {
              kind:'trained_practice_only', name:'学習版 ' + choice.slice(0,11),
              version_id:choice, source_draft_id:trained.source_draft_id,
              parameters_sha256:trained.parameters_sha256,
            };
          } else if (slot === 'mine') {
            metadata[slot] = companion.created ?
              {kind:'authored_companion',name:companion.companion.name,
                appearance:{look:ownLook?.created ? ownLook.look : null,
                  companion:companion.created ? companion.companion : null}} :
              {kind:'standard_mine',name:'標準モデル',
                appearance:{look:ownLook?.created ? ownLook.look : null,
                  companion:companion.created ? companion.companion : null}};
          } else {
            metadata[slot] = {kind:'preset_rival',
              name:slot === 'owl' ? 'フクロウ（既存）' : 'カメ（既存）'};
          }
        }
        const plan = await predict(models);
        const after = await loadSnapshot();
        for (const key of REVISIONS) {
          if (snapshot[key] !== after[key]) {
            throw failure('比較中に既存モデルが変更されました。再実行してください',409);
          }
        }
        if (companion.revision !== (await companionStore.read()).revision ||
            (ownLook && ownLook.revision !== (await lookStore.read()).revision)) {
          throw failure('比較中に相棒の設定が変更されました。再実行してください',409);
        }
        for (const id of selected) {
          const latest = await trainedVersion(id);
          const previous = versions.get(id);
          if (latest?.version_id !== id ||
              latest?.parameters_sha256 !== previous.parameters_sha256 ||
              latest?.source_draft_id !== previous.source_draft_id) {
            throw failure('比較中に学習版が変更されました。再実行してください',409);
          }
        }
        return json(res,200,makeFairComparison(plan,choices,metadata));
      }
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
      const preview = path === '/api/practice/preview';
      if (!preview && names !== 'allocations' && names !== 'allocations|trained_version_id') {
        throw failure('allocationsと保存済み練習版IDだけ指定できます', 400);
      }
      if (preview && ![
        'allocations', 'allocations|candidate', 'allocations|trained_version_id'
      ].includes(names)) {
        throw failure('試遊には配分と候補設定または練習版IDだけ指定できます', 400);
      }
      const allocations = validateAllocations(payload.allocations);
      const selectedId = Object.hasOwn(payload, 'trained_version_id') ? payload.trained_version_id : null;
      if (Object.hasOwn(payload, 'trained_version_id') &&
          (typeof selectedId !== 'string' || !TRAINED_ID.test(selectedId))) {
        throw failure('保存済み練習版IDが不正です', 400);
      }
      // Candidate belongs to THIS request only. It cannot be written by preview.
      const candidate = preview && Object.hasOwn(payload, 'candidate') ?
        validateCompanion(payload.candidate) : null;
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
      const modelPlan = modelPlanFromSnapshot(snapshot, brain?.model || null);
      const effectiveCompanion = candidate === null ?
        companion : {revision:companion.revision, created:true, companion:candidate};
      const plan = await predict(selectedId === null ?
        applyCompanion(modelPlan, effectiveCompanion) : modelPlan);
      // Re-read current model and progression so a concurrent edit never produces
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
        preview_only:preview,
        candidate_applied:candidate !== null,
        companion_name: selectedId === null ? effectiveCompanion.companion.name : null,
        companion_revision: companion.revision,
        companion_created: selectedId === null && companion.created,
        companion_applied: selectedId === null && companion.created && candidate === null,
        approach: selectedId === null && effectiveCompanion.created ? effectiveCompanion.companion.approach : null,
        risk_percent: selectedId === null && effectiveCompanion.created ?
          effectiveCompanion.companion.risk_percent : plan.models.mine.risk_fraction * 100,
        brain: selectedId !== null ? {
          kind:'trained_practice_only', version_id:selectedId,
          source_draft_id:brain.source_draft_id,
          parameters_sha256:brain.parameters_sha256,
          effective_sha256:result.characters.mine.effective_sha256,
        } : {kind:candidate !== null ? 'unsaved_candidate_preview' :
          companion.created ? 'authored_companion' : 'standard_mine'},
        source_revision: snapshot.source_revision,
        lineup_revision: snapshot.lineup_revision,
        growth_revision: snapshot.growth_revision,
        training_ticket: !preview && Object.values(allocations).some(x => x > 0) ? createTicket(allocations) : null,
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
