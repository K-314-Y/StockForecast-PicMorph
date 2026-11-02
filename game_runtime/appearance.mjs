/** A read-only, fixed-upstream, local-only bridge for saved DRAFT artwork. */
const ORIGIN = 'http://127.0.0.1:8884';
const DRAFT_ID = /^bp_[a-f0-9]{32}$/;
const TYPES = new Set(['image/png','image/jpeg','image/webp']);
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;

function fail(message, status = 503) {
  return Object.assign(new Error(message), {status});
}
async function upstream(path, maxBytes) {
  const response = await fetch(ORIGIN + path, {
    redirect: 'error', signal: AbortSignal.timeout(2500),
    headers: {'Accept': path.endsWith('/image') ? 'image/png,image/jpeg,image/webp' : 'application/json'},
  });
  if (response.status === 404) throw fail('イラストが見つかりません',404);
  if (!response.ok) throw fail('キャラ制作サーバーを読み取れません');
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) throw fail('画像または一覧が大きすぎます',413);
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.byteLength;
    if (size > maxBytes) throw fail('画像または一覧が大きすぎます',413);
    parts.push(Buffer.from(part));
  }
  return {response,bytes:Buffer.concat(parts,size)};
}
export function sanitizeDrafts(json) {
  if (!json || !Array.isArray(json.drafts) || json.drafts.length > 50) {
    throw fail('キャラ一覧が不正です');
  }
  const seen = new Set(), result = [];
  for (const draft of json.drafts) {
    if (!DRAFT_ID.test(draft?.id) || seen.has(draft.id) ||
        draft?.status !== 'draft' || typeof draft?.user_declared?.name !== 'string' ||
        !draft.user_declared.name.trim() || draft.user_declared.name.length > 60) {
      throw fail('キャラ一覧の内容が不正です');
    }
    seen.add(draft.id);
    const asset = draft.visual_asset;
    const has_image = asset != null && TYPES.has(asset.media_type) &&
      Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= MAX_IMAGE_BYTES;
    result.push({id:draft.id,name:draft.user_declared.name,has_image});
  }
  return {drafts:result, notice:'外見のみ。未学習DRAFTは予測に使用されません。'};
}
export async function readAppearanceCatalog() {
  const {bytes} = await upstream('/api/blueprints',MAX_LIST_BYTES);
  let data;
  try {data=JSON.parse(bytes.toString('utf8'));}catch {throw fail('キャラ一覧のJSONが不正です');}
  return sanitizeDrafts(data);
}
export async function readAppearanceImage(id, catalogLoader=readAppearanceCatalog) {
  if (typeof id !== 'string' || !DRAFT_ID.test(id)) throw fail('キャラIDが不正です',404);
  const catalog = await catalogLoader();
  if (!catalog.drafts.some(draft => draft.id === id && draft.has_image)) {
    throw fail('イラストが見つかりません',404);
  }
  const {response,bytes} = await upstream('/api/blueprints/'+id+'/image',MAX_IMAGE_BYTES);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!TYPES.has(mime)) throw fail('イラスト形式が不正です');
  const signatureOk = mime === 'image/png'
    ? bytes.length>=8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/jpeg'
    ? bytes.length>=4 && bytes[0]===255 && bytes[1]===216 && bytes.at(-2)===255 && bytes.at(-1)===217
    : bytes.length>=16 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
  if (!signatureOk) throw fail('画像の内容が不正です');
  return {mime,bytes};
}
export const isValidAppearanceId = id => DRAFT_ID.test(id);
