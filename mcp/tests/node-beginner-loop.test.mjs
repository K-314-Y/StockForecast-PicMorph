import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const root = new URL('../../game_runtime/', import.meta.url);
const script = await readFile(new URL('demo.mjs', root), 'utf8');
const html = await readFile(new URL('demo.html', root), 'utf8');

class FakeNode {
  constructor() {
    this.children = [];
    this.handlers = {};
    this.attributes = {};
    this.dataset = {};
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
  }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  replaceChildren(...items) { this.children = [...items]; }
  append(child) { this.children.push(child); }
  async fire(name = 'click') { return this.handlers[name]?.(); }
}

function practice() {
  return {
    mode: 'PRACTICE_SYNTHETIC_ONLY',
    decisions: Array.from({length: 12}, (_, i) => ({
      step: i + 1, price: 100 + i, signals: {mine: i % 2 ? 'CASH' : 'LONG'},
    })),
    equity_path: Array.from({length: 13}, (_, i) => 1000 + i * 10),
    final_coins: 1120, profit_coins: 120, max_drawdown_pct: 5,
    training_ticket: 'a'.repeat(48),
  };
}
function growth(xp, revision, gear) {
  const gears = [
    {id:'none',icon:'·',name:'装備なし',unlock_xp:0},
    {id:'focus_lens',icon:'🔎',name:'集中レンズ',unlock_xp:20},
    {id:'spark_charm',icon:'⚡',name:'ひらめきの飾り',unlock_xp:30},
  ];
  return {revision, slots:[{slot:'mine', xp, level:xp >= 20 ? 2 : 1, gear,
    gear_options:gears.map(item => ({...item, unlocked:xp>=item.unlock_xp}))}]};
}

async function mount({practiceError=false, deferredClaim=null}={}) {
  const nodes = new Map(), calls = [];
  let xp = 0, revision = 0, gear = 'none';
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode());
    return nodes.get(id);
  };
  const fetch = async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({path,body});
    if (path === '/api/growth') {
      return {ok:true,json:async()=>growth(xp,revision,gear)};
    }
    if (path === '/api/practice') {
      if (practiceError) return {ok:false,json:async()=>({error:'練習データを取得できません'})};
      return {ok:true,json:async()=>practice()};
    }
    if (path === '/api/training/complete') {
      if (deferredClaim) await deferredClaim.promise;
      assert.equal(body.ticket, 'a'.repeat(48));
      assert.equal(body.expected_growth_revision,revision);
      xp=30;revision++;
      return {ok:true,json:async()=>({earned_xp:{mine:30}, growth:growth(xp,revision,gear)})};
    }
    if (path === '/api/growth/equip') {
      assert.equal(body.slot,'mine');
      assert.equal(body.expected_growth_revision,revision);
      gear=body.gear_id;revision++;
      return {ok:true,json:async()=>growth(xp,revision,gear)};
    }
    throw Error('unexpected fetch: ' + path);
  };
  runInNewContext(script, {
    document: {getElementById:get,createElement:()=>new FakeNode()},
    fetch,
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {get,calls,fire:(id,type='click')=>get(id).fire(type)};
}

test('Node practice UI shows 12 days and requires deliberate reward disposal before replay', async () => {
  const {get, fire, calls} = await mount();
  assert.match(get('growthInfo').textContent,/Lv\.1/);
  await fire('play');
  assert.equal(get('result').hidden,false);
  assert.equal(get('days').children.length,12);
  assert.equal(get('play').disabled,true);
  assert.equal(get('claim').disabled,false);
  await fire('next');
  assert.match(get('dayCount').textContent,/2 \/ 12/);
  assert.equal(get('scene').dataset.mood,'cautious');
  await fire('discard');
  assert.equal(get('play').disabled,true,'first discard click cannot erase ticket');
  await fire('discard');
  assert.equal(get('play').disabled,false,'explicit second click discards ticket');
  assert.equal(calls.filter(item=>item.path==='/api/training/complete').length,0);
});

test('XP is awarded once, unlocks gear, and replays without extra claim', async () => {
  const {get,fire,calls} = await mount();
  await fire('play');
  await fire('claim');
  assert.match(get('growthInfo').textContent,/30 XP/);
  assert.equal(get('claim').disabled,true);
  assert.equal(get('play').disabled,false);
  get('gear').value='focus_lens';
  await fire('gear','change');
  assert.equal(get('equip').disabled,false);
  await fire('equip');
  assert.match(get('currentGear').textContent,/集中レンズ/);
  assert.equal(calls.filter(item=>item.path==='/api/training/complete').length,1);
  await fire('play');
  assert.equal(get('play').disabled,true,'new ticket must be handled separately');
});

test('pending reward blocks concurrent replay and leaves XP unchanged until server confirmation', async () => {
  let resolve;
  const deferredClaim={promise:new Promise(r=>{resolve=r;})};
  const {get,fire,calls} = await mount({deferredClaim});
  await fire('play');
  const pending=fire('claim');
  assert.equal(get('play').disabled,true);
  assert.match(get('growthInfo').textContent,/0 XP/);
  await fire('play');
  assert.equal(calls.filter(item=>item.path==='/api/practice').length,1);
  resolve();await pending;
  assert.match(get('growthInfo').textContent,/30 XP/);
});

test('practice failure never enables claim or pretends XP has been earned', async () => {
  const {get,fire,calls}=await mount({practiceError:true});
  await fire('play');
  assert.equal(get('result').hidden,true);
  assert.equal(get('claim').disabled,true);
  assert.equal(get('play').disabled,false);
  assert.match(get('status').textContent,/失敗/);
  assert.equal(calls.filter(item=>item.path==='/api/training/complete').length,0);
});

test('screen is self-contained, responsive, accessible, and clearly marked synthetic', () => {
  for (const id of ['scene','speech','play','result','days','dayDetail','next',
    'claim','discard','growthInfo','gear','equip','currentGear']) {
    assert.match(html,new RegExp('id="' + id + '"'));
  }
  assert.match(html,/prefers-reduced-motion/);
  assert.match(html,/@media\(max-width:680px\)/);
  assert.match(html,/aria-live="polite"/);
  assert.match(html,/架空相場/);
  assert.doesNotMatch(html,/<script[^>]*src="https?:/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|innerHTML/);
});
