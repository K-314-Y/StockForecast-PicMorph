import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {crc32, deflateSync} from 'node:zlib';
import {extractCharacterZip} from '../../game_runtime/parts-lab/zip-import.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../scripts/export-main-character-zip.mjs', import.meta.url));
const catalogPath = '/api/character-demos';
const id = 'cp_' + 'a'.repeat(32);
const stale = 'cp_' + 'b'.repeat(32);
const name = 'ラベンダー星デモ';
const record = {generated_id:id, name, engine:'original-template', model:'test-private-model',
  equipment:[{part_id:'test-private-equipment'}]};
const parts = ['body', 'ready', 'happy', 'cautious'];
const imagePath = part => `${catalogPath}/${id}/${part}.png`;
const allPaths = [catalogPath, ...parts.map(imagePath)];

function pngChunk(type, data) {
  const label = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  label.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function atlas(shade, {width = 1152, channels = 4, extra = []} = {}) {
  const height = 208;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const stride = 1 + width * channels;
  const scanlines = Buffer.alloc(stride * height, shade);
  for (let row = 0; row < height; row++) scanlines[row * stride] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), ...extra,
    pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const images = Object.fromEntries(parts.map((part, index) => [part, atlas(40 + index * 25)]));

function send(res, type, bytes, status = 200) {
  res.writeHead(status, {'Content-Type':type});
  res.end(bytes);
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'main-character-export-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const output = join(root, 'export.zip');
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({method:req.method, url:req.url, headers:req.headers});
    if (Object.hasOwn(overrides, req.url)) return overrides[req.url](res);
    if (req.url === catalogPath) {
      return send(res, 'application/json; charset=utf-8', JSON.stringify([record]));
    }
    const part = parts.find(part => req.url === imagePath(part));
    if (part) return send(res, 'image/png', images[part]);
    return send(res, 'text/plain', 'missing', 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const port = server.address().port;
  const invoke = (...args) => run(process.execPath, [cli, '--port', String(port), ...args], {
    cwd:root, timeout:9000, env:{
      ...process.env, NODE_USE_ENV_PROXY:'1', NO_PROXY:'', no_proxy:'',
      HTTP_PROXY:'http://127.0.0.1:1', http_proxy:'http://127.0.0.1:1',
    },
  });
  const paths = () => requests.map(request => request.url);
  const exportZip = (path = output) => invoke('--id', id, '--output', path);
  return {root, output, requests, invoke, exportZip, paths};
}

function fails(promise, message) {
  return assert.rejects(promise, error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, message);
    assert.equal(error.stdout, '');
    return true;
  });
}

test('list and dry run use only the fixed GET routes and create no files', async t => {
  const {root, requests, invoke, paths} = await fixture(t);
  assert.equal((await invoke('--list')).stdout, `${id}\t${name}\n`);
  assert.deepEqual(paths(), [catalogPath]);
  const dryRun = await invoke('--id', id, '--dry-run');
  assert.match(dryRun.stdout, /ラベンダー星デモ.*素材4枚.*ドライラン/);
  assert.deepEqual(paths(), [catalogPath, ...allPaths]);
  for (const {method, headers} of requests) {
    assert.equal(method, 'GET');
    assert.match(headers.host, /^127\.0\.0\.1:\d+$/);
    for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host',
      'proxy-authorization', 'authorization', 'origin', 'cookie']) {
      assert.equal(headers[header], undefined);
    }
  }
  assert.deepEqual(await readdir(root), []);
});

