import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const html = await readFile(new URL('../../game_runtime/demo.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../game_runtime/forward-view-ui.mjs', import.meta.url), 'utf8');
const walletPath = '/api/companion/forward-ai?view=summary';
const recordsPath = '/api/companion/forward-records';
const version = 'appearance-v1_33_26_25_16_50';
const nextId = 'ai_123456781234123412341234567890ab';
const companionVersion = 'companion-v1_100_0_0_0_35';
const generation = (id, model_version = companionVersion) => ({aiId:id, model_version});
const wallet = (cash, position = null) => ({cash, equity:cash + (position ? 100 : 0), status:'ACTIVE', position});
const emptyWallet = {mode:'FORWARD_WALLETS_MARKET_UNCONNECTED', revision:null, created:false, mock:false,
  initialMedals:10_000, unallocated:10_000, currentAiId:null, generations:[], wallets:{}};
const unconnected = {status:'unconnected', records:[]};
const notSaved = {created:false, approach:'trend', risk_percent:35, model_version:null};
const saved = {...notSaved, created:true, model_version:companionVersion};

function mount({state = emptyWallet, records = unconnected, model = notSaved} = {}) {
  class Node {
    constructor(text = '', value = '') {
      this.value = value;
      this.textContent = text;
      this.children = [];
      this.handlers = {};
    }
    set innerHTML(value) { throw Error('Unexpected HTML insertion'); }
    replaceChildren(...nodes) { this.children = nodes; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    focus() { document.activeElement = this; }
    get text() { return [this.textContent, ...this.children.map(node => node.text)].join(' '); }
  }
  const nodes = new Map(Array.from(html.matchAll(/\bid="(forward\w+)"/g), ([,id]) => [id, new Node()]));
  const get = id => nodes.get('forward' + id);
  get('SaveFields').disabled = true;
  const document = {body:new Node(), getElementById:id => nodes.get(id), createElement:() => new Node()};
  const calls = [];
  const values = {[walletPath]:state, [recordsPath]:records, '/api/companion/forward-model':model};
  const fetch = async (path, options) => {
    assert.equal(options.cache, 'no-store');
    const body = options.body && JSON.parse(options.body);
    calls.push({path, method:options.method ?? 'GET', body});
    const handler = values[path];
    const value = typeof handler === 'function' ? await handler(body) : handler;
    const status = value?.httpStatus ?? 200;
    return {ok:status === 200 || status === 201, status, json:async () => value};
  };
  runInNewContext(script, {document, Option:Node, fetch, AbortSignal,
    crypto:{randomUUID:() => '12345678-1234-1234-1234-1234567890ab'}});
  return {get, calls, values, fire:(id, event = 'click') => get(id).handlers[event]({preventDefault(){}})};
}

test('panel follows 12-day practice, loads on opening and shows uninitialized separately from unconnected', async () => {
  assert.ok(html.indexOf('id="simpleHome"') < html.indexOf('id="forwardPanel"'));
  assert.ok(html.indexOf('id="forwardPanel"') < html.indexOf('id="advancedEntry"'));
  assert.match(html, /<label for="forwardAI">/);
  assert.match(html, /<label for="forwardMedals">/);
  assert.match(html, /id="forwardRecordsStatus" role="status" aria-live="polite"/);
  const ui = mount();
  assert.equal(ui.calls.length, 0);
  ui.get('Panel').open = true;
  ui.fire('Panel', 'toggle');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.calls.length, 3);
  assert.match(ui.get('WalletStatus').text, /まだAIの財布は作られていません/);
  assert.match(ui.get('Unallocated').text, /10,000 枚（初回保存時に用意）/);
  assert.match(ui.get('RecordsStatus').text, /未接続.*未記録/);
  assert.equal(ui.get('Records').hidden, true);
  assert.equal(ui.get('SaveFields').disabled, true);
  assert.equal(ui.get('AI').disabled, true);
  await ui.fire('SaveForm', 'submit');
  assert.ok(ui.calls.every(call => call.method === 'GET'));
});

test('explicit save only sends revisions and allocation once, then renders the server wallet and preserves selection on reload', async () => {
  const ui = mount({model:saved});
  await ui.fire('Refresh');
  assert.equal(ui.get('SaveFields').disabled, false);
  ui.get('Medals').valueAsNumber = 300;
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const created = {...emptyWallet, revision:0, created:true, unallocated:9700, currentAiId:nextId,
    generations:[generation(nextId)], wallets:{[nextId]:wallet(300)}};
  ui.values[walletPath] = body => body ? response : created;
  const submit = ui.fire('SaveForm', 'submit');
  assert.equal(ui.get('SaveFields').disabled, true);
  await ui.fire('SaveForm', 'submit');
  await ui.fire('Refresh');
  assert.deepEqual(ui.calls.filter(call => call.method === 'POST'), [{path:walletPath, method:'POST',
    body:{aiId:nextId, medals:300, expected_revision:null, model_version:companionVersion}}]);
  finish(created);
  await submit;
  assert.match(ui.get('SaveStatus').text, /300 枚を配分/);
  assert.match(ui.get('Unallocated').text, /9,700 枚/);
  assert.match(ui.get('Wallet').text, /保存済みの判断ルール.*使えるメダル 300 枚/);

  const second = {...created, created:false, revision:1, unallocated:9200, currentAiId:'ai_second',
    generations:[...created.generations, generation('ai_second')],
    wallets:{...created.wallets, ai_second:wallet(400, {symbol:'FAKE', direction:'LONG'})}};
  ui.values[walletPath] = second;
  await ui.fire('Refresh');
  assert.equal(ui.get('AI').value, nextId);
  ui.get('AI').value = 'ai_second';
  await ui.fire('AI', 'change');
  assert.match(ui.get('Wallet').text, /400 枚.*500 枚.*FAKE・買い/);

  const reopened = mount({state:second, model:saved});
  await reopened.fire('Refresh');
  assert.match(reopened.get('Unallocated').text, /9,200 枚/);
  assert.equal(reopened.get('AI').value, 'ai_second');
});

