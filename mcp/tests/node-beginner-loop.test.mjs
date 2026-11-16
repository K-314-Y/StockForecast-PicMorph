import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createGrowthStore} from '../../game_runtime/growth.mjs';

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

function practice(allocations = {mine:100,owl:0,turtle:0}) {
  return {
    mode: 'PRACTICE_SYNTHETIC_ONLY',
    decisions: Array.from({length: 12}, (_, i) => ({
      step: i + 1, price: 100 + i, signals: {mine: i % 2 ? 'CASH' : 'LONG'},
    })),
    equity_path: Array.from({length: 13}, (_, i) => 1000 + i * 10),
    final_coins: 1120, profit_coins: 120, max_drawdown_pct: 5,
    training_ticket: 'a'.repeat(48),
    characters: Object.fromEntries(Object.entries(allocations).map(([slot,allocation_pct]) =>
      [slot,{allocation_pct}])),
  };
}
function growth(xp, revision) {
  return {revision, slots:[{slot:'mine', xp, level:1 + Number(xp >= 20) + Number(xp >= 40),
    achievements:xp ? ['first_practice'] : []}],
    challenges:[{id:'first_practice',name:'はじめての練習',xp:20}]};
}

async function mount({practiceError=false, deferredClaim=null, initialXp=0,
  claimXp=30, claimError=false, refreshError=false, deferredPractice=null,
  practiceResponse=null, growthStore=null}={}) {
  const nodes = new Map(), calls = [];
  let xp = initialXp, revision = 0, completed = false;
  let ticketAllocations = null;
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode());
    return nodes.get(id);
  };
  const fetch = async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({path,body,method:options?.method});
    if (path === '/api/growth') {
      if (completed && refreshError) return {ok:false,json:async()=>({error:'再取得失敗'})};
      if (growthStore) return {ok:true,json:()=>growthStore.public()};
      return {ok:true,json:async()=>growth(xp,revision)};
    }
    if (path === '/api/practice') {
      if (deferredPractice) await deferredPractice.promise;
      if (practiceError) return {ok:false,json:async()=>({error:'練習データを取得できません'})};
      ticketAllocations = body.allocations;
      return {ok:true,json:async()=>practiceResponse ?? practice(body.allocations)};
    }
    if (path === '/api/training/complete') {
      if (deferredClaim) await deferredClaim.promise;
      assert.equal(body.ticket, 'a'.repeat(48));
      if (growthStore) {
        assert.ok(ticketAllocations, 'claim requires a practice ticket');
        const allocations = ticketAllocations;
        ticketAllocations = null;
        return {ok:true,json:()=>growthStore.complete(allocations,body.expected_growth_revision)};
      }
      assert.equal(body.expected_growth_revision,revision);
      completed = true;
      if (claimError) return {ok:false,json:async()=>({error:'受取失敗'})};
      const earned = Math.max(0, claimXp - xp);
      xp += earned;
      if (earned) revision++;
      return {ok:true,json:async()=>({earned_xp:{mine:earned}, growth:growth(xp,revision)})};
    }
    throw Error('unexpected fetch: ' + path);
  };
  // Match the native select's initial selection in demo.html.
  get('adventureMode').value = 'solo';
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

test('adventure select has exactly two labelled choices and starts with solo payload', async () => {
  const select = html.match(/<select id="adventureMode"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select);
  assert.equal((select[1].match(/<option /g) || []).length,2);
  assert.match(select[1],/value="solo" selected>ひとりで挑戦（自分の相棒100%）/);
  assert.match(select[1],/value="team">フクロウと挑戦（自分の相棒50%・フクロウ50%）/);
  assert.match(html,/<label for="adventureMode">冒険の作戦<\/label>/);
  assert.match(select[0],/aria-describedby="adventureNote"/);
  assert.match(html,/同じ架空資産に対する2キャラの配分/);
  assert.match(html,/銘柄分散や実際の投資ではありません/);
  assert.match(html,/受取は練習後の「XPを受け取る」ボタンだけ/);
  const {get,fire,calls} = await mount();
  assert.equal(get('adventureMode').disabled,false);
  await fire('play');
  assert.deepEqual(calls.find(item=>item.path==='/api/practice').body,
    {allocations:{mine:100,owl:0,turtle:0}});
  assert.match(get('resultAllocation').textContent,/ひとり練習.*mine）100%.*owl）0%.*turtle）0%/);
});

