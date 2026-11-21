import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPracticeEngineSourceGuard} from '../../game_runtime/practice-engine-fingerprint.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'practice-engine-fingerprint-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  return dir;
}

test('P9t default source list is in code-point order', async () => {
  const moduleUrl = new URL('../../game_runtime/practice-engine-fingerprint.mjs', import.meta.url);
  const contents = await readFile(moduleUrl, 'utf8');
  const [, list] = contents.match(/const practiceSources = \[([^\]]+)\]/) ?? [];
  assert.ok(list);
  const names = Array.from(list.matchAll(/'([^']+)'/g), ([, name]) => name);
  const sortedNames = [...new Set(names)].sort();
  assert.equal(sortedNames.length, 16);
  assert.deepEqual(names, sortedNames);
});

test('P9t hashes the version, ordered names, byte lengths and raw bytes', async t => {
  const dir = await temp(t);
  const first = join(dir, 'first.py'), second = join(dir, 'second.mjs');
  const sources = [['engine.py', first], ['game_runtime/practice.mjs', second]];
  const binary = Buffer.from([0xff, 0x00, 0xc3, 0xa9]);
  await Promise.all([writeFile(first, binary), writeFile(second, 'same')]);
  const guard = createPracticeEngineSourceGuard({sources});
  const expected = createHash('sha256').update('quick-practice-engine-source-v1\0')
    .update('engine.py\0' + '4\0').update(binary)
    .update('game_runtime/practice.mjs\0' + '4\0').update('same').digest('hex');
  assert.equal(guard.baseline, expected);
  assert.equal(guard.captureBaseline(), expected);
  assert.equal(await guard.read(), expected);
  assert.notEqual(createPracticeEngineSourceGuard({sources:[...sources].reverse()}).baseline, expected);
  assert.notEqual(createPracticeEngineSourceGuard({sources:[['other.py', first], sources[1]]}).baseline, expected);
  await writeFile(first, Buffer.from([0xfe, ...binary.subarray(1)]));
  assert.notEqual(await guard.read(), expected, 'a same-length byte edit changes the hash');
  assert.equal(guard.baseline, expected);
});

test('P9t source reads reject missing, empty, oversized, symlink and non-regular files', async t => {
  const dir = await temp(t);
  const regular = join(dir, 'regular'), oversized = join(dir, 'oversized');
  const link = join(dir, 'link'), directory = join(dir, 'directory');
  const linkedDirectory = join(dir, 'linked-directory'), fifo = join(dir, 'fifo');
  const empty = join(dir, 'empty');
  await Promise.all([writeFile(regular, 'x'), writeFile(oversized, 'x'), writeFile(empty, ''), mkdir(directory)]);
  await Promise.all([truncate(oversized, 1024 * 1024 + 1), symlink(regular, link),
    symlink(directory, linkedDirectory), writeFile(join(directory, 'file'), 'x')]);
  execFileSync('mkfifo', [fifo]);
  for (const file of [join(dir, 'missing'), empty, oversized, link, directory, join(linkedDirectory, 'file'), fifo]) {
    const guard = createPracticeEngineSourceGuard({sources:[['engine.py', file]]});
    assert.equal(guard.baseline, null, file);
    await assert.rejects(guard.read(), undefined, file);
  }
});