test('same model does not change balance, and a conflict disables save until a successful refresh', async () => {
  const state = {...emptyWallet, revision:0, unallocated:9700, currentAiId:nextId,
    generations:[generation(nextId)], wallets:{[nextId]:wallet(300)}};
  const ui = mount({state, model:saved});
  await ui.fire('Refresh');
  ui.get('Medals').valueAsNumber = 200;
  await ui.fire('SaveForm', 'submit');
  assert.match(ui.get('SaveStatus').text, /モデルの内容は同じ/);
  assert.match(ui.get('Unallocated').text, /9,700 枚/);
  ui.values[walletPath] = body => body ? {httpStatus:409} : state;
  await ui.fire('SaveForm', 'submit');
  assert.match(ui.get('SaveStatus').text, /再取得/);
  assert.match(ui.get('Unallocated').text, /9,700 枚/);
  assert.equal(ui.get('SaveFields').disabled, true);
  await ui.fire('Refresh');
  assert.equal(ui.get('SaveFields').disabled, false);
});

test('bad responses and temporary disconnection strip stale figures and leave independent records status', async () => {
  const ui = mount({state:{...emptyWallet, unallocated:'10000'}, model:saved});
  await ui.fire('Refresh');
  assert.match(ui.get('WalletStatus').text, /読み取れません/);
  assert.match(ui.get('RecordsStatus').text, /未接続/);
  assert.equal(ui.get('Unallocated').hidden, true);
  ui.values[walletPath] = () => { throw TypeError('fetch failed'); };
  ui.values[recordsPath] = {status:'unconnected', records:[{}]};
  await ui.fire('Refresh');
  assert.match(ui.get('WalletStatus').text, /一時切断/);
  assert.match(ui.get('RecordsStatus').text, /読み取れません/);
  assert.equal(ui.get('SaveFields').disabled, true);
  assert.equal(ui.get('Records').hidden, true);
});

test('PENDING shows reservations and unscored results, then keeps Brier, direction, error and medal loss independent', async () => {
  const state = {...emptyWallet, mock:true, revision:5, unallocated:9600, currentAiId:'ai_other',
    generations:[generation(nextId, version), generation('ai_other')], wallets:{[nextId]:wallet(300), ai_other:wallet(100)}};
  const record = {aiId:nextId, model_version:version, sourceMode:'MOCK_NONLIVE', status:'PENDING',
    symbol:'FAKE', confirmedAt:'2030-01-07T01:00:00.000Z', targetAt:'2030-01-07T01:10:00.000Z',
    direction:'DOWN', predictedChangePct:-4, open:{status:'QUEUED', at:'2030-01-07T01:00:00.000Z'},
    close:{status:'NONE', at:null}, realizedPnl:null, score:null};
  const asRecords = record => ({status:'MOCK_NONLIVE', records:[record]});
  const ui = mount({state, records:asRecords(record)});
  await ui.fire('Refresh');
  ui.get('AI').value = nextId;
  await ui.fire('AI', 'change');
  assert.match(ui.get('Wallet').text, /外見由来の旧実験モデル.*判断ルールとは連動しません/);
  assert.match(ui.get('RecordsStatus').text, /未採点.*本番の予測精度は未計測/);
  assert.match(ui.get('Records').text, /予約中.*メダル損益 未記録.*採点状況 未採点/);
  const settled = {...record, open:{status:'OPENED', at:'2030-01-07T01:05:00.000Z'},
    close:{status:'CLOSED', at:record.targetAt}, realizedPnl:-11.33};
  ui.values[recordsPath] = asRecords(settled);
  await ui.fire('Refresh');
  assert.match(ui.get('Records').text, /決済済み.*-11.33 枚.*未採点/);
  ui.values[recordsPath] = asRecords({...settled, status:'SCORED_MOCK_NONLIVE',
    score:{actualDirection:'DOWN', brier:.14, directionCorrect:true, absoluteChangeErrorPctPoints:1,
      scoredAt:record.targetAt}});
  await ui.fire('Refresh');
  assert.match(ui.get('RecordsStatus').text, /架空（MOCK_NONLIVE）.*採点済み/);
  assert.match(ui.get('Records').text, /-11.33 枚.*Brier.*0.14.*方向の的中 的中.*値幅の誤差 1 ポイント/);
  ui.get('AI').value = 'ai_other';
  await ui.fire('AI', 'change');
  assert.equal(ui.get('Records').hidden, true);
  assert.equal(ui.get('Records').text, '');
});
