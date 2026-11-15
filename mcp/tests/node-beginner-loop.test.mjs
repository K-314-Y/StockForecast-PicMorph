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
    {id:'calm_halo',icon:'🛡️',name:'静寂の輪',unlock_xp:40},
  ];
  return {revision, slots:[{slot:'mine', xp, level:1 + Number(xp >= 20) + Number(xp >= 40), gear,
    gear_options:gears.map(item => ({...item, unlocked:xp>=item.unlock_xp}))}]};
}

async function mount({practiceError=false, deferredClaim=null, initialXp=0, initialGear='none',
  claimXp=30, claimError=false, refreshError=false}={}) {
  const nodes = new Map(), calls = [];
  let xp = initialXp, revision = 0, gear = initialGear, completed = false;
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode());
    return nodes.get(id);
  };
  const fetch = async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({path,body,method:options?.method});
    if (path === '/api/growth') {
      if (completed && refreshError) return {ok:false,json:async()=>({error:'再取得失敗'})};
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
      completed = true;
      if (claimError) return {ok:false,json:async()=>({error:'受取失敗'})};
      const earned = Math.max(0, claimXp - xp);
      xp += earned;
      if (earned) revision++;
      return {ok:true,json:async()=>({earned_xp:{mine:earned}, growth:growth(xp,revision,gear)})};
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
  assert.equal(get('growthCelebration').textContent,'');
  assert.notEqual(get('scene').dataset.growing,'true');
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
  assert.equal(get('growthCelebration').textContent,'');
  assert.notEqual(get('scene').dataset.growing,'true');
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


test('growth progress and milestones restore from API at every threshold and beyond', async () => {
  for (const [xp, remaining] of [[0,20],[20,10],[30,10],[40,0],[50,0]]) {
    const {get,fire,calls} = await mount({initialXp:xp});
    const check = () => {
      assert.equal(get('growthProgress').max,40);
      assert.equal(get('growthProgress').value,Math.min(xp,40));
      assert.match(get('growthNext').textContent,remaining ? new RegExp('あと ' + remaining + ' XP') : /すべて解放済み/);
      assert.equal(get('growthMilestones').children.length,3);
      for (const [i, threshold] of [20,30,40].entries()) {
        assert.match(get('growthMilestones').children[i].textContent,new RegExp(threshold + ' XP'));
        assert.equal(get('growthMilestones').children[i].dataset.unlocked, String(xp >= threshold));
        assert.ok(get('growthMilestones').children[i].textContent.endsWith(xp >= threshold ? '：解放済み' : '：未解放'));
      }
      assert.equal(get('growthCelebration').textContent,'');
      assert.notEqual(get('scene').dataset.growing,'true');
      assert.equal(get('sceneGear').hidden,true);
    };
    check(); await fire('refreshGrowth'); check();
    assert.equal(calls.filter(item=>item.path==='/api/training/complete').length,0);
  }
});

test('confirmed reward celebrates actual level and gear changes while preserving reward details', async () => {
  for (const [initialXp,claimXp,levelText,names] of [
    [0,20,'Lv.1 → Lv.2',['集中レンズ']],
    [20,30,null,['ひらめきの飾り']],
    [30,40,'Lv.2 → Lv.3',['静寂の輪']],
    [0,40,'Lv.1 → Lv.3',['集中レンズ','ひらめきの飾り','静寂の輪']],
  ]) {
    const {get,fire,calls} = await mount({initialXp,claimXp});
    await fire('play'); await fire('claim');
    const celebration = get('growthCelebration').textContent;
    if (levelText) assert.ok(celebration.includes(levelText));
    else assert.doesNotMatch(celebration,/Lv\./);
    for (const name of names) assert.ok(celebration.includes('新装備「' + name + '」が解放！'));
    assert.ok(get('reward').textContent.includes('mine: +' + (claimXp-initialXp) + ' XP'));
    assert.match(get('reward').textContent,/一度だけ/);
    assert.equal(get('growthProgress').value,claimXp);
    assert.equal(get('scene').dataset.growing,'true');
    await fire('scene','animationend');
    assert.equal(get('scene').dataset.growing,'false');
    assert.equal(get('growthCelebration').textContent,celebration);
    await fire('claim');
    assert.equal(calls.filter(item=>item.path==='/api/training/complete').length,1);
    assert.equal(calls.find(item=>item.path==='/api/training/complete').method,'POST');
    await fire('play');
    assert.equal(get('growthCelebration').textContent,'');
    await fire('claim');
    assert.equal(get('growthCelebration').textContent,'');
    assert.notEqual(get('scene').dataset.growing,'true');
  }
});

test('equipped badge follows saved selection, refresh and fresh page restoration', async () => {
  const {get,fire} = await mount({initialXp:40,initialGear:'focus_lens'});
  assert.equal(get('sceneGear').hidden,false);
  assert.equal(get('sceneGear').textContent,'🔎');
  assert.match(get('sceneGear').attributes['aria-label'],/集中レンズ/);
  for (const [id,icon] of [['spark_charm','⚡'],['calm_halo','🛡️'],['none','']]) {
    get('gear').value=id;
    await fire('gear','change'); await fire('equip'); await fire('refreshGrowth');
    assert.equal(get('sceneGear').textContent,icon);
    assert.equal(get('sceneGear').hidden,id==='none');
    assert.equal(get('growthCelebration').textContent,'');
    const restored = await mount({initialXp:40,initialGear:id});
    assert.equal(restored.get('sceneGear').textContent,icon);
    assert.equal(restored.get('growthCelebration').textContent,'');
  }
});

test('zero XP and failed claims never produce false celebrations', async () => {
  for (const config of [{initialXp:30,claimXp:30},{claimError:true},{claimError:true,refreshError:true}]) {
    const {get,fire} = await mount(config);
    await fire('play'); await fire('claim');
    assert.equal(get('growthCelebration').textContent,'');
    assert.notEqual(get('scene').dataset.growing,'true');
    if (config.claimError) {
      assert.match(get('reward').textContent,/確定できません/);
      assert.equal(get('claim').disabled,Boolean(config.refreshError));
    }
  }
});

test('successful claim remains confirmed even if growth refresh fails', async () => {
  const {get,fire} = await mount({refreshError:true});
  await fire('play'); await fire('claim');
  assert.match(get('growthCelebration').textContent,/Lv\.1 → Lv\.2/);
  assert.match(get('reward').textContent,/mine: \+30 XP/);
  assert.match(get('growthInfo').textContent,/再読込が必要/);
  assert.equal(get('claim').disabled,true);
});

test('growth UI uses native labelled progress, text milestones, accessible badge and brief reduced-motion-safe animation', () => {
  assert.match(html,/<label for="growthProgress">/);
  assert.match(html,/<progress id="growthProgress" aria-describedby="growthNext">/);
  assert.match(html,/<ul id="growthMilestones" aria-label="装備解放マイルストーン">/);
  assert.match(html,/<p id="growthCelebration" role="status" aria-live="polite" aria-atomic="true">/);
  assert.match(html,/<span id="sceneGear" role="img" aria-label="装備なし" hidden>/);
  assert.match(html,/#sceneGear\{[^}]*position:absolute[^}]*z-index:4/);
  assert.match(html,/data-growing="true"\] :is\(#chibi,#artworkStage,#portrait\)\{animation:companion-growth \.7s ease-out 1/);
  assert.match(html,/@media\(prefers-reduced-motion:reduce\)\{\.scene\[data-growing="true"\] :is\(#chibi,#artworkStage,#portrait\)\{animation:none\}/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|innerHTML/);
  assert.doesNotMatch(script,/unlock_xp\s*[><=]+\s*(20|30|40)/);
});


test('positive XP without a new milestone animates growth without inventing a celebration', async () => {
  const {get,fire} = await mount({claimXp:10});
  await fire('play'); await fire('claim');
  assert.equal(get('growthCelebration').textContent,'');
  assert.equal(get('scene').dataset.growing,'true');
  assert.equal(get('growthProgress').value,10);
  assert.match(get('growthNext').textContent,/あと 10 XP/);
});