test('team sends exact 50/50 payload and locks selection during practice and pending ticket', async () => {
  let resolve;
  const deferredPractice = {promise:new Promise(r=>{resolve=r;})};
  const {get,fire,calls} = await mount({deferredPractice});
  get('adventureMode').value = 'team';
  const pending = fire('play');
  assert.equal(get('adventureMode').disabled,true);
  assert.equal(get('play').disabled,true);
  await fire('play');
  assert.equal(calls.filter(item=>item.path==='/api/practice').length,1);
  assert.deepEqual(calls.find(item=>item.path==='/api/practice').body,
    {allocations:{mine:50,owl:50,turtle:0}});
  resolve(); await pending;
  assert.match(get('resultAllocation').textContent,/チーム練習.*mine）50%.*owl）50%.*turtle）0%/);
  assert.match(get('resultCompanion').textContent,/未作成の標準モデル/);
  assert.match(get('growthInfo').textContent,/0 XP/);
  assert.equal(get('adventureMode').disabled,true);
  await fire('play');
  assert.equal(calls.filter(item=>item.path==='/api/practice').length,1);
  await fire('discard');
  assert.equal(get('adventureMode').disabled,true);
  await fire('discard');
  assert.equal(get('adventureMode').disabled,false);
});

test('result allocation follows API characters even when selection differs or metadata is absent', async () => {
  const mismatched = await mount({practiceResponse:practice()});
  mismatched.get('adventureMode').value = 'team';
  await mismatched.fire('play');
  assert.match(mismatched.get('resultAllocation').textContent,/ひとり練習.*mine）100%/);
  assert.doesNotMatch(mismatched.get('resultAllocation').textContent,/チーム練習/);
  for (const characters of [undefined, {}, {mine:{allocation_pct:50}},
    {mine:{allocation_pct:'50'},owl:{allocation_pct:50},turtle:{allocation_pct:0}}]) {
    const {get,fire} = await mount({practiceResponse:{...practice(),characters}});
    get('adventureMode').value = 'team';
    await fire('play');
    assert.equal(get('result').hidden,false);
    assert.match(get('resultAllocation').textContent,/配分を確認できません.*API応答/);
    assert.doesNotMatch(get('resultAllocation').textContent,/チーム練習|50%|100%/);
  }
});

test('invalid adventure modes never reach practice API and valid selection recovers', async () => {
  const {get,fire,calls} = await mount();
  for (const mode of ['', 'owl', 'TEAM', 'constructor', '__proto__']) {
    get('adventureMode').value = mode;
    await fire('play');
    assert.match(get('status').textContent,/作戦を選び直してください/);
    assert.equal(get('play').disabled,false);
    assert.equal(get('adventureMode').disabled,false);
    assert.equal(get('claim').disabled,true);
  }
  assert.equal(calls.filter(item=>item.path==='/api/practice').length,0);
  get('adventureMode').value = 'team';
  await fire('play');
  assert.equal(get('result').hidden,false);
});

test('malformed results restore controls and allow a successful retry', async () => {
  const response = {...practice(), decisions:[]};
  const {get,fire,calls} = await mount({practiceResponse:response});
  get('adventureMode').value = 'team';
  await fire('play');
  assert.equal(get('result').hidden,true);
  assert.equal(get('claim').disabled,true);
  assert.equal(get('play').disabled,false);
  assert.equal(get('adventureMode').disabled,false);
  assert.match(get('status').textContent,/練習結果の形式が不正/);
  assert.match(get('growthInfo').textContent,/0 XP/);
  Object.assign(response,practice({mine:50,owl:50,turtle:0}));
  await fire('play');
  assert.equal(get('result').hidden,false);
  assert.equal(get('adventureMode').disabled,true);
  assert.equal(calls.filter(item=>item.path==='/api/training/complete').length,0);
});

test('team claims use existing growth store: 40 XP only after explicit claim and no repeat XP', async t => {
  for (const soloFirst of [false,true]) {
    const dir = await mkdtemp(join(tmpdir(),'creature-team-'));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const growthStore = createGrowthStore({file:join(dir,'growth.json'),legacyFile:join(dir,'absent.json')});
    const {get,fire,calls} = await mount({growthStore});
    if (soloFirst) {
      await fire('play'); await fire('claim');
      assert.match(get('growthInfo').textContent,/30 XP/);
    }
    get('adventureMode').value = 'team';
    await fire('play');
    const before = soloFirst ? 30 : 0;
    assert.equal((await growthStore.public()).slots.find(x=>x.slot==='mine').xp,before);
    assert.match(get('growthInfo').textContent,new RegExp(before + ' XP'));
    assert.equal(get('adventureMode').disabled,true);
    await fire('claim');
    assert.match(get('growthInfo').textContent,/40 XP/);
    assert.match(get('reward').textContent,new RegExp('mine: \\+' + (40-before) + ' XP'));
    assert.match(get('growthCelebration').textContent,/Lv\./);
    assert.equal(get('adventureMode').disabled,false);
    const claimCount = calls.filter(x=>x.path==='/api/training/complete').length;
    await fire('claim');
    assert.equal(calls.filter(x=>x.path==='/api/training/complete').length,claimCount);
    await fire('play'); await fire('claim');
    assert.match(get('reward').textContent,/mine: \+0 XP/);
    assert.match(get('growthInfo').textContent,/40 XP/);
    assert.equal(get('growthCelebration').textContent,'');
  }
});

