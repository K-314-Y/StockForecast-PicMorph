import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const page = readFileSync(new URL('../../web/game.html', import.meta.url), 'utf8');
const begin = page.indexOf('// Beginner mode reuses the existing fixed, fictional practice');
const end = page.indexOf('// Details use only the existing evaluation ledger', begin);
assert.ok(begin > 0 && end > begin, 'game page must contain its beginner handlers');

function practice() {
  return {mode: 'PRACTICE_SYNTHETIC_ONLY', initial_coins: 10000, final_coins: 10111.68,
    profit_coins: 111.68, max_drawdown_pct: 1.04, benchmark_buy_hold_pct: 8.33,
    equity_path: [10000, 10010, 9990, 9990, 9990, 9990, 10000, 10020, 10040, 10030, 10060, 10080, 10111.68],
    benchmark_path: [10000, 9900, 9800, 9600, 9400, 9300, 9600, 10000, 10400, 10200, 10600, 10500, 10833],
    decisions: [107, 106, 104, 101, 100, 104, 108, 112, 110, 114, 113, 117].map((price, i) =>
      ({step: i + 1, price, signals: {mine: i < 3 ? 'CASH' : 'LONG'}})),
    characters: {mine: {trades: 8, long_steps: 9, fees: 12.345}}};
}
const earned = (xp = 30) => ({earned_xp: {mine: xp}, growth: {revision: 8, slots: []}});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject}; };

function setup({practiceFails = false, respond} = {}) {
  const elements = new Map(), calls = [];
  let newGrowth;
  const node = () => ({
    textContent: '', disabled: false, hidden: true, style: {}, handlers: {}, children: [], attributes: {},
    addEventListener(event, handler) { this.handlers[event] = handler; },
    setAttribute(key, value) { this.attributes[key] = value; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; }
  });
  const get = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const sandbox = vm.createContext({
    $: get, document: {createElement: node},
    fmt: value => Number(value).toLocaleString('ja-JP', {maximumFractionDigits: 2}),
    growthRevision: 7,
    renderGrowth: value => {newGrowth = value; sandbox.growthRevision = value.revision;},
    call: async (path, body) => {
      calls.push({path, body: body && JSON.parse(JSON.stringify(body))});
      if (respond) return respond(path, body);
      if (path === '/api/practice') {
        if (practiceFails) throw Error('server unavailable');
        return practice();
      }
      if (path === '/api/training/complete') return earned();
      if (path === '/api/growth') return {revision: 8, slots: []};
      throw Error('unexpected API path');
    }
  });
  vm.runInContext(page.slice(begin, end), sandbox);
  return {get, calls, growth: () => newGrowth, click: id => get(id).handlers.click()};
}

test('starter is beginner-first, fictional, accessible and separate from accuracy', () => {
  assert.ok(page.indexOf('id="starter"') < page.indexOf('id="advancedGame"'));
  assert.match(page, /<details id="advancedGame"/);
  assert.match(page, /放置予測は今後実装予定/);
  assert.match(page, /架空の過去12ステップ/);
  assert.match(page, /損益は架空練習、精度\/Brierとは別/);
  assert.match(page, /価格の上下を当てた回数ではありません/);
  assert.match(page, /id="starterDayPanel" role="status" aria-live="polite"/);
  assert.match(page, /button:focus-visible/);
  assert.doesNotMatch(page.slice(begin, end), /setTimeout|setInterval|\.prediction|\.brier|\.accuracy/);
});

test('quick practice uses one slot and XP requires a separate explicit claim', async () => {
  const {get, calls, click, growth} = setup();
  await click('starterClaim');
  assert.equal(calls.length, 0);
  await click('starterPlay');
  assert.deepEqual(calls, [{path: '/api/practice', body: {allocations: {mine: 100, owl: 0, turtle: 0}}}]);
  assert.equal(get('starterResult').hidden, false);
  assert.equal(get('starterClaim').disabled, false);
  assert.match(get('starterFinal').textContent, /10,111.68/);
  assert.match(get('starterStatus').textContent, /架空/);
  await click('starterClaim');
  assert.deepEqual(calls[1], {path: '/api/training/complete',
    body: {allocations: {mine: 100, owl: 0, turtle: 0}, expected_growth_revision: 7}});
  assert.equal(get('starterClaim').disabled, true);
  assert.equal(growth().revision, 8);
  assert.match(get('starterClaimStatus').textContent, /30 XP/);
  assert.match(get('starterClaim').textContent, /受け取り済み/);
});

