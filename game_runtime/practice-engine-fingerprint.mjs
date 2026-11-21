import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Code-point order. Scope: prediction, settlement and model/gear resolution.
// growth.mjs provides revision state and image-validation.mjs handles imported
// images. Neither computes quick-practice predictions or settlement.
const root = new URL('../', import.meta.url);
const practiceSources = [
  'engine.py',
  'game_runtime/accessory-catalog.mjs',
  'game_runtime/accessory_analysis.py',
  'game_runtime/appearance-model.mjs',
  'game_runtime/companion.mjs',
  'game_runtime/forward-model.mjs',
  'game_runtime/imported-characters.mjs',
  'game_runtime/leverage-practice.mjs',
  'game_runtime/looks.mjs',
  'game_runtime/model-lab.mjs',
  'game_runtime/model-shop.mjs',
  'game_runtime/parts-lab/accessory-options.mjs',
  'game_runtime/practice.mjs',
  'game_runtime/predict_bridge.py',
  'game_runtime/server.mjs',
  'indicators.py',
].map(name => [name, fileURLToPath(new URL(name, root))]);

const sourceFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const maxSourceBytes = 1024 * 1024;

function sourceBuffer(stat) {
  if (!stat.isFile() || stat.size === 0 || stat.size > maxSourceBytes) throw Error('Invalid practice source file');
  // Reserve one extra byte to detect growth without an unbounded read.
  return Buffer.allocUnsafe(stat.size + 1);
}

function sourceBytes(buffer, length) {
  if (length !== buffer.length - 1) throw Error('Practice source size changed while reading');
  return buffer.subarray(0, length);
}

function readSourceSync(path) {
  if (realpathSync(path) !== path) throw Error('Unexpected practice source path');
  const fd = openSync(path, sourceFlags);
  try {
    const buffer = sourceBuffer(fstatSync(fd));
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(fd, buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return sourceBytes(buffer, length);
  } finally {
    closeSync(fd);
  }
}

async function readSource(path) {
  if (await realpath(path) !== path) throw Error('Unexpected practice source path');
  const file = await open(path, sourceFlags);
  try {
    const buffer = sourceBuffer(await file.stat());
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return sourceBytes(buffer, length);
  } finally {
    await file.close();
  }
}

function fingerprint(sources, contents) {
  const hash = createHash('sha256').update('quick-practice-engine-source-v1\0');
  for (const [index, [name]] of sources.entries()) {
    const bytes = contents[index];
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

// Alternate [name, absolute path] pairs are for isolated tests only.
// Sampled bytes cannot attest to transient edit-and-restore races, cached code,
// dependencies outside the allowlist, or the execution environment.
export function createPracticeEngineSourceGuard({sources = practiceSources} = {}) {
  const files = sources.map(([name, path]) => [name, path]);
  function captureBaseline() {
    try {
      return fingerprint(files, files.map(([, path]) => readSourceSync(path)));
    } catch {
      // Keep other routes available. Quick practice requires a valid baseline.
      return null;
    }
  }
  return Object.freeze({baseline:captureBaseline(), captureBaseline, async read() {
    return fingerprint(files, await Promise.all(files.map(([, path]) => readSource(path))));
  }});
}