test('archive has exactly five stored entries, preserves original PNGs and opens in the DEV importer', async t => {
  const originalPath = part => join(root, 'original-' + part + '.png');
  const {root, output, exportZip, paths} = await fixture(t, Object.fromEntries(
    parts.map(part => [imagePath(part), async res => send(res, 'image/png', await readFile(originalPath(part)))]),
  ));
  for (const part of parts) await writeFile(originalPath(part), images[part], {mode:0o600});
  const originals = await Promise.all(parts.map(part => stat(originalPath(part))));
  assert.match((await exportZip()).stdout, /保存完了.*素材4枚[\s\S]*ZIPインポーター.*手動/);
  assert.deepEqual(paths(), allPaths);
  const zip = await readFile(output);
  assert.ok(zip.length < 12 * 1024 * 1024);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const expected = new Map(parts.map(part => [part + '.png', images[part]]));
  expected.set('manifest.json', Buffer.from(JSON.stringify({appearance:{name}})));
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), expected.size);
  const centralOffset = zip.readUInt32LE(end + 16);
  let local = 0, central = centralOffset;
  for (const [filename, bytes] of expected) {
    const label = Buffer.from(filename);
    const dataOffset = local + 30 + label.length;
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt16LE(local + 8), 0);
    assert.equal(zip.readUInt32LE(local + 14), crc32(bytes));
    assert.equal(zip.readUInt32LE(local + 18), bytes.length);
    assert.equal(zip.readUInt16LE(local + 26), label.length);
    assert.deepEqual(zip.subarray(local + 30, dataOffset), label);
    assert.deepEqual(zip.subarray(dataOffset, dataOffset + bytes.length), bytes);
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    assert.equal(zip.readUInt32LE(central + 42), local);
    assert.deepEqual(zip.subarray(central + 46, central + 46 + label.length), label);
    central += 46 + label.length;
    local = dataOffset + bytes.length;
  }
  assert.equal(local, centralOffset);
  assert.equal(central, end);
  assert.equal(zip.includes(id), false);
  assert.equal(zip.includes(record.model), false);
  assert.equal(zip.includes(record.equipment[0].part_id), false);
  const extracted = await extractCharacterZip(new File([zip], 'export.zip', {type:'application/zip'}));
  assert.deepEqual(Object.keys(extracted), parts);
  assert.deepEqual(extracted.appearance, {name});
  for (const [index, part] of parts.entries()) {
    const original = originalPath(part);
    assert.equal(extracted[part].name, part + '.png');
    assert.equal(extracted[part].type, 'image/png');
    assert.deepEqual(Buffer.from(await extracted[part].arrayBuffer()), images[part]);
    assert.deepEqual(await readFile(original), images[part]);
    const after = await stat(original);
    for (const field of ['ino', 'mode', 'mtimeMs', 'ctimeMs']) {
      assert.equal(after[field], originals[index][field]);
    }
  }
  assert.deepEqual((await readdir(root)).sort(), ['export.zip', ...parts.map(part => 'original-' + part + '.png')].sort());
});

test('invalid CLI options make no requests, and a stale ID stops after the catalog', async t => {
  const {root, invoke, paths} = await fixture(t);
  for (const args of [
    ['--list', '--dry-run'], ['--list', '--list'], ['--list', '--url', 'http://example.com'],
    ['--list', '--port', '65536'], ['--id', id + '/body.png', '--dry-run'],
    ['--id', id.toUpperCase(), '--dry-run'], ['--id', id, '--output', 'test.zip', '--dry-run'],
  ]) {
    await fails(invoke(...args), /エクスポート失敗/);
  }
  assert.deepEqual(paths(), []);
  await fails(invoke('--id', stale, '--output', 'stale.zip'), /IDがMAINのカタログにありません/);
  assert.deepEqual(paths(), [catalogPath]);
  assert.deepEqual(await readdir(root), []);
});

const catalogCases = [
  ['invalid JSON', '{', /UTF-8のJSON/],
  ['invalid UTF-8', Buffer.from([0xff]), /UTF-8のJSON/],
  ['object instead of array', '{}', /一覧の形式が不正/],
  ['duplicate ID', JSON.stringify([record, record]), /重複/],
  ['malformed catalog ID', JSON.stringify([{...record, generated_id:id.toUpperCase()}]), /情報が不正/],
  ['unsupported engine', JSON.stringify([{...record, engine:'unknown'}]), /情報が不正/],
  ['missing model', JSON.stringify([{...record, model:undefined}]), /情報が不正/],
  ['oversize name', JSON.stringify([{...record, name:'長'.repeat(17)}]), /情報が不正/],
  ['control character in name', JSON.stringify([{...record, name:name + '\x1b'}]), /情報が不正/],
];
for (const [label, body, error] of catalogCases) {
  test(`rejects catalog: ${label}`, async t => {
    const {root, exportZip, paths} = await fixture(t, {
      [catalogPath]:res => send(res, 'application/json', body),
    });
    await fails(exportZip(), error);
    assert.deepEqual(paths(), [catalogPath]);
    assert.deepEqual(await readdir(root), []);
  });
}

