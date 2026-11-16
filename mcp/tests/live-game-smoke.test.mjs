import test from 'node:test';
import assert from 'node:assert/strict';
import {checkLiveGame, parseArgs, validateHealth, validatePractice} from '../../scripts/check-live-game.mjs';

function practice() {
  return {mode: 'SIMPLE_SYNTHETIC_PRACTICE_ONLY', real_market: false,
    persisted: false, order_placed: false, xp_awarded: false,
    invested_coins: 1000, leverage: 25, initial_balance: 10000, final_balance: 10000,
    daily_ai_signals: Array(12).fill('LONG'), daily_synthetic_prices: Array(13).fill(100),
    daily_balances: Array(13).fill(10000), liquidated_at_step: null};
}

function stub(overrides = {}) {
  const calls = [];
  return {calls, fetch: async (url, options) => {
    calls.push({url, options});
    const path = new URL(url).pathname;
    const responses = {
      '/health': [{mode: 'PRACTICE_SYNTHETIC_ONLY', game_runtime: 'node'}, 'application/json'],
      '/game': ['<div id="quickReplay"></div><form id="quickReflectionForm"></form>', 'text/html'],
      '/quick-home.mjs': ["const replay = element('quickReplay');", 'text/javascript; charset=utf-8'],
      '/api/quick-practice': [practice(), 'application/json'],
      ...overrides,
    };
    const [body, type, status = 200] = responses[path];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: {'content-type': type},
    });
  }};
}

test('stub success uses loopback, one exact practice POST, timeouts and no redirects', async () => {
  const fake = stub();
  assert.deepEqual(await checkLiveGame({fetch: fake.fetch}), {port: 8890});
  assert.deepEqual(fake.calls.map(call => call.url), ['/health', '/game', '/quick-home.mjs',
    '/api/quick-practice'].map(path => 'http://127.0.0.1:8890' + path));
  const posts = fake.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(posts[0].options.body), {model_id: 'self', amount: 1000, leverage: 25});
  for (const {options} of fake.calls) {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
  }
});

test('stale API names both missing fields and suggests manual restart', async () => {
  const data = practice();
  delete data.daily_ai_signals;
  delete data.daily_synthetic_prices;
  const fake = stub({'/api/quick-practice': [data, 'application/json']});
  await assert.rejects(checkLiveGame({fetch: fake.fetch}), /daily_ai_signals, daily_synthetic_prices.*手動再起動/);
});

test('stale 12-price responses and true mutation flags name fields without exposing bodies', async () => {
  const cases = [
    ['daily_synthetic_prices', Array(12).fill(100)],
    ...['persisted', 'real_market', 'order_placed', 'xp_awarded'].map(field => [field, true]),
  ];
  for (const [field, value] of cases) {
    const data = {...practice(), [field]: value, secret: 'PRIVATE_RESPONSE_SECRET'};
    const fake = stub({'/api/quick-practice': [data, 'application/json']});
    await assert.rejects(checkLiveGame({fetch: fake.fetch}), error => {
      assert.equal(error.message,
        `スキーマ不一致（欠落または不正）: ${field}。現在のコードで対象ポートのサーバーを手動再起動してください`);
      assert.ok(!String(error).includes('PRIVATE_RESPONSE_SECRET'));
      assert.ok(!String(error).includes(JSON.stringify(data)));
      return true;
    });
    assert.equal(fake.calls.length, 4);
  }
});

test('all mutation and market claims must be explicitly false', () => {
  for (const field of ['real_market', 'persisted', 'order_placed', 'xp_awarded']) {
    for (const value of [true, undefined, 'false']) {
      assert.throws(() => validatePractice({...practice(), [field]: value}), new RegExp(field));
    }
  }
});

test('invalid arrays, balances, parameters and liquidation days are rejected', () => {
  const invalid = {
    daily_ai_signals: [Array(11).fill('LONG'), Array(12).fill('SHORT'), Array(12)],
    daily_synthetic_prices: [Array(12).fill(1), Array(13).fill(0), Array(13).fill(Infinity)],
    daily_balances: [Array(12).fill(10000), Array(13).fill(-1), Array(13).fill(NaN)],
    initial_balance: [9999], final_balance: [10001, Infinity, -1],
    invested_coins: [999], leverage: [1], liquidated_at_step: [undefined, 0, 13, 1.5],
    mode: ['OTHER'],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) assert.throws(() => validatePractice({...practice(), [field]: value}),
      error => error.message.includes(field));
  }
  assert.throws(() => validatePractice({...practice(), daily_balances: [9999, ...Array(12).fill(10000)]}), /daily_balances\[0\]/);
  for (const day of [null, 1, 12]) validatePractice({...practice(), liquidated_at_step: day});
  assert.throws(() => validateHealth({mode: 'OTHER', game_runtime: 'python'}), /mode, game_runtime/);
});

