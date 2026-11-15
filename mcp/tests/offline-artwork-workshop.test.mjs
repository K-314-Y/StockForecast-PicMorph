import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {request} from 'node:http';
import {createGameServer} from '../../game_runtime/server.mjs';

const names = ['preview_extract', 'refine_prediction', 'choose_seeds', 'annotate'];
const paths = names.flatMap(name => ['html', 'js'].map(ext => `/artwork-lab/${name}.${ext}`));
const source = path => new URL(`../../experiments/image_parts/${path.split('/').at(-1)}`, import.meta.url);
const gameCsp = "default-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'";
const labCsp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function checkWorkshop(html) {
  const area = html.slice(html.indexOf('<details id="artworkControls"'), html.indexOf('<details id="skinControls"'));
  const workshop = area.match(/<details id="artworkWorkshop"[^>]*>([\s\S]*?)<\/details>/)?.[1];
  assert.ok(workshop, 'workshop is nested inside the existing artwork controls');
  assert.match(workshop, /<summary>画像工房（ローカル実験）<\/summary>/);
  for (const name of names) {
    assert.ok(workshop.includes(`href="/artwork-lab/${name}.html" target="_blank" rel="noopener noreferrer"`));
  }
  for (const text of ['許可', 'RGB', 'AI', 'アップロードしません', '再選択', 'ダウンロード',
    '共有状態・自動転送はありません', '自動読込・自動保存もしません', 'カラーPNG', 'SAVE',
    '450KB', 'キャンバス寸法・位置', '正解を見る前', '予測や修正済み予測から作らない', 'ゲームの表示パーツには使いません']) {
    assert.ok(workshop.includes(text), text);
  }
  assert.doesNotMatch(workshop, /<script|<iframe|\son\w+\s*=|https?:\/\//i);
  for (const slot of ['Base', 'Hair', 'Face', 'Outfit']) {
    assert.ok(area.includes(`id="artworkFile${slot}"`));
    assert.ok(area.includes(`id="artworkSave${slot}"`));
  }
}

test('local source pages keep their CSP, relative scripts and explicit file picker UI', async () => {
  const titles = ['予測マスクを試す', '予測マスクを手直しする', '元画像だけを見てseedを選ぶ', '手で描く正解マスク'];
  for (const [i, name] of names.entries()) {
    const html = await readFile(source(`${name}.html`), 'utf8');
    assert.ok(html.includes(titles[i]));
    assert.ok(html.includes(`<script src="${name}.js" defer></script>`));
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /worker-src 'none'/);
    assert.match(html, /type="file"/);
    assert.match(html, /<canvas/);
    assert.doesNotMatch(html, /<iframe|<form|<img\b|data:image\//i);
    const js = await readFile(source(`${name}.js`), 'utf8');
    assert.match(js, /createObjectURL/);
    assert.doesNotMatch(js, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|\/api\/|localStorage|indexedDB|postMessage|data:image\//);
  }
});

test('game source explains manual downloads, independent gold and explicit SAVE', async () => {
  checkWorkshop(await readFile(new URL('../../game_runtime/demo.html', import.meta.url), 'utf8'));
});

test('server uses exactly eight fixed URLs and a read-only handler behind safeLocal', async () => {
  const server = await readFile(new URL('../../game_runtime/server.mjs', import.meta.url), 'utf8');
  const mapping = server.match(/const ARTWORK_LAB = new Map\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(mapping);
  assert.equal((mapping.match(/new URL\(/g) || []).length, 8);
  for (const path of paths) {
    assert.ok(mapping.includes(`['${path}', new URL('../experiments/image_parts/${path.split('/').at(-1)}', import.meta.url)]`));
  }
  const start = server.indexOf("if (rawPath.startsWith('/artwork-lab/')");
  const end = server.indexOf("if (req.method === 'GET' && path === '/favicon.ico')", start);
  const handler = server.slice(start, end);
  assert.ok(start > server.indexOf('if (!safeLocal(req, port))'));
  assert.match(handler, /req.method !== 'GET'/);
  assert.match(handler, /ARTWORK_LAB.get\(rawPath\)/);
  assert.match(handler, /await readFile\(asset\)/);
  assert.doesNotMatch(handler, /writeFile|\.save\(|getBody|predict|spawn|fetch\(|resolve\(|join\(|decodeURIComponent|base64|upload/i);
  assert.ok(server.includes(gameCsp), 'existing game CSP remains intact');
  assert.match(server, /const MAX_ARTWORK_REQUEST = 750 \* 1024;/);
});

// Raw HTTP preserves dot segments that fetch's URL parser would normalize first.
function rawGet(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(base, {path, headers}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {body += chunk;});
      res.on('end', () => resolve({status: res.statusCode, body}));
    });
    req.on('error', reject);
    req.end();
  });
}

test('ephemeral localhost game serves only the isolated workshop allowlist', async t => {
  const calls = [];
  const unexpected = label => () => {
    calls.push(label);
    throw new Error(`Unexpected game/store access: ${label}`);
  };
  const blockedStore = new Proxy({}, {get: (_, key) => unexpected(String(key))});
  const server = createGameServer({
    store: blockedStore, companionStore: blockedStore, modelShopStore: blockedStore,
    lookStore: blockedStore, artworkStore: blockedStore,
    loadSnapshot: unexpected('snapshot'), predict: unexpected('predict'),
    historicalPredict: unexpected('historical'), appearanceCatalog: unexpected('catalog'),
    appearanceImage: unexpected('image'), trainedVersions: unexpected('versions'),
    trainedVersion: unexpected('version'),
  });
  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
    assert.deepEqual(calls, [], 'no stores, saves, game APIs or Python predictors were called');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await t.test('GET all eight files returns exact source bytes and hardened headers', async () => {
    for (const path of paths) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('content-type'), path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
      assert.equal(res.headers.get('content-security-policy'), labCsp);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(Number(res.headers.get('content-length')), bytes.length);
      assert.deepEqual(bytes, await readFile(source(path)), 'includes unchanged original meta CSP');
    }
  });

  await t.test('HTML relative scripts resolve to served JS in the same lab', async () => {
    for (const name of names) {
      const page = `${base}/artwork-lab/${name}.html`;
      const html = await fetch(page).then(res => res.text());
      const relative = html.match(/<script src="([^"]+)" defer>/)?.[1];
      assert.equal(relative, `${name}.js`);
      const script = await fetch(new URL(relative, page));
      assert.equal(script.status, 200);
      assert.deepEqual(Buffer.from(await script.arrayBuffer()), await readFile(source(relative)));
    }
  });

  await t.test('/game and / expose workshop within the artwork area and retain CSP', async () => {
    for (const path of ['/game', '/']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-security-policy'), gameCsp);
      checkWorkshop(await res.text());
    }
  });

  await t.test('unknown files, images, Python and arbitrary JS return generic 404', async () => {
    for (const path of ['/artwork-lab/missing.html', '/artwork-lab/arbitrary.js',
      '/artwork-lab/server.mjs', '/artwork-lab/segment.py', '/artwork-lab/source.png',
      '/artwork-lab/', '/experiments/image_parts/annotate.js']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), {error: '見つかりません'});
    }
  });

  await t.test('raw and URL-encoded traversal never leave the exact allowlist', async () => {
    for (const path of ['/artwork-lab/../server.mjs', '/artwork-lab/../../etc/passwd',
      '/artwork-lab/%2e%2e/game', '/artwork-lab/%2e%2e/artwork-lab/annotate.html',
      '/artwork-lab/..%2fserver.mjs', '/artwork-lab/%252e%252e%252fserver.mjs',
      '/artwork-lab/%61nnotate.js', '/artwork-lab/annotate.js/extra']) {
      const res = await rawGet(base, path);
      assert.equal(res.status, 404, path);
      assert.deepEqual(JSON.parse(res.body), {error: '見つかりません'});
    }
  });

  await t.test('HEAD, POST and upload-style requests never serve or save lab files', async () => {
    for (const path of [...paths, '/artwork-lab/upload', '/artwork-lab/api/artwork']) {
      for (const method of ['HEAD', 'POST']) {
        const res = await fetch(base + path, {method,
          ...(method === 'POST' ? {headers: {'Content-Type': 'application/json'}, body: '{"slot":"hair","image":null}'} : {})});
        assert.equal(res.status, 404, `${method} ${path}`);
        if (method === 'HEAD') assert.equal(await res.text(), '');
        else assert.deepEqual(await res.json(), {error: '見つかりません'});
      }
    }
  });

  await t.test('external Origin/Host and forwarded or cross-site requests are rejected', async () => {
    // fetch may silently replace a spoofed Host with the destination authority.
    // For that scenario, raw HTTP verifies the actual header reaching the server.
    for (const headers of [{Origin: 'https://attacker.invalid'}, {Origin: 'null'},
      {'Sec-Fetch-Site': 'cross-site'}, {'X-Forwarded-For': '127.0.0.1'}]) {
      const res = await fetch(base + paths[0], {headers});
      assert.equal(res.status, 403, JSON.stringify(headers));
      await res.text();
    }
    for (const host of ['attacker.invalid',
      '127.0.0.1:' + server.address().port + '.attacker.invalid']) {
      const response = await rawGet(base, paths[0], {Host: host});
      assert.equal(response.status, 403, host);
    }
    const local = await fetch(base + paths[0], {headers: {Origin: base}});
    assert.equal(local.status, 200);
    await local.text();
  });

  await t.test('all workshop requests leave every injected store and game service untouched', () => {
    assert.deepEqual(calls, []);
  });
});
