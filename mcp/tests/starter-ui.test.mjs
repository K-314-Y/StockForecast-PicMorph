import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const page = readFileSync(new URL('../../web/game.html', import.meta.url), 'utf8');
const begin = page.indexOf('// Beginner mode reuses the existing fixed, fictional practice');
const end = page.indexOf('// Details use only the existing evaluation ledger', begin);
assert.ok(begin > 0 && end > begin, 'game page must contain its beginner handlers');

function setup({practiceFails = false} = {}) {
  const elements = new Map();
  const calls = [];
  let newGrowth;
  const get = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: '', disabled: false, hidden: true, style: {}, handlers: {},
        addEventListener(event, handler) { this.handlers[event] = handler; }
      });
    }
    return elements.get(id);
  };
  const sandbox = vm.createContext({
    $: get,
    fmt: value => Number(value).toLocaleString('ja-JP', {maximumFractionDigits: 2}),
    growthRevision: 7,
    renderGrowth: value => {newGrowth = value;},
    call: async (path, body) => {
      calls.push({path, body: JSON.parse(JSON.stringify(body))});
      if (path === '/api/practice') {
        if (practiceFails) throw Error('server unavailable');
        return {mode: 'PRACTICE_SYNTHETIC_ONLY', final_coins: 10111.68,
          profit_coins: 111.68, max_drawdown_pct: 1.04};
      }
      if (path === '/api/training/complete') return {
        earned_xp: {mine: 30}, growth: {revision: 8, slots: []}
      };
      throw Error('unexpected API path');
    }
  });
  vm.runInContext(page.slice(begin, end), sandbox);
  return {get, calls, growth: () => newGrowth};
}

test('starter appears before collapsed advanced controls and truthfully labels fictional practice', () => {
  assert.ok(page.indexOf('id="starter"') < page.indexOf('id="advancedGame"'));
  assert.match(page, /<details id="advancedGame"/);
  assert.match(page, /放置予測は今後実装予定/);
  assert.match(page, /架空の過去12ステップ/);
});

test('one-character quick practice never changes XP without user claiming', async () => {
  const testPage = setup();
  const {get, calls} = testPage;
  await get('starterPlay').handlers.click();
  assert.deepEqual(calls, [{
    path: '/api/practice',
    body: {allocations: {mine: 100, owl: 0, turtle: 0}}
  }]);
  assert.equal(get('starterResult').hidden, false);
  assert.equal(get('starterClaim').disabled, false);
  assert.match(get('starterFinal').textContent, /10,111.68/);
  assert.match(get('starterStatus').textContent, /架空/);
  await get('starterClaim').handlers.click();
  assert.deepEqual(calls[1], {
    path: '/api/training/complete',
    body: {allocations: {mine: 100, owl: 0, turtle: 0}, expected_growth_revision: 7}
  });
  assert.equal(get('starterClaim').disabled, true);
  assert.equal(testPage.growth().revision, 8);
  assert.match(get('starterClaimStatus').textContent, /30 XP/);
});

test('failed quick practice does not enable XP claim', async () => {
  const {get, calls} = setup({practiceFails: true});
  await get('starterPlay').handlers.click();
  assert.equal(calls.length, 1);
  assert.equal(get('starterResult').hidden, true);
  assert.equal(get('starterClaim').disabled, true);
  assert.equal(get('starterPlay').disabled, false);
  assert.match(get('starterStatus').textContent, /練習に失敗/);
});
