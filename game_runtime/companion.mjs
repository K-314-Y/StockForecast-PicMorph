/** Node-only, single-process companion store. No external-user authentication. */
import {readFile, mkdir, open, rename, unlink, lstat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export const COMPANION_FILE = fileURLToPath(new URL('../local_state/node_game/companion.json', import.meta.url));
export const APPROACHES = Object.freeze(['trend', 'momentum', 'reversion', 'volatility']);
const DEFAULT = Object.freeze({name:'私の相棒', hair_color:'#8882db', clothing_color:'#92e1d4', approach:'trend', risk_percent:35});
const queues = new Map();
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const keys = value => Object.keys(value).sort().join('|');
const fields = 'approach|clothing_color|hair_color|name|risk_percent';

export function normalizeCompanionColor(value) {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) throw fail('色は #rrggbb 形式です');
  return value.toLowerCase();
}

export function validateCompanion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys(value) !== fields) {
    throw fail('相棒の名前・髪色・服色・予測方法・リスクを指定してください');
  }
  if (typeof value.name !== 'string' || !value.name.trim() ||
      [...value.name].length > 16 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.name)) {
    throw fail('名前は1〜16文字で指定してください（制御文字は使用不可）');
  }
  const hair_color = normalizeCompanionColor(value.hair_color);
  const clothing_color = normalizeCompanionColor(value.clothing_color);
  if (!APPROACHES.includes(value.approach)) throw fail('予測方法が不正です');
  if (!Number.isInteger(value.risk_percent) || value.risk_percent < 5 ||
      value.risk_percent > 100 || value.risk_percent % 5 !== 0) throw fail('リスクは5〜100%を5刻みで指定してください');
  return {...value, hair_color, clothing_color};
}

export function createCompanionStore({file=COMPANION_FILE}={}) {
  file = resolve(file);
  async function read() {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('invalid file');
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (!record || keys(record) !== 'companion|revision|schema' || record.schema !== 1 ||
          !Number.isSafeInteger(record.revision) || record.revision < 1) throw Error('invalid record');
      return {revision:record.revision, created:true, companion:validateCompanion(record.companion)};
    } catch (error) {
      if (error.code === 'ENOENT') return {revision:0, created:false, companion:{...DEFAULT}};
      throw fail('相棒の保存情報を読み取れません',503);
    }
  }
  async function write(record) {
    const dir = dirname(file);
    await mkdir(dir, {recursive:true, mode:0o700});
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('相棒の保存先が不正です',503);
    const tmp = join(dir, '.companion-' + randomUUID());
    let handle;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record) + '\n');
      await handle.sync();
      await handle.close(); handle = null;
      await rename(tmp, file);
      const directory = await open(dir, 'r');
      try {await directory.sync();} finally {await directory.close();}
    } finally {
      if (handle) await handle.close();
      await unlink(tmp).catch(error => {if (error.code !== 'ENOENT') throw error;});
    }
  }
  return {
    read,
    save(payload) {
      const task = async () => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            keys(payload) !== 'companion|expected_revision' ||
            !Number.isSafeInteger(payload.expected_revision) || payload.expected_revision < 0) {
          throw fail('expected_revision と companion が必要です');
        }
        const companion = validateCompanion(payload.companion);
        const current = await read();
        if (current.revision !== payload.expected_revision || current.revision >= Number.MAX_SAFE_INTEGER) {
          throw fail('相棒が更新されています。再取得してから保存してください',409);
        }
        const revision = current.revision + 1;
        await write({schema:1, revision, companion});
        return {revision, created:true, companion};
      };
      const result = (queues.get(file) ?? Promise.resolve()).then(task);
      const pending = result.catch(()=>{});
      queues.set(file, pending);
      pending.then(()=>{if (queues.get(file) === pending) queues.delete(file);});
      return result;
    },
  };
}

export function applyCompanion(plan, saved) {
  if (!saved.created) return plan;
  const {approach, risk_percent} = saved.companion;
  return {...plan, models:{...plan.models, mine:{...plan.models.mine,
    plugin_weights:Object.fromEntries(APPROACHES.map(key=>[key,key === approach ? 100 : 0])),
    risk_fraction:risk_percent / 100,
  }}};
}