test('12 days navigate actual returned prices, equity, deltas and holding signals', async () => {
  const {get, click, calls} = setup();
  await click('starterPlay');
  const buttons = get('starterTimeline').children;
  assert.equal(buttons.length, 12);
  assert.equal(buttons[0].attributes['aria-pressed'], 'true');
  assert.equal(buttons[0].attributes['aria-controls'], 'starterDayPanel');
  assert.equal(buttons[11].attributes['aria-label'], '12日目を振り返る');
  assert.match(get('starterDay').textContent, /1日目/);
  assert.equal(get('starterPrice').textContent, '107');
  assert.match(get('starterMovement').textContent, /比較なし.*未提供/);
  assert.equal(get('starterEquity').textContent, '10,010 C');
  assert.equal(get('starterDelta').textContent, '+10 C');
  assert.match(get('starterSignal').textContent, /現金で待つ判断/);
  assert.equal(get('starterPrev').disabled, true);
  await click('starterPrev');
  assert.match(get('starterDay').textContent, /1日目/);
  await click('starterNext');
  assert.equal(get('starterPrice').textContent, '106');
  assert.equal(get('starterMovement').textContent, '-1（-0.93%）');
  assert.equal(get('starterDelta').textContent, '-20 C');
  assert.equal(get('starterBenchmarkCard').hidden, false);
  assert.equal(get('starterDayBenchmark').textContent, '9,800 C');
  assert.equal(buttons[0].attributes['aria-pressed'], 'false');
  assert.equal(buttons[1].attributes['aria-pressed'], 'true');
  await buttons[11].handlers.click();
  assert.match(get('starterDay').textContent, /12日目/);
  assert.equal(get('starterNext').disabled, true);
  assert.equal(get('starterEquity').textContent, '10,111.68 C');
  assert.equal(get('starterDelta').textContent, '+31.68 C');
  assert.match(get('starterSignal').textContent, /買って保有する判断/);
  await click('starterNext');
  assert.match(get('starterDay').textContent, /12日目/);
  await click('starterPrev');
  assert.match(get('starterDay').textContent, /11日目/);
  assert.match(get('starterSummary').textContent, /買って保有 9日 \/ 現金待機 3日 · 売買 8回 · 仮想手数料 12.35 C/);
  await click('starterAdvanced');
  assert.equal(get('advancedGame').open, true);
  assert.equal(calls.length, 1);
});

test('missing optional benchmark and character summary never invent values or block play', async () => {
  const result = practice(); delete result.benchmark_path; delete result.characters;
  const {get, click} = setup({respond: async () => result});
  await click('starterPlay');
  assert.equal(get('starterResult').hidden, false);
  assert.equal(get('starterBenchmarkCard').hidden, true);
  assert.equal(get('starterDayBenchmark').textContent, '');
  assert.equal(get('starterSummary').textContent, '12日間の判断：買って保有 9日 / 現金待機 3日');
});

test('invalid optional benchmark stays hidden after a valid previous run', async () => {
  const result = practice();
  const {get, click} = setup({respond: async () => result});
  await click('starterPlay');
  result.benchmark_path[3] = NaN;
  await click('starterPlay');
  assert.equal(get('starterBenchmarkCard').hidden, true);
  assert.equal(get('starterDayBenchmark').textContent, '');
});

test('failed quick practice leaves no claim eligibility', async () => {
  const {get, calls, click} = setup({practiceFails: true});
  await click('starterPlay'); await click('starterClaim');
  assert.equal(calls.length, 1);
  assert.equal(get('starterResult').hidden, true);
  assert.equal(get('starterClaim').disabled, true);
  assert.equal(get('starterPlay').disabled, false);
  assert.match(get('starterStatus').textContent, /練習に失敗/);
});

test('replay failure clears old review and claim; another play recovers and starts day 1', async () => {
  let fail = false;
  const {get, calls, click} = setup({respond: async () => {if (fail) throw Error('offline'); return practice();}});
  await click('starterPlay'); await get('starterTimeline').children[11].handlers.click();
  fail = true; await click('starterPlay'); await click('starterClaim');
  assert.equal(calls.length, 2);
  assert.equal(get('starterTimeline').children.length, 0);
  assert.equal(get('starterResult').hidden, true);
  assert.equal(get('starterClaim').disabled, true);
  fail = false; await click('starterPlay');
  assert.equal(get('starterResult').hidden, false);
  assert.match(get('starterDay').textContent, /1日目/);
  assert.equal(get('starterTimeline').children.length, 12);
});