test('XP is awarded once and replays without extra claim', async () => {
  const {get,fire,calls} = await mount();
  await fire('play');
  await fire('claim');
  assert.match(get('growthInfo').textContent,/30 XP/);
  assert.equal(get('claim').disabled,true);
  assert.equal(get('play').disabled,false);
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
  assert.equal(get('adventureMode').disabled,true);
  assert.match(get('growthInfo').textContent,/0 XP/);
  assert.equal(get('growthCelebration').textContent,'');
  assert.notEqual(get('scene').dataset.growing,'true');
  await fire('play');
  assert.equal(calls.filter(item=>item.path==='/api/practice').length,1);
  resolve();await pending;
  assert.match(get('growthInfo').textContent,/30 XP/);
  assert.equal(get('adventureMode').disabled,false);
});

test('practice failure never enables claim or pretends XP has been earned', async () => {
  const {get,fire,calls}=await mount({practiceError:true});
  await fire('play');
  assert.equal(get('result').hidden,true);
  assert.equal(get('claim').disabled,true);
  assert.equal(get('play').disabled,false);
  assert.equal(get('adventureMode').disabled,false);
  assert.match(get('status').textContent,/失敗/);
  assert.equal(get('growthCelebration').textContent,'');
  assert.notEqual(get('scene').dataset.growing,'true');
  assert.equal(calls.filter(item=>item.path==='/api/training/complete').length,0);
});

test('screen is self-contained, responsive, accessible, and clearly marked synthetic', () => {
  for (const id of ['scene','speech','play','result','days','dayDetail','next',
    'claim','discard','growthInfo','growthAchievements']) {
    assert.match(html,new RegExp('id="' + id + '"'));
  }
  assert.match(html,/prefers-reduced-motion/);
  assert.match(html,/@media\(max-width:680px\)/);
  assert.match(html,/aria-live="polite"/);
  assert.match(html,/架空相場/);
  assert.doesNotMatch(html,/<script[^>]*src="https?:/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|innerHTML/);
});


test('XP, level and achievements restore without unlocking rewards or making writes', async () => {
  for (const xp of [0,20,30,40,50]) {
    const {get,fire,calls} = await mount({initialXp:xp});
    for (let i=0;i<2;i++) {
      assert.match(get('growthInfo').textContent,new RegExp(xp + ' XP'));
      assert.match(get('growthAchievements').textContent,xp ? /はじめての練習/ : /まだありません/);
      assert.equal(get('growthCelebration').textContent,'');
      await fire('refreshGrowth');
    }
    assert.equal(calls.filter(item=>item.method==='POST').length,0);
  }
});

test('confirmed reward celebrates actual level changes while preserving reward details', async () => {
  for (const [initialXp,claimXp,levelText] of [
    [0,20,'Lv.1 → Lv.2'], [20,30,null],
    [30,40,'Lv.2 → Lv.3'], [0,40,'Lv.1 → Lv.3'],
  ]) {
    const {get,fire,calls} = await mount({initialXp,claimXp});
    await fire('play'); await fire('claim');
    const celebration = get('growthCelebration').textContent;
    if (levelText) assert.ok(celebration.includes(levelText));
    else assert.doesNotMatch(celebration,/Lv\./);
    assert.doesNotMatch(celebration,/装備|解放/);
    assert.ok(get('reward').textContent.includes('mine: +' + (claimXp-initialXp) + ' XP'));
    assert.match(get('reward').textContent,/一度だけ/);
    assert.match(get('growthInfo').textContent,new RegExp(claimXp + ' XP'));
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

test('retired gear controls and API calls are absent, while artwork remains available', () => {
  assert.doesNotMatch(html + script,/装備|focus_lens|spark_charm|calm_halo|gear_options|growthProgress|growthMilestones|sceneGear|growth\/equip/);
  for (const id of ['artworkStage','artworkSaveBase','reloadArtwork','growthAchievements'])
    assert.ok(html.includes('id="'+id+'"'));
  assert.match(html,/<h1>自分で作った相棒で冒険<\/h1>/);
  assert.match(html,/自分の相棒の冒険記録/);
  assert.match(html,/<details class="advanced-entry" id="advancedEntry" open>/);
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

test('level confirmation is accessible and reduced-motion safe', () => {
  assert.match(html,/<p id="growthCelebration" role="status" aria-live="polite" aria-atomic="true">/);
  assert.match(html,/@media\(prefers-reduced-motion:reduce\)\{\.scene\[data-growing="true"\] :is\(#chibi,#artworkStage,#portrait\)\{animation:none\}/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|innerHTML/);
});

test('positive XP without a new milestone animates growth without inventing a celebration', async () => {
  const {get,fire} = await mount({claimXp:10});
  await fire('play'); await fire('claim');
  assert.equal(get('growthCelebration').textContent,'');
  assert.equal(get('scene').dataset.growing,'true');
  assert.match(get('growthInfo').textContent,/10 XP/);
});
