import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createArtworkStore} from '../../game_runtime/artwork.mjs';
import {createCompanionStore} from '../../game_runtime/companion.mjs';
import {createLookStore} from '../../game_runtime/looks.mjs';
import {createGrowthStore} from '../../game_runtime/growth.mjs';
import {createModelShopStore} from '../../game_runtime/model-shop.mjs';

// Known valid synthetic 1x1 PNG; deliberately shared by all four slots.
const image = {mime:'image/png', base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9F7pSAAAAABJRU5ErkJggg=='};
const slots = ['base', 'outfit', 'face', 'hair'];
const companion = {name:'再起動の相棒', hair_color:'#abcdef', clothing_color:'#fedcba',
  approach:'reversion', risk_percent:45};

test('saved four-layer artwork and named companion survive fresh server/store instances', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'saved-character-restart-'));
  let server;
  const close = async () => {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  t.after(async () => {
    try { await close(); }
    finally { await rm(dir, {recursive:true, force:true}); }
  });
  const start = async () => {
    // Every lifetime gets new stores, with exactly the same private paths.
    server = createGameServer({
      artworkStore:createArtworkStore({file:join(dir, 'artwork.json')}),
      companionStore:createCompanionStore({file:join(dir, 'companion.json')}),
      lookStore:createLookStore({file:join(dir, 'looks.json')}),
      store:createGrowthStore({file:join(dir, 'growth.json'), legacyFile:join(dir, 'legacy.json')}),
      modelShopStore:createModelShopStore({file:join(dir, 'model-shop.json')}),
      loadSnapshot:async () => { throw new Error('This test must not access market/model data'); },
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return 'http://127.0.0.1:' + server.address().port;
  };
  const get = async (url, path) => {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = (url, path, body) => fetch(url + path, {method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const disk = async () => Promise.all((await readdir(dir)).sort().map(async name => {
    const file = join(dir, name);
    return {name, bytes:await readFile(file), mtimeMs:(await stat(file)).mtimeMs};
  }));
  const checkImages = async url => {
    for (const slot of slots) {
      const response = await fetch(url + '/api/artwork/image/' + slot);
      assert.equal(response.status, 200, slot);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(image.base64, 'base64'), slot);
    }
  };

  let url = await start();
  for (const path of ['/api/artwork', '/api/companion']) {
    const initial = await get(url, path);
    assert.equal(initial.revision, 0);
    assert.equal(initial.created, false);
  }
  assert.deepEqual(await readdir(dir), [], 'initial reads must not create state files');
  for (const [expected_revision, slot] of slots.entries()) {
    const response = await post(url, '/api/artwork', {expected_revision, slot, image});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revision, expected_revision + 1);
  }
  const saved = await post(url, '/api/companion', {expected_revision:0, companion});
  assert.equal(saved.status, 200);
  const savedCompanion = await saved.json();
  assert.equal(savedCompanion.revision, 1);
  assert.deepEqual(savedCompanion.companion, companion);
  const beforeReads = await disk();
  const savedArtwork = await get(url, '/api/artwork');
  assert.equal(savedArtwork.revision, 4);
  assert.equal(savedArtwork.created, true);
  for (const slot of slots) assert.equal(savedArtwork.slots[slot].exists, true);
  await checkImages(url);
  assert.deepEqual(await get(url, '/api/companion'), savedCompanion);
  assert.deepEqual(await disk(), beforeReads, 'GET must not rewrite state');
  assert.deepEqual(beforeReads.map(file => file.name), ['artwork.json', 'companion.json']);

  await close();
  url = await start();
  assert.deepEqual(await get(url, '/api/artwork'), savedArtwork);
  assert.deepEqual(await get(url, '/api/companion'), savedCompanion);
  await checkImages(url);
  for (const [path, body] of [
    ['/api/artwork', {expected_revision:3, slot:'base', image:null}],
    ['/api/companion', {expected_revision:0, companion:{...companion, name:'古い変更'}}],
  ]) {
    const response = await post(url, path, body);
    assert.equal(response.status, 409);
    await response.text();
  }
  assert.deepEqual(await get(url, '/api/artwork'), savedArtwork);
  assert.deepEqual(await get(url, '/api/companion'), savedCompanion);
  assert.deepEqual(await disk(), beforeReads, 'fresh instances, GET and stale writes must preserve disk state');
});