test('essential malformed responses fail safely without XP', async () => {
  for (const change of [r => r.mode = 'LIVE', r => r.final_coins = NaN,
    r => r.equity_path.pop(), r => r.decisions.pop(), r => r.decisions[0].price = null,
    r => r.decisions[0].signals.mine = 'UP', r => r.decisions[1].step = 1]) {
    const result = practice(); change(result);
    const {get, click, calls} = setup({respond: async () => result});
    await click('starterPlay'); await click('starterClaim');
    assert.equal(get('starterResult').hidden, true);
    assert.equal(get('starterClaim').disabled, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(get('starterStatus').textContent, /NaN|Infinity/);
  }
});

test('pending play guards double clicks and claims so stale calls cannot race', async () => {
  let pending = deferred();
  const {get, click, calls} = setup({respond: () => pending.promise});
  const playing = click('starterPlay');
  assert.equal(get('starterPlay').disabled, true);
  assert.equal(get('starterClaim').disabled, true);
  await click('starterPlay'); await click('starterClaim');
  assert.equal(calls.length, 1);
  pending.resolve(practice()); await playing;
  assert.equal(get('starterResult').hidden, false);
  assert.equal(get('starterPlay').disabled, false);
  pending = deferred();
  const replaying = click('starterPlay');
  assert.equal(get('starterResult').hidden, true);
  await click('starterClaim'); await click('starterPlay');
  assert.equal(calls.length, 2);
  pending.reject(Error('replay failed')); await replaying;
  await click('starterClaim');
  assert.equal(calls.length, 2);
  assert.equal(get('starterResult').hidden, true);
  assert.equal(get('starterClaim').disabled, true);
});

test('pending claim blocks replay and repeated claims, including handler calls', async () => {
  const pending = deferred();
  const {get, calls, click} = setup({respond: path => path === '/api/practice' ? practice() : pending.promise});
  await click('starterPlay'); const claiming = click('starterClaim');
  assert.equal(get('starterPlay').disabled, true);
  assert.equal(get('starterClaim').disabled, true);
  await click('starterPlay'); await click('starterClaim');
  assert.equal(calls.length, 2);
  pending.resolve(earned()); await claiming;
  await click('starterClaim');
  assert.equal(calls.length, 2);
  await click('starterPlay'); await click('starterClaim');
  assert.equal(calls.length, 3);
  assert.equal(get('starterClaim').disabled, true);
  assert.match(get('starterClaimStatus').textContent, /受け取り済み/);
});

test('claim failure refreshes revision, permits retry and recognizes zero XP as already received', async () => {
  let fail = true;
  const {get, click, calls} = setup({respond: path => {
    if (path === '/api/practice') return practice();
    if (path === '/api/growth') return {revision: 9, slots: []};
    if (fail) throw Error('revision conflict');
    return earned(0);
  }});
  await click('starterPlay'); await click('starterClaim');
  assert.equal(get('starterClaim').disabled, false);
  assert.equal(get('starterPlay').disabled, false);
  assert.match(get('starterClaimStatus').textContent, /失敗.*もう一度/);
  fail = false; await click('starterClaim');
  assert.equal(calls.at(-1).body.expected_growth_revision, 9);
  assert.match(get('starterClaimStatus').textContent, /すでに受け取り済み/);
  assert.equal(get('starterClaim').disabled, true);
  await click('starterClaim'); assert.equal(calls.length, 4);
});


test('failed growth refresh releases busy state and an uncertain claim can safely retry', async () => {
  const refreshing = deferred(), refreshStarted = deferred();
  let retry = false;
  const {get, click, calls} = setup({respond: path => {
    if (path === '/api/practice') return practice();
    if (path === '/api/growth') { refreshStarted.resolve(); return refreshing.promise; }
    if (!retry) throw Error('response lost');
    return earned(0);
  }});
  await click('starterPlay');
  const claiming = click('starterClaim');
  await refreshStarted.promise;
  assert.equal(calls.at(-1).path, '/api/growth');
  await click('starterPlay'); await click('starterClaim');
  assert.equal(calls.length, 3);
  refreshing.reject(Error('offline')); await claiming;
  assert.equal(get('starterPlay').disabled, false);
  assert.equal(get('starterClaim').disabled, false);
  retry = true; await click('starterClaim');
  assert.equal(get('starterClaim').disabled, true);
  assert.match(get('starterClaimStatus').textContent, /受け取り済み/);
});

test('companion reacts to confirmed practice, selected signal and actual XP only', async () => {
  const pending=deferred();
  const h=setup({respond:path=>path==='/api/practice'?pending.promise:earned()});
  const state=()=>h.get('characterScene').attributes['data-state'];
  const run=h.click('starterPlay');assert.equal(state(),'practicing');
  pending.resolve(practice());await run;assert.equal(state(),'result positive');
  await h.get('starterTimeline').children[0].handlers.click();assert.equal(state(),'cash');
  await h.get('starterTimeline').children[3].handlers.click();assert.equal(state(),'holding');
  await h.click('starterClaim');assert.equal(state(),'growth');
  assert.deepEqual(h.calls.map(c=>c.path),['/api/practice','/api/training/complete']);
  const negative=practice();negative.profit_coins=-20;
  const n=setup({respond:()=>negative});await n.click('starterPlay');assert.equal(n.get('characterScene').attributes['data-state'],'result negative');
  const f=setup({practiceFails:true});await f.click('starterPlay');assert.equal(f.get('characterScene').attributes['data-state'],'ready');
  const zero=setup({respond:path=>path==='/api/practice'?practice():earned(0)});await zero.click('starterPlay');await zero.click('starterClaim');assert.notEqual(zero.get('characterScene').attributes['data-state'],'growth');
});
