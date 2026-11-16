import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGameServer, pythonPredict} from '../../game_runtime/server.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {request as httpRequest} from 'node:http';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
const reference = JSON.parse(execFileSync('python3', ['-B', 'tests/practice_parity_fixture.py'],
  {cwd, encoding: 'utf8', timeout: 10000}));
const base = (fast_window, slow_window, risk_fraction) => ({
  fast_window, slow_window, risk_fraction,
  plugin_weights: {trend:100, momentum:0, volatility:0, reversion:0},
  plugin_strengths: {trend:100, momentum:100, volatility:100, reversion:100},
});
const snapshot = (revision = 3, gear = 'none') => ({
  state: {revision, model: base(3, 9, .35)},
  lineup: {revision: 2, slots: [
    {slot:'owl', model: base(5, 12, .5)},
    {slot:'turtle', model: base(8, 20, .25)}
  ]},
  growth: {revision: 8, slots: [
    {slot:'mine', gear}, {slot:'owl',gear:'none'},{slot:'turtle',gear:'none'}
  ]},
  source_revision: revision, lineup_revision: 2, growth_revision: 8,
});

async function serve(handler, fn) {
  const srv = createGameServer(handler);
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + srv.address().port;
  try {await fn(url);}
  finally {await new Promise(resolve => srv.close(resolve));}
}
const allocations = {mine:100, owl:0, turtle:0};
const post = (url, body, headers = {}) => fetch(url + '/api/practice', {
  method:'POST', headers: {'Content-Type':'application/json', ...headers},
  body:JSON.stringify(body)
});

test('Node server + actual Python forecaster matches legacy game result', async () => {
  await serve({loadSnapshot:async()=>snapshot()}, async url => {
    const result = await post(url, {allocations});
    assert.equal(result.status, 200);
    const got = await result.json();
    const expected = reference.solo.expected;
    assert.equal(got.mode, 'PRACTICE_SYNTHETIC_ONLY');
    assert.equal(got.final_coins, expected.final_coins);
    assert.equal(got.return_pct, expected.return_pct);
    assert.deepEqual(got.decisions, expected.decisions);
    assert.deepEqual(got.equity_path, expected.equity_path);
    assert.deepEqual(got.model_sha256, expected.model_sha256);
    assert.equal(got.growth_revision, 8);
    assert.equal(got.source_revision, 3);
    assert.equal(got.xp, undefined);
  });
});

test('Node ignores legacy stored gear before asking Python for predictions', async () => {
  let submitted;
  const spy = async input => {submitted = input; return pythonPredict(input);};
  await serve({loadSnapshot:async()=>snapshot(3,'focus_lens'),predict:spy}, async url => {
    const r = await post(url,{allocations});
    assert.equal(r.status,200);
    const got=await r.json();
    assert.equal(submitted.base_model.plugin_strengths.trend,100);
    assert.equal(submitted.models.mine.plugin_strengths.trend,100);
    assert.equal(got.characters.mine.plugin_strengths.trend,100);
    assert.equal(got.characters.mine.plugin_weights.trend,100);
    assert.equal(got.characters.mine.effective_sha256,got.model_sha256);
  });
});

test('Only allocation intentions accepted; no browser-supplied profit or signals', async () => {
  await serve({loadSnapshot:async()=>snapshot()}, async url => {
    for (const invalid of [
      {allocations, profit_coins:999999999},
      {allocations, signals:[{mine:'LONG'}]},
      {allocations:{mine:101, owl:0,turtle:0}},
      {allocations:{mine:-1, owl:0,turtle:0}},
    ]) {
      const r=await post(url,invalid);
      assert.equal(r.status,400);
    }
    const bad=await fetch(url+'/api/practice',{method:'POST',headers:{'Content-Type':'text/plain'},body:'hi'});
    assert.equal(bad.status,415);
  });
});

test('Cross-origin or forged network request cannot run the local game', async () => {
  let calls=0;
  await serve({loadSnapshot:async()=>{calls++;return snapshot();}}, async url => {
    for (const headers of [
      {Origin:'https://example.invalid'},
      {'Sec-Fetch-Site':'cross-site'},
      {'X-Forwarded-For':'127.0.0.1'},
    ]) {
      const r=await post(url,{allocations},headers);
      assert.equal(r.status,403, JSON.stringify(headers));
    }
    const badHost = await new Promise((resolve, reject) => {
      const endpoint = new URL(url);
      const data = JSON.stringify({allocations});
      const req = httpRequest({
        hostname:'127.0.0.1', port:Number(endpoint.port), method:'POST',
        path:'/api/practice', headers:{
          Host:'example.invalid',
          'Content-Type':'application/json',
          'Content-Length':Buffer.byteLength(data),
        }
      }, res => {res.resume();res.on('end',()=>resolve(res.statusCode));});
      req.on('error',reject);req.end(data);
    });
    assert.equal(badHost,403);
    assert.equal(calls,0);
  });
});

test('Revision conflict rejects stale game results', async () => {
  let reads = 0;
  await serve({loadSnapshot:async()=>snapshot(++reads)}, async url => {
    const r=await post(url,{allocations});
    assert.equal(r.status,409);
    assert.match((await r.json()).error,/再実行/);
    assert.equal(reads,2);
  });
});

test('Node preview serves the beginner game and isolated XP flow', async () => {
  await serve({loadSnapshot:async()=>snapshot()}, async url => {
    const r=await fetch(url+'/game');
    assert.equal(r.status,200);
    const content=await r.text();
    assert.match(content, /JavaScriptゲームエンジン実験版/);
    assert.match(content, /コインは保存されません/);
    assert.match(content, /XPは練習実績として1回だけ別保存/);
    assert.match(content, /demo\.mjs/);
    const script=await fetch(url+'/demo.mjs');
    assert.equal(script.status,200);
    assert.match(await script.text(),/api\/practice/);
    assert.equal((await fetch(url+'/favicon.ico')).status, 204);
    const health=await (await fetch(url+'/health')).json();
    assert.equal(health.game_runtime,'node');
    assert.equal(health.xp,'node-tutorial-only');
    assert.equal((await fetch(url+'/api/training/complete',{method:'POST'})).status,415);
  });
});

test('Predictor refuses extra commands, invalid model definitions and arbitrary execution', async () => {
  const node = {...snapshot().state.model};
  await assert.rejects(pythonPredict({base_model:node,models:{mine:node,owl:node,turtle:node},
    python:'print(999)'}));
  await assert.rejects(pythonPredict({base_model:node,models:{mine:{...node,fast_window:'__import__("os")'},owl:node,turtle:node}}));
});
