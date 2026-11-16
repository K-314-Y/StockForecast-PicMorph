import {pathToFileURL} from 'node:url';

const HELP = `使い方: node scripts/check-live-game.mjs [--port 8890] [--help]
127.0.0.1 のゲームと合成練習APIを確認します（保存状態の確認は行いません）。`;

export function validatePort(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1024 || Number(value) > 65535) {
    throw new Error('--port は1024〜65535の整数で指定してください');
  }
  return Number(value);
}

export function parseArgs(args) {
  let port = 8890, help = false, seenPort = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') help = true;
    else if (args[i] === '--port' && !seenPort) {
      port = validatePort(args[++i]);
      seenPort = true;
    } else throw new Error('未対応または重複した引数です。--help を参照してください');
  }
  return {port, help};
}

function schemaError(fields) {
  throw new Error(`スキーマ不一致（欠落または不正）: ${fields.join(', ')}。現在のコードで対象ポートのサーバーを手動再起動してください`);
}

export function validateHealth(value) {
  const invalid = [];
  if (value?.mode !== 'PRACTICE_SYNTHETIC_ONLY') invalid.push('mode');
  if (value?.game_runtime !== 'node') invalid.push('game_runtime');
  if (invalid.length) schemaError(invalid);
}

export function validateGame(html) {
  const missing = ['quickReplay', 'quickReflectionForm'].filter(id =>
    !new RegExp(`\\bid\\s*=\\s*(["'])${id}\\1`).test(html));
  if (missing.length) schemaError(missing);
}

export function validateQuickHome(source, contentType) {
  if (!/^(text|application)\/javascript\b/i.test(contentType ?? '') ||
      typeof source !== 'string' || !source.includes("element('quickReplay')") ||
      /^\s*</.test(source)) schemaError(['quick-home.mjs']);
}

export function validatePractice(value) {
  const invalid = [];
  const expect = (field, valid) => { if (!valid) invalid.push(field); };
  for (const [field, expected] of Object.entries({
    mode: 'SIMPLE_SYNTHETIC_PRACTICE_ONLY', real_market: false,
    persisted: false, order_placed: false, xp_awarded: false,
    invested_coins: 1000, leverage: 25, initial_balance: 10000,
  })) expect(field, value?.[field] === expected);
  const array = (field, length, predicate) => expect(field,
    Array.isArray(value?.[field]) && value[field].length === length &&
    Array.from(value[field]).every(predicate));
  array('daily_ai_signals', 12, signal => signal === 'LONG' || signal === 'CASH');
  array('daily_synthetic_prices', 13, price => Number.isFinite(price) && price > 0);
  array('daily_balances', 13, balance => Number.isFinite(balance) && balance >= 0);
  expect('daily_balances[0]', value?.daily_balances?.[0] === 10000);
  expect('final_balance', Number.isFinite(value?.final_balance) && value.final_balance >= 0 &&
    Math.abs(value.final_balance - value?.daily_balances?.[12]) <= 0.01);
  expect('liquidated_at_step', value?.liquidated_at_step === null ||
    (Number.isInteger(value?.liquidated_at_step) && value.liquidated_at_step >= 1 &&
      value.liquidated_at_step <= 12));
  if (invalid.length) schemaError(invalid);
}

export async function checkLiveGame({port = 8890, fetch: fetchImpl = globalThis.fetch} = {}) {
  const base = `http://127.0.0.1:${validatePort(port)}`;
  async function request(path, options, format) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new Error(`${path}: 接続失敗またはタイムアウト`);
    }
    if (!response.ok) throw new Error(`${path}: HTTPエラー`);
    try {
      return {body: await response[format](), contentType: response.headers.get('content-type')};
    } catch {
      throw new Error(`${path}: レスポンスを読み取れません`);
    }
  }
  validateHealth((await request('/health', {method: 'GET'}, 'json')).body);
  validateGame((await request('/game', {method: 'GET'}, 'text')).body);
  const script = await request('/quick-home.mjs', {method: 'GET'}, 'text');
  validateQuickHome(script.body, script.contentType);
  validatePractice((await request('/api/quick-practice', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model_id: 'self', amount: 1000, leverage: 25}),
  }, 'json')).body);
  return {port: validatePort(port)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {port, help} = parseArgs(process.argv.slice(2));
    if (help) console.log(HELP);
    else {
      await checkLiveGame({port});
      console.log(`成功: ポート${port}のゲーム・合成練習APIを確認しました（保存状態は未確認）`);
    }
  } catch (error) {
    console.error(`確認失敗: ${error.message}`);
    process.exitCode = 1;
  }
}