test('missing HTML IDs and invalid or missing JavaScript fail before POST', async () => {
  for (const id of ['quickReplay', 'quickReflectionForm']) {
    const fake = stub({'/game': [`<div id="${id}"></div>`, 'text/html']});
    await assert.rejects(checkLiveGame({fetch: fake.fetch}),
      new RegExp(id === 'quickReplay' ? 'quickReflectionForm' : 'quickReplay'));
    assert.equal(fake.calls.length, 2);
  }
  for (const response of [['not found', 'text/plain', 404], ['<html/>', 'text/html'],
    ['const unrelated = 1;', 'text/javascript']]) {
    const fake = stub({'/quick-home.mjs': response});
    await assert.rejects(checkLiveGame({fetch: fake.fetch}), /quick-home.mjs/);
    assert.equal(fake.calls.length, 3);
  }
});

test('CLI accepts boundary ports/help and rejects malicious arguments before fetch', async () => {
  assert.deepEqual(parseArgs([]), {port: 8890, help: false});
  for (const port of ['1024', '8910', '65535']) {
    const parsed = parseArgs(['--port', port]);
    assert.equal(parsed.port, Number(port));
    const fake = stub();
    assert.deepEqual(await checkLiveGame({...parsed, fetch: fake.fetch}), {port: Number(port)});
    assert.ok(fake.calls.every(call => new URL(call.url).port === port));
  }
  for (const args of [['--port=80'], ['--port=70000'], ['--port=abc'],
    ['--port', '0'], ['--port', '-1'], ['--port', '1024.5'], ['--host', '0.0.0.0'], ['--port'], ['--port', '1023'], ['--port', '65536'],
    ['--port', '1.5'], ['--port', '8890x'], ['--port', 'http://example.com'],
    ['--url', 'http://example.com'], ['--port', '8890', '--port', '8910'], ['--bad', '--help']]) {
    const fake = stub();
    // Follow the CLI's parse-before-check order, with a fetch spy.
    await assert.rejects(async () => {
      const parsed = parseArgs(args);
      await checkLiveGame({...parsed, fetch: fake.fetch});
    }, /--port|未対応または重複/);
    assert.equal(fake.calls.length, 0, JSON.stringify(args));
  }
  assert.deepEqual(parseArgs(['--help']), {port: 8890, help: true});
});

test('network and body errors never expose response or exception data', async () => {
  for (const name of ['TypeError', 'TimeoutError']) {
    await assert.rejects(checkLiveGame({fetch: async () => {
      const error = new Error('PRIVATE_USER_DATA'); error.name = name; throw error;
    }}), error => /接続失敗またはタイムアウト/.test(error.message) && !error.message.includes('PRIVATE'));
  }
  const fake = stub({'/health': ['PRIVATE_USER_DATA', 'application/json']});
  await assert.rejects(checkLiveGame({fetch: fake.fetch}), /^Error: \/health: レスポンスを読み取れません$/);
});

test('fake redirects and bad script MIME fail safely before POST', async () => {
  for (const [path, response, expectedCalls, message] of [
    ['/health', ['PRIVATE_RESPONSE_SECRET', 'text/html', 302], 1, '/health: HTTPエラー'],
    ['/quick-home.mjs', ["element('quickReplay'); // PRIVATE_RESPONSE_SECRET", 'text/plain'],
      3, 'quick-home.mjs'],
  ]) {
    const fake = stub({[path]: response});
    await assert.rejects(checkLiveGame({fetch: fake.fetch}), error => {
      assert.ok(error.message.includes(message));
      assert.ok(!String(error).includes('PRIVATE_RESPONSE_SECRET'));
      return true;
    });
    assert.equal(fake.calls.length, expectedCalls);
    assert.ok(fake.calls.every(call => call.options.redirect === 'error'));
    assert.ok(fake.calls.every(call => call.options.method === 'GET'));
  }
});
