import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link, open, realpath, unlink} from 'node:fs/promises';
import {get} from 'node:http';
import {basename, dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {crc32} from 'node:zlib';
import {validatedImageDimensions} from '../game_runtime/image-validation.mjs';

const API = '/api/character-demos';
const DEFAULT_PORT = 8890;
const TIMEOUT_MS = 5_000;
const MAX_CATALOG_BYTES = 64 * 1024;
const MAX_PNG_BYTES = 512 * 1024;
const WIDTH = 1152, HEIGHT = 208;
const PARTS = ['body', 'ready', 'happy', 'cautious'];
const ENGINES = ['original-template', 'user-png'];
const UNSAFE_TEXT = /[\p{Cc}\p{Cs}\p{Bidi_Control}\u2028\u2029]/u;
const PNG_VISUAL_CHUNKS = new Map([
  ['cHRM', 32], ['gAMA', 4], ['pHYs', 9], ['sBIT', 4], ['sRGB', 1],
]);
const HELP = `使い方:
  node scripts/export-main-character-zip.mjs --list
  node scripts/export-main-character-zip.mjs --id cp_… --dry-run
  node scripts/export-main-character-zip.mjs --id cp_… --output /保存先/キャラ.zip

MAIN (127.0.0.1:8890) から外見素材4枚と名前を取得します。
ZIPの保存後、DEVのZIPインポーターで開き、手動で登録してください。
--port で接続先ポートを変更できます（分離したテスト用）。`;

function validId(id) {
  return typeof id === 'string' && id.length === 35 && /^cp_[0-9a-f]{32}$/.test(id);
}

function validName(name) {
  return typeof name === 'string' && name.length <= 16 && name.trim() && !UNSAFE_TEXT.test(name);
}

export function parseCatalog(bytes) {
  if (bytes.length > MAX_CATALOG_BYTES) throw new Error('キャラ一覧が64 KiBを超えています。');
  let catalog;
  try {
    catalog = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  } catch {
    throw new Error('キャラ一覧はUTF-8のJSONである必要があります。');
  }
  if (!Array.isArray(catalog)) throw new Error('キャラ一覧の形式が不正です。');
  const ids = new Set();
  return catalog.map((item, index) => {
    const {generated_id:id, name, engine, model} = item ?? {};
    if (!validId(id) || !validName(name) || !ENGINES.includes(engine) ||
        typeof model !== 'string' || !model.trim() || UNSAFE_TEXT.test(model) || ids.has(id)) {
      throw new Error(`キャラ一覧の${index + 1}件目の情報が不正か、IDが重複しています。`);
    }
    ids.add(id);
    return {id, name};
  });
}

export function validAtlas(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > MAX_PNG_BYTES ||
      bytes[24] !== 8 || bytes[25] !== 6) return false;
  const size = validatedImageDimensions(bytes, 'image/png', {
    maxWidth:WIDTH, maxHeight:HEIGHT, staticOnly:true,
  });
  if (size?.width !== WIDTH || size.height !== HEIGHT) return false;
  // Keep the source PNG intact and exclude ancillary payloads such as text, EXIF and profiles.
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!['IHDR', 'IDAT', 'IEND', 'PLTE'].includes(type) &&
        PNG_VISUAL_CHUNKS.get(type) !== length) return false;
    offset += 12 + length;
  }
  return true;
}

export function buildCharacterZip(name, images) {
  if (!validName(name)) throw new Error('キャラ名が不正です。');
  const entries = PARTS.map(part => {
    const bytes = images[part];
    if (!validAtlas(bytes)) {
      throw new Error(`${part}.png: 1152×208のRGBA PNGが必要です。破損や未対応のチャンクも確認してください。`);
    }
    return [`${part}.png`, bytes];
  });
  entries.push(['manifest.json', Buffer.from(JSON.stringify({appearance:{name}}))]);
  const locals = [], central = [];
  let offset = 0;
  for (const [filename, bytes] of entries) {
    const label = Buffer.from(filename);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // ZIP 1.0, stored method.
    local.writeUInt16LE(33, 12); // 1980-01-01 (DOS date).
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(label.length, 26);
    locals.push(local, label, bytes);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(10, 4);
    local.copy(header, 6, 4, 30);
    header.writeUInt32LE(offset, 42);
    central.push(header, label);
    offset += local.length + label.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function readBytes(port, path, mime, maxBytes, label) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      // A fresh HTTP connection bypasses global proxy agents. HTTP requests do not follow redirects.
      get({hostname:'127.0.0.1', port, path, agent:false, signal}, resolve).once('error', reject);
    });
  } catch {
    throw new Error(`${label}: MAINの127.0.0.1:${port}に接続できないか、応答がタイムアウトしました。`);
  }
  try {
    if (response.statusCode !== 200) throw new Error(`${label}: HTTP ${response.statusCode}。`);
    const type = response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    if (type !== mime) throw new Error(`${label}: Content-Typeは${mime}である必要があります。`);
    if (!['identity', undefined].includes(response.headers['content-encoding'])) {
      throw new Error(`${label}: HTTPの圧縮応答には対応していません。`);
    }
    const limitError = `${label}: 応答が${maxBytes / 1024} KiBを超えています。`;
    const length = response.headers['content-length'];
    if (length !== undefined && Number(length) > maxBytes) throw new Error(limitError);
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of response) {
        total += chunk.length;
        if (total > maxBytes) break;
        chunks.push(chunk);
      }
    } catch {
      throw new Error(`${label}: 応答の読み取りが中断されたか、タイムアウトしました。`);
    }
    if (total > maxBytes) throw new Error(limitError);
    if (!response.complete || (length !== undefined && total !== Number(length))) {
      throw new Error(`${label}: 応答の長さが不正です。`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    response.destroy();
  }
}