test('rejects a redirect without following it', async t => {
  const {root, exportZip, paths} = await fixture(t, {
    [imagePath('ready')]:res => {
      res.writeHead(302, {Location:'/redirect-target'});
      res.end();
    },
  });
  await fails(exportZip(), /ready\.png: HTTP 302/);
  assert.deepEqual(paths(), allPaths.slice(0, 3));
  assert.deepEqual(await readdir(root), []);
});

const badCrc = Buffer.from(images.ready);
badCrc[badCrc.length - 1] ^= 1;
const imageCases = [
  ['non-200 status', res => send(res, 'image/png', '', 404), /ready\.png: HTTP 404/],
  ['wrong MIME', res => send(res, 'text/plain', images.ready), /Content-Type.*image\/png/],
  ['bad CRC', res => send(res, 'image/png', badCrc), /破損/],
  ['truncated image', res => send(res, 'image/png', images.ready.subarray(0, -12)), /破損/],
  ['wrong dimensions', res => send(res, 'image/png', atlas(90, {width:1146})), /1152×208/],
  ['RGB instead of RGBA', res => send(res, 'image/png', atlas(90, {channels:3})), /RGBA/],
  ['embedded model metadata', res => send(res, 'image/png',
    atlas(90, {extra:[pngChunk('tEXt', Buffer.from('model\0private'))]})), /未対応のチャンク/],
];
for (const [label, respond, error] of imageCases) {
  test(`rejects image: ${label}`, async t => {
    const {root, exportZip} = await fixture(t, {[imagePath('ready')]:respond});
    await fails(exportZip(), error);
    assert.deepEqual(await readdir(root), []);
  });
}

test('checks declared and streaming response sizes for both resource limits', async t => {
  const chunked = (type, max) => res => {
    res.writeHead(200, {'Content-Type':type});
    res.write(Buffer.alloc(max));
    res.end(Buffer.from([0]));
  };
  const declared = (type, max) => res => {
    res.writeHead(200, {'Content-Type':type, 'Content-Length':max + 1});
    res.flushHeaders();
  };
  for (const [path, type, limit] of [
    [catalogPath, 'application/json', 64], [imagePath('ready'), 'image/png', 512],
  ]) {
    for (const response of [chunked, declared]) {
      const {root, exportZip} = await fixture(t, {[path]:response(type, limit * 1024)});
      await fails(exportZip(), new RegExp(`${limit} KiBを超えています`));
      assert.deepEqual(await readdir(root), []);
    }
  }
});

test('request deadline includes the response body', {timeout:12000}, async t => {
  const {root, exportZip} = await fixture(t, {
    [imagePath('ready')]:res => {
      res.writeHead(200, {'Content-Type':'image/png'});
      res.write(images.ready.subarray(0, 8));
    },
  });
  await fails(exportZip(), /ready\.png:.*タイムアウト/);
  assert.deepEqual(await readdir(root), []);
});

test('refuses existing and symlink destinations and creates no parent directories', async t => {
  const {root, output, exportZip} = await fixture(t);
  const dangling = join(root, 'dangling.zip');
  const alias = join(root, 'alias');
  await writeFile(output, 'original');
  await symlink('absent.zip', dangling);
  await symlink('.', alias);
  await mkdir(join(root, 'local_state'));
  await fails(exportZip(), /既に|存在します/);
  await fails(exportZip(dangling), /存在します/);
  await fails(exportZip(join(root, 'missing', 'new.zip')), /保存できません/);
  await fails(exportZip(join(alias, 'new.zip')), /保存できません|シンボリックリンク/);
  await fails(exportZip(join(root, 'local_state', 'new.zip')), /local_stateの外/);
  assert.equal(await readFile(output, 'utf8'), 'original');
  assert.equal(await readlink(dangling), 'absent.zip');
  assert.deepEqual(await readdir(join(root, 'local_state')), []);
  assert.deepEqual((await readdir(root)).sort(), ['alias', 'dangling.zip', 'export.zip', 'local_state']);
});

test('concurrent exports to one path publish one complete ZIP', async t => {
  const {root, output, exportZip} = await fixture(t);
  const results = await Promise.allSettled([exportZip(), exportZip()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 1);
  assert.match(rejected.reason.stderr, /存在します/);
  assert.deepEqual(await readdir(root), ['export.zip']);
  const extracted = await extractCharacterZip(new File([await readFile(output)], 'export.zip'));
  assert.deepEqual(extracted.appearance, {name});
});