async function saveZip(output, bytes) {
  const destination = resolve(output);
  const parent = dirname(destination);
  if (parent.split('/').includes('local_state')) {
    throw new Error('local_stateの外に保存してください。');
  }
  // Anchor both paths to the same Linux directory even if its name is replaced.
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const anchor = `/proc/self/fd/${directory.fd}`;
    if (await realpath(anchor) !== parent) {
      throw new Error('保存先の親フォルダーはシンボリックリンクを含まないパスで指定してください。');
    }
    const staged = `${anchor}/.creature-export-${randomUUID()}.tmp`;
    const file = await open(staged, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      // A hard link publishes the finished bytes in one step and fails if the name exists.
      await link(staged, `${anchor}/${basename(destination)}`);
    } finally {
      await unlink(staged);
    }
  } finally {
    await directory.close();
  }
}

function command(args) {
  let options;
  try {
    options = parseArgs({args, tokens:true, options:{
      help:{type:'boolean'}, list:{type:'boolean'}, id:{type:'string'},
      'dry-run':{type:'boolean'}, output:{type:'string'}, port:{type:'string'},
    }});
  } catch {
    throw new Error('引数を確認してください。使い方は --help で表示できます。');
  }
  const {values, tokens} = options;
  if (tokens.length !== Object.keys(values).length) throw new Error('引数が重複しています。');
  if (values.help && tokens.length === 1) return {help:true};
  const {list, id, 'dry-run':dryRun, output, port:portArg} = values;
  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg);
  if (portArg !== undefined && (!/^\d+$/.test(portArg) || port < 1 || port > 65535)) {
    throw new Error('--port は1〜65535の整数で指定してください。');
  }
  if (values.help || (list ? id !== undefined || dryRun || output !== undefined :
    !validId(id) || Boolean(dryRun) === (output !== undefined))) {
    throw new Error('--list、--id と --dry-run、または --id と --output を指定してください。');
  }
  if (output !== undefined && (!output.trim() || output.endsWith('/') || UNSAFE_TEXT.test(output))) {
    throw new Error('--output には新しいZIPファイルのパスを指定してください。');
  }
  return {list, id, dryRun, output, port};
}

async function run(args) {
  const {help, list, id, dryRun, output, port} = command(args);
  if (help) return console.log(HELP);
  const catalog = parseCatalog(await readBytes(port, API, 'application/json', MAX_CATALOG_BYTES, 'キャラ一覧'));
  if (list) {
    for (const entry of catalog) console.log(`${entry.id}\t${entry.name}`);
    if (!catalog.length) console.log('MAINのカタログにキャラがありません。');
    return;
  }
  const character = catalog.find(entry => entry.id === id);
  if (!character) throw new Error('指定したIDがMAINのカタログにありません。--list で確認してください。');
  const images = {};
  // MAIN limits concurrent image requests and rechecks its saved source for each GET.
  for (const part of PARTS) {
    const filename = `${part}.png`;
    images[part] = await readBytes(port, `${API}/${id}/${filename}`, 'image/png', MAX_PNG_BYTES, filename);
  }
  const zip = buildCharacterZip(character.name, images);
  const details = `「${character.name}」の外見素材4枚と名前（ZIP ${zip.length} バイト）`;
  if (dryRun) return console.log(`確認完了: ${details}。ドライランのためファイルは作成していません。`);
  try {
    await saveZip(output, zip);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('保存先にファイルが存在します。新しいファイル名を指定してください。');
    if (error.code) throw new Error(`ZIPを保存できませんでした（${error.code}）。既存の保存フォルダーを確認してください。`);
    throw error;
  }
  console.log(`保存完了: ${details}\n${resolve(output)}\nDEVのZIPインポーターで開き、手動で登録してください。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(`エクスポート失敗: ${error.message}`);
    process.exitCode = 1;
  }
}
