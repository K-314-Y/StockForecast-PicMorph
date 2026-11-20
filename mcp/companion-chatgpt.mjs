/**
 * Small, private ChatGPT MCP adapter for the Node-owned Creature Lab companion.
 *
 * ChatGPT -> private MCP -> Node 8890 -> node_game/companion.json
 * Does NOT expose the legacy Python 8765 MCP mutation tools, stock V6, XP
 * rewards, arbitrary filesystem access, trade APIs, or arbitrary HTTP destinations.
 * Authentication is supplied by a future Secure MCP Tunnel / private transport.
 * NEVER expose this listener using a public forwarding URL without auth.
 */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {validateArtworkImage,MAX_ARTWORK_FILE} from '../game_runtime/artwork.mjs';

export const CHATGPT_MCP_PORT = 8896;
export const CHATGPT_READ_ONLY_MCP_PORT = 8897;
const READ_ONLY_TOOLS = new Set([
  'get_my_character_sheet','get_my_companion','get_my_look','get_my_artwork',
  'get_my_creature_growth','list_my_trained_brains',
]);
const API = 'http://127.0.0.1:8890';
const MAX_REQUEST_BYTES = 8192;
const MAX_RESPONSE_BYTES = 65536;
const ARTWORK_READER_LIMIT = MAX_ARTWORK_FILE + 2048;
const approaches = ['trend','momentum','reversion','volatility'];
const modelLabels = {trend:'流れ',momentum:'勢い',reversion:'反転',volatility:'値動きの大きさ'};
const draftSchema = z.object({
  name:z.string().min(1).max(16),
  hair_color:z.string().regex(/^#[a-fA-F0-9]{6}$/),
  clothing_color:z.string().regex(/^#[a-fA-F0-9]{6}$/),
  approach:z.enum(approaches),
  risk_percent:z.number().int().min(5).max(100).multipleOf(5),
}).strict();
const pct = z.number().int().min(0).max(100);
const trainedId = /^tv_[0-9a-f]{32}$/;
const lookSchema=z.object({
  hair_style:z.enum(['bob','long','twintails']),
  expression:z.enum(['cheerful','calm','determined']),
  accessory:z.enum(['ribbon','glasses','star','none']),
}).strict();

const partsHelper = fileURLToPath(new URL('./character_parts.py', import.meta.url));
const segmentationHelper = fileURLToPath(new URL('./artwork_segment.py', import.meta.url));
const generatedIdSchema = z.object({
  generated_id:z.string().length(35).regex(/^cp_[0-9a-f]{32}$/),
}).strict();
const appearanceSchema = z.object({
  name:z.string().min(1).max(16).regex(/^[^\p{Cc}]+$/u).refine(name=>name.trim().length>0),
  hair_color:z.string().length(7).regex(/^#[a-fA-F0-9]{6}$/),
  clothing_color:z.string().length(7).regex(/^#[a-fA-F0-9]{6}$/),
  accessory:z.enum(['none','ribbon','glasses','star']).default('none'),
  seed:z.number().int().min(0).max(65535).default(0),
}).strict();
const segmentSourceSchema=z.object({
  generated_id:z.string().regex(/^cp_[0-9a-f]{32}$/),
  source_part:z.enum(['body','ready','happy','cautious']),
}).strict();
const segmentationSchema=segmentSourceSchema.extend({
  part_type:z.enum(['eyes','mouth','eyebrows','cheeks','hair','outfit',
    'ribbon','glasses','hat','earrings','accessory']),
  frame:z.number().int().min(0).max(5).default(0),
  seeds:z.array(z.object({
    x:z.number().int().min(0).max(191),
    y:z.number().int().min(0).max(207),
  }).strict()).min(1).max(6),
  tolerance:z.number().int().min(0).max(64).default(24),
}).strict();
const confirmSegmentationSchema=segmentationSchema.extend({
  expected_sha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const localWrite = {readOnlyHint:false,destructiveHint:false,openWorldHint:false};
let partsBusy = false;

function runPartsHelper(operation,input,signal) {
  return new Promise((resolve,reject)=>{
    let outcome;
    const child=execFile('python3',['-B','-E',partsHelper,operation],{
      env:{PATH:process.env.PATH ?? '/usr/bin:/bin',LANG:'C.UTF-8'},
      signal,timeout:10000,maxBuffer:16384,killSignal:'SIGKILL',
    },(error,stdout)=>{outcome={error,stdout};});
    // execFile may report cancellation before the child has exited and released the lock.
    child.once('close',()=>{
      if(outcome.error) reject(outcome.error);
      else resolve(outcome.stdout);
    });
    child.stdin.on('error',()=>child.kill('SIGKILL'));
    child.stdin.end(JSON.stringify(input)+'\n','utf8');
  });
}

async function characterParts(operation, input, signal, message) {
  if(partsBusy) return partsError('Character parts generation or packaging is busy. Try again.');
  partsBusy = true;
  try {
    const stdout = await runPartsHelper(operation,input,signal);
    const {result,error} = JSON.parse(stdout);
    if(error) return partsError(error);
    const localDirectory = 'local_state/character_parts/'+result.generated_id;
    return {
      content:[{type:'text',text:message(localDirectory)}],
      structuredContent:{...result,local_directory:localDirectory},
    };
  } catch(error) {
    if(signal?.aborted) return partsError('Character parts request was cancelled.');
    return partsError(error.code==='ENOENT'
      ? 'Python 3 is required for local character parts.'
      : 'The local character parts helper failed or timed out.');
  } finally {
    partsBusy = false;
  }
}

const MAX_CATALOG_IMAGE=512*1024;
const MAX_SEGMENT_RESPONSE=750000;
const MAX_SEGMENT_REVIEWS=32;
const NEURAL_SEGMENT_METHOD='efficientsam-onnx-cpu';
const COLOR_SEGMENT_METHOD='ai-guided-color-region';
let segmentationBusy=false;

// The source path is entirely fixed except for strictly validated catalog ID
// and part role. The game verifies ALL four original PNG files by SHA-256.
async function localCharacterAtlas(apiBase,{generated_id,source_part}) {
  const url=apiBase+'/api/character-demos/'+generated_id+'/'+source_part+'.png';
  const response=await fetch(url,{
    method:'GET',headers:{Accept:'image/png'},redirect:'error',
    signal:AbortSignal.timeout(4500),
  });
  if(!response.ok)throw Error(response.status===404 ?
    'この登録キャラはありません。Linuxの登録済みキャラを確認してください。' :
    'PNG画像を取得できません: '+response.status);
  if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='image/png')
    throw Error('PNG以外の画像を受信しました');
  const length=response.headers.get('content-length');
  if(length!==null && (!/^\d+$/.test(length) || Number(length)>MAX_CATALOG_IMAGE)) {
    await response.body?.cancel();
    throw Error('画像サイズが上限を超えました');
  }
  const reader=response.body?.getReader();
  if(!reader)throw Error('画像データを読み込めません');
  let size=0;
  const parts=[];
  try {
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>MAX_CATALOG_IMAGE)throw Error('画像サイズが上限を超えました');
      parts.push(Buffer.from(value));
    }
  }finally{await reader.cancel().catch(()=>{});}
  const image=Buffer.concat(parts,size);
  if(image.length<33 || image.readUInt32BE(16)!==1152 ||
     image.readUInt32BE(20)!==208 || image[24]!==8 || image[25]!==6)throw Error('画像形式を確認できません');
  if(!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    throw Error('画像形式を確認できません');
  return image;
}

function segmentPython(payload,signal,model) {
  return new Promise((resolve,reject)=>{
    let done;
    const child=execFile('python3',['-B','-E',segmentationHelper],{
      env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',
        ...(model?{CREATURE_SEGMENT_ONNX_MODEL:model}:{})},
      signal,timeout:12000,maxBuffer:MAX_SEGMENT_RESPONSE,killSignal:'SIGKILL',
    },(error,stdout)=>{done={error,stdout};});
    child.once('close',()=>{
      if(!done || done.error)return reject(Error('ローカルの切り出し処理が完了しませんでした'));
      try {
        const data=JSON.parse(done.stdout);
        if(typeof data.error==='string')throw Error(data.error);
        if(!data.result || typeof data.result!=='object')
          throw Error('Segment result missing');
        resolve(data.result);
      }catch(error){reject(error);}
    });
    child.stdin.on('error',()=>child.kill('SIGKILL'));
    child.stdin.end(JSON.stringify(payload)+'\n','utf8');
  });
}

async function segmentWithImage(apiBase,reviews,mode,args,signal) {
  if(segmentationBusy)return partsError('別のPNG候補を処理中です');
  segmentationBusy=true;
  try {
    const {expected_sha256:expected, ...params}=args;
    const bytes=await localCharacterAtlas(apiBase,params);
    const digest=createHash('sha256').update(bytes).digest('hex');
    if(mode==='save' && digest!==expected)
      return partsError('元画像が変更されました。切り出しプレビューからやり直してください');
    const model=process.env.CREATURE_SEGMENT_ONNX_MODEL;
    const reviewKey=JSON.stringify([digest,params.generated_id,params.source_part,params.part_type,
      params.frame,params.seeds.map(({x,y})=>[x,y]),params.tolerance]);
    const review=mode==='save' ? reviews.get(reviewKey) : undefined;
    if(mode==='save' && !review)
      return partsError('同じ設定で候補PNGをプレビューし、確認してから保存してください');
    const result=await segmentPython({
      ...params,mode,source_png:bytes.toString('base64'),
      ...(mode==='save'?{expected_sha256:expected}:{}),
      ...(review?{review}:{}),
    },signal,model);
    if(mode==='preview'){
      const preview=result.preview_png_base64;
      const neural=result.method===NEURAL_SEGMENT_METHOD;
      if(typeof preview!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(preview) ||
         preview.length>MAX_CATALOG_IMAGE*2 || result.source_sha256!==digest ||
         (!neural && result.method!==COLOR_SEGMENT_METHOD) || result.neural_model_used!==neural ||
         createHash('sha256').update(Buffer.from(preview,'base64')).digest('hex')!==result.part_png_sha256)
        throw Error('PNG候補の検証に失敗しました');
      reviews.delete(reviewKey);
      reviews.set(reviewKey,{method:result.method,sha256:result.part_png_sha256});
      if(reviews.size>MAX_SEGMENT_REVIEWS)reviews.delete(reviews.keys().next().value);
      const {preview_png_base64,...details}=result;
      const method=neural ? 'ローカルのEfficientSAMで指定座標から領域を推定しました。' :
        (result.fallback_reason ? 'ローカルモデルの推論結果は使われませんでした。' : '')+
        'Pillowで指定座標につながる近い色の領域を切り出しました。';
      return {content:[
        {type:'text',text:method+'候補PNGを確認し、保存する場合だけ指示してください。'},
        {type:'image',mimeType:'image/png',data:preview},
      ],structuredContent:{...details,seeds:params.seeds,tolerance:params.tolerance,
        source_id:params.generated_id,saved:false,review_required:true}};
    }
    if(!/^sg_[a-f0-9]{32}$/.test(result.candidate_id) ||
       !result.local_directory?.endsWith(result.candidate_id) ||
       result.registered_in_game!==false)
      throw Error('保存結果を確認できません');
    return {content:[{type:'text',text:'確認済みの候補PNGを '+result.local_directory+
      '/part.png に保存しました。ゲームの外見や元画像は変更していません。'}],
      structuredContent:{...result,saved:true,source_id:params.generated_id}};
  }catch(error){
    return partsError(signal?.aborted?'分割処理が中止されました':
      'PNG候補を処理できませんでした: '+String(error.message??error).slice(0,180));
  }finally{segmentationBusy=false;}
}

function partsError(text) {
  return {isError:true,content:[{type:'text',text}]};
}

async function jsonFromGame(apiBase, path, body) {
  const response = await fetch(apiBase + path, {
    method:body === undefined ? 'GET' : 'POST',
    headers:body === undefined ? {} : {'Content-Type':'application/json'},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    redirect:'error', signal:AbortSignal.timeout(4000),
  });
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw Error('ゲームの応答が大きすぎます');
  let value;
  try {value = JSON.parse(text);} catch {throw Error('ゲームが正しいJSONを返しません');}
  if (!response.ok) {
    const explanation = typeof value.error === 'string' ? value.error : 'ゲームが要求を拒否しました';
    throw Error(`${response.status}: ${explanation}`);
  }
  return value;
}
/** Read at most one image from the trusted fixed Node URL; no arbitrary URI input. */
async function imageFromGame(apiBase,slot) {
  const response=await fetch(apiBase+'/api/artwork/image/'+slot,{
    headers:{Accept:'image/png, image/jpeg, image/webp'},
    redirect:'error',signal:AbortSignal.timeout(4500),
  });
  if (!response.ok) {
    if(response.status===404) throw Error('この画像スロットはまだ保存されていません');
    throw Error('画像の取得に失敗しました: HTTP '+response.status);
  }
  const mime=response.headers.get('content-type')?.split(';')[0]?.trim();
  if (!['image/png','image/jpeg','image/webp'].includes(mime) ||
      (slot!=='base' && mime==='image/jpeg')) throw Error('未対応の画像形式です');
  const declared=response.headers.get('content-length');
  if(declared!==null && (!/^\d+$/.test(declared) || Number(declared)>ARTWORK_READER_LIMIT)) {
    await response.body?.cancel();
    throw Error('画像データが大きすぎます');
  }
  const reader=response.body?.getReader();
  if(!reader) throw Error('画像の読み込みストリームがありません');
  const chunks=[];
  let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>MAX_ARTWORK_FILE)throw Error('画像は450KBまでです');
      chunks.push(Buffer.from(value));
    }
  }finally{await reader.cancel().catch(()=>{});}
  const data=Buffer.concat(chunks,size).toString('base64');
  validateArtworkImage(slot,{mime,base64:data}); // MIME and magic bytes are checked.
  return {mime,size,data};
}

function errorResult(error) {
  return {
    isError:true,
    content:[{type:'text',text:'Creature Labとの通信に失敗しました: '+String(error?.message || error)}],
  };
}

export function makeCompanionChatGptMcp({apiBase=API,readOnly=false,segmentReviews=new Map()}={}) {
  if(typeof readOnly!=='boolean') throw new TypeError('readOnly must be boolean');
  const server = new McpServer(
    {name:'creature-lab-companion',version:'1.5.0'},
    {instructions:readOnly
      ? 'Creature Labの非公開・読み取り専用メタデータ接続。保存済みキャラ、外見、画像の登録状況、育成、学習済みキャラ一覧のみ確認できる。名前やXPも個人情報として扱う。保存・プレビュー・画像本体の転送はできない。'
      :
      '自作キャラを会話で設計する。get_my_character_sheet で今の設定をまとめて確認し、保存済みイラストは view_my_artwork_image で画像として確認できる。inspect_character_image_for_parts→preview_segment_candidateで部位候補を見せ、ユーザー確認後だけsave_segment_candidateを使う。切り出し方式はプレビューのmethodで確認できる。提案時は preview_my_companion で未保存の架空相場練習を行い、本人が保存を希望した設定だけ save_my_companion/save_my_look で確定。オリジナルのキャラ画像は generate_character_parts でローカル作成し、package_character_parts でブラウザ用ZIPにまとめられる。実取引・V6変更・XP操作なし。'}
  );
  // Explicit metadata allowlist: readOnlyHint alone also permits previews/images.
  const registerTool=(name,config,handler)=>{
    if(!readOnly || READ_ONLY_TOOLS.has(name)) server.registerTool(name,config,handler);
  };
  registerTool('get_my_companion',{
    title:'Creature Lab: 自分の相棒を確認',
    description:'Nodeゲームと共有している保存済みキャラの名前、髪色、服色、予測方法、リスク設定、編集revisionを取得する。未作成ならデフォルトを返す。読み取りだけで保存しない。',
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try {
      const state = await jsonFromGame(apiBase,'/api/companion');
      return {
        content:[{type:'text',text:state.created
          ? `「${state.companion.name}」を取得しました。予測方法=${modelLabels[state.companion.approach] || state.companion.approach}、仮想資金使用率=${state.companion.risk_percent}%、revision=${state.revision}。`
          : 'まだ自分の相棒は保存されていません。以下はデフォルト設定で、保存されていません。'}],
        structuredContent:{...state,game_mode:'synthetic_practice_only',can_trade_real_money:false},
      };
    } catch(e) {return errorResult(e);}
  });
  registerTool('save_my_companion',{
    title:'Creature Lab: 自分の相棒を作成・更新',
    description:'ユーザーが選んだ相棒の名前・髪色・服色・予測方法・仮想コインの資金配分をNodeゲームに保存し、Webゲームと同期する。必ずユーザーの作成・変更意図を確認し、get_my_companionの現在revisionを指定する。旧ゲーム/V6は更新しない。',
    inputSchema:z.object({
      expected_revision:z.number().int().min(0).describe('get_my_companionで取得したrevision。同時編集の上書きを防ぐ'),
      name:z.string().min(1).max(16).describe('相棒の名前（1〜16文字）'),
      hair_color:z.string().regex(/^#[a-fA-F0-9]{6}$/).describe('髪色。例: #ff6699'),
      clothing_color:z.string().regex(/^#[a-fA-F0-9]{6}$/).describe('服色。例: #35ccbb'),
      approach:z.enum(approaches).describe('重視する分析: trend=流れ、momentum=勢い、reversion=反転、volatility=変動'),
      risk_percent:z.number().int().min(5).max(100).multipleOf(5).describe('上昇判断時に投じる仮想資金比率(5～100%, 5刻み)。実取引しない'),
    }).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({expected_revision,name,hair_color,clothing_color,approach,risk_percent})=>{
    try {
      const result=await jsonFromGame(apiBase,'/api/companion',{
        expected_revision,
        companion:{name,hair_color,clothing_color,approach,risk_percent}
      });
      return {
        content:[{type:'text',text:
          `相棒「${result.companion.name}」の設定を保存しました。revision=${result.revision}。WebのCreature Labを再読み込みすると表示され、次の架空相場練習でこの予測ルールが使われます。実相場への注文やV6の変更はありません。`}],
        structuredContent:{...result,saved_to:'Node game companion',applies_to:'synthetic_practice_only'},
      };
    }catch(e){return errorResult(e);}
  });
  registerTool('list_my_trained_brains',{
    title:'Creature Lab: 作って学習させたキャラを確認',
    description:'旧制作画面から保存した練習専用の学習済みキャラ一覧を取得。次の試遊では指定したバージョンIDで判断させられる。読み取りのみ。実市場の検証結果ではない。',
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try {
      const data=await jsonFromGame(apiBase,'/api/trained/versions');
      return {content:[{type:'text',text:
        `保存された練習専用モデルは${data.versions.length}件です。実市場の優位性を示す結果ではありません。`}],
        structuredContent:{...data,practice_only:true,real_market_validation:false}};
    }catch(e){return errorResult(e);}
  });
  registerTool('preview_my_companion',{
    title:'Creature Lab: 保存前のキャラ案を12日間お試し',
    description:'自分で決めた未保存の候補キャラ、現在保存済みの相棒、または制作画面で学習した練習版を、架空相場12日間で試す。XPやコイン、候補設定の保存、注文は行わない。結果を見てから保存を判断できる。',
    inputSchema:z.object({
      mine_pct:pct.describe('自分のキャラへの仮想コイン配分。合計100%以内'),
      owl_pct:pct.describe('ルナへの仮想コイン配分。合計100%以内'),
      turtle_pct:pct.describe('ミドリへの仮想コイン配分。合計100%以内'),
      candidate:draftSchema.optional().describe('未保存で試すキャラ案。省略すると現在の保存済み相棒を使う'),
      trained_version_id:z.string().regex(trainedId).optional().describe('学習済み練習版ID。候補キャラと同時には指定不可'),
    }).strict().refine(data=>!data.candidate || !data.trained_version_id,
      '候補キャラと学習済み練習版は同時に指定できません')
      .refine(data=>data.mine_pct+data.owl_pct+data.turtle_pct<=100 &&
        data.mine_pct+data.owl_pct+data.turtle_pct>0,
        '仮想コインを1～100%の範囲で配分してください'),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async({mine_pct,owl_pct,turtle_pct,candidate,trained_version_id})=>{
    try {
      const request={allocations:{mine:mine_pct,owl:owl_pct,turtle:turtle_pct}};
      if(candidate!==undefined) request.candidate=candidate;
      if(trained_version_id!==undefined) request.trained_version_id=trained_version_id;
      const result=await jsonFromGame(apiBase,'/api/practice/preview',request);
      if(result.preview_only!==true || result.training_ticket!==null) {
        throw Error('プレビュー専用の応答ではありません');
      }
      return {content:[{type:'text',text:
        `保存せずに試しました: 最終${result.final_coins}仮想コイン、損益${result.profit_coins}、最大下落率${result.max_drawdown_pct}%。この結果は固定架空相場だけの値で、投資実績や予測精度の検証ではありません。XPは付かず、設定も保存していません。`}],
        structuredContent:{result}};
    }catch(e){return errorResult(e);}
  });
  registerTool('get_my_look',{
    title:'Creature Lab: 自分が組み立てた2D外見パーツを確認',
    description:'ゲームと同じ髪型・表情・アクセサリーの保存済み設定を取得する。画像生成ではなく2Dパーツの組み合わせ。読み取りだけで保存しない。',
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try{
      const look=await jsonFromGame(apiBase,'/api/looks');
      return {content:[{type:'text',text:look.created?
        '保存済みの髪型・表情・飾りを読み取りました。revision='+look.revision :
        'まだ外見は保存されていません。以下は初期パーツです。'}],
        structuredContent:{...look,cosmetic_only:true}};
    }catch(e){return errorResult(e);}
  });
  registerTool('save_my_look',{
    title:'Creature Lab: 2Dキャラの髪型・表情・飾りを保存',
    description:'本人が決めたパーツをゲーム内のchibiへ保存する。get_my_lookで現在のrevisionを取得してから明示的な編集依頼で呼ぶ。予測ルール・育成・V6は変更しない。',
    inputSchema:z.object({
      expected_revision:z.number().int().min(0).describe('get_my_lookで取得した現在のrevision'),
      hair_style:z.enum(['bob','long','twintails']).describe('bob=ボブ, long=ロング, twintails=ツインテール'),
      expression:z.enum(['cheerful','calm','determined']).describe('cheerful=にっこり, calm=おっとり, determined=きりっと'),
      accessory:z.enum(['ribbon','glasses','star','none']).describe('ribbon=リボン, glasses=眼鏡, star=星, none=飾りなし'),
    }).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({expected_revision,hair_style,expression,accessory})=>{
    try{
      const value=await jsonFromGame(apiBase,'/api/looks',{
        expected_revision,look:{hair_style,expression,accessory}
      });
      return {content:[{type:'text',text:
        '自分の2Dキャラの外見を保存しました。ゲームの画面を再読み込みすると表示されます。予測ルールやXPは変更していません。'}],
        structuredContent:{...value,cosmetic_only:true}};
    }catch(e){return errorResult(e);}
  });
  registerTool('get_my_creature_growth',{
    title:'Creature Lab: 育成レベル・冒険記録を確認',
    description:'Nodeゲームの育成XP、レベル、達成した課題を読み取る。記録の変更はしない。',
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try {
      const growth=await jsonFromGame(apiBase,'/api/growth');
      return {content:[{type:'text',text:'保存済みの育成XP・レベル・実績を読み取りました。'}],structuredContent:{growth}};
    }catch(e){return errorResult(e);}
  });
  registerTool('get_my_character_sheet',{
    title:'Creature Lab: キャラ制作の現在地を一覧で確認',
    description:readOnly
      ? '自分の相棒の予測設定、見た目のパーツ、画像の登録状況だけをまとめて取得する。読み取り専用。画像本体は送らない。'
      : '自分の相棒の予測設定、見た目のパーツ、アップロード済みの画像の有無をまとめて取得する。読み取りだけ。画像本体は view_my_artwork_image で個別取得する。',
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try {
      const [companion,look,artwork]=await Promise.all([
        jsonFromGame(apiBase,'/api/companion'),
        jsonFromGame(apiBase,'/api/looks'),
        jsonFromGame(apiBase,'/api/artwork'),
      ]);
      return {
        content:[{type:'text',text:readOnly
          ? '現在の自作キャラの設定・外見・画像登録状況を読み取りました。画像本体の転送・保存・プレビューはこの接続ではできません。'
          : '現在の自作キャラの設定・外見・画像登録状況をまとめました。画像をChatGPTで確認するときは view_my_artwork_image を呼び、本人が決めた内容のみ保存してください。未保存の内容を自動確定しません。'}],
        structuredContent:{companion,look,artwork,read_only:true,
          preview_only_until_explicit_save:true,real_market_trading:false},
      };
    }catch(e){return errorResult(e);}
  });
  registerTool('view_my_artwork_image',{
    title:'Creature Lab: 保存済みの自作イラストをChatGPTで見る',
    description:'ユーザーが自分の作品の閲覧・画像分析を明示的に求めた時だけ使用。Nodeゲームに保存された完成イラスト（base）または髪・顔・服を画像データとしてChatGPTへ送って表示する。ローカル以外への画像送信が発生するため、単なる設定確認では呼ばない。自動分割は行わず、ローカルの画像保存内容も変更しない。',
    inputSchema:z.object({
      slot:z.enum(['base','hair','face','outfit']).describe(
        'base=完成イラスト、hair=髪、face=顔、outfit=服。保存済みスロットのみ表示')
    }).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async({slot})=>{
    try {
      const image=await imageFromGame(apiBase,slot);
      const labels={base:'完成イラスト',hair:'髪レイヤー',face:'顔レイヤー',outfit:'服レイヤー'};
      return {
        content:[
          {type:'text',text:labels[slot]+'を表示します。画像からの提案は推測であり、自動的な正しい部位分割ではありません。書き込みやユーザー以外への共有は行っていません。'},
          {type:'image',mimeType:image.mime,data:image.data},
        ],
        structuredContent:{slot,mime:image.mime,bytes:image.size,source:'user_saved_artwork',
          read_only:true,automatic_segmentation:false},
      };
    }catch(e){return errorResult(e);}
  });
  registerTool('get_my_artwork',{
    title:'Creature Lab: 自分のイラストの保存状況を確認',
    description:'完成イラスト・髪・顔・服の保存状況（revision、存在、MIME、サイズ）だけを読み取る。画像バイトは送らない。画像本体は別ツールを明示的に呼んだときだけ返される。画像はローカルゲーム画面でSAVEする。',
    inputSchema:z.object({}).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try {
      const state=await jsonFromGame(apiBase,'/api/artwork');
      return {content:[{type:'text',text:
        '自分のイラストの保存状況を読み取りました。'+(readOnly ? 'この接続では画像本体の取得は禁止しています。' : '画像本体を確認するときは明示的な本人の依頼が必要です。')+'ローカルゲームの「私のイラストを重ねる」でファイルを選び、SAVEしてください。自動切り抜きは行いません。'}],
        structuredContent:state};
    }catch(e){return errorResult(e);}
  });
  registerTool('inspect_character_image_for_parts',{
    title:'Creature Lab: 登録PNGをAIで確認する',
    description:'ユーザーが登録画像の閲覧または切り出しを明示的に依頼した場合だけ呼ぶ。指定した登録済みキャラのbody/ready/happy/cautiousの6コマPNGを表示し、部位候補の座標を調べる。',
    inputSchema:segmentSourceSchema,
    // Image disclosure requires explicit user approval even without disk writes.
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async args=>{
    try {
      const image=await localCharacterAtlas(apiBase,args);
      return {content:[
        {type:'text',text:'指定した登録画像（1152×208、6コマ）を表示します。各コマ192×208で、候補の座標は1コマ内のx=0～191、y=0～207で指定してください。閲覧のみで自動分割・保存はしていません。'},
        {type:'image',mimeType:'image/png',data:image.toString('base64')},
      ],structuredContent:{...args,bytes:image.length,frames:6,
        cell_width:192,cell_height:208,read_only:true,review_required:true}};
    }catch(error){return errorResult(error);}
  });
  registerTool('preview_segment_candidate',{
    title:'Creature Lab: 顔・髪・アクセサリーの切り出し候補を表示',
    description:'ユーザーが切り出しを明示的に依頼した場合だけ呼ぶ。登録済み画像の不透明部分に指定した座標から、目・口・髪・リボン等の候補PNGを表示する。設定済みの場合はローカルの点指定モデルを試す。Pillowで近い色の領域を抽出する場合は色の許容差を使う。',
    inputSchema:segmentationSchema,
    // Image disclosure requires explicit user approval even without disk writes.
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },(args,extra)=>segmentWithImage(apiBase,segmentReviews,'preview',args,extra?.signal));
  registerTool('save_segment_candidate',{
    title:'Creature Lab: 確認した切り出し候補を別PNGで保存',
    description:'ユーザーが候補プレビューを確認して保存を依頼した場合のみ呼ぶ。プレビューと同じ入力および元画像SHA-256を指定する。確認済み候補PNGのSHA-256を照合し、新規の独立したPNGとして保存する。',
    inputSchema:confirmSegmentationSchema,
    annotations:localWrite,
  },(args,extra)=>segmentWithImage(apiBase,segmentReviews,'save',args,extra?.signal));
  registerTool('generate_character_parts',{
    title:'Creature Lab: オリジナルのキャラパーツを生成',
    description:'名前・髪色・服色・飾り・シードから、体と3表情の透過6コマPNG、GIF、manifestをローカル作成する。色は #RRGGBB。engine=original-template の手続き描画。',
    inputSchema:appearanceSchema,
    annotations:localWrite,
  },(input,extra)=>characterParts('generate',input,extra?.signal,path=>
    '手続き描画でキャラパーツと preview.gif を '+path+' に作成しました。ZIP化には generated_id を指定してください。'));
  registerTool('package_character_parts',{
    title:'Creature Lab: 生成済みのキャラパーツをZIP化',
    description:'生成済みの generated_id を指定し、ブラウザのパーツラボで読み込めるローカルZIPを作成する。',
    inputSchema:generatedIdSchema,
    annotations:{...localWrite,idempotentHint:true},
  },(input,extra)=>characterParts('package',input,extra?.signal,path=>
    'パーツラボのZIP入力で '+path+'/character_parts.zip を選ぶと、体と3表情を読み込めます。'));
  registerTool('register_demo_character',{
    title:'Creature Lab: 生成キャラをローカルのデモ用に記録',
    description:'生成済みの generated_id をローカルのデモ用メタデータに記録する。登録後はパーツラボの Registered Demo Gallery から試せる。',
    inputSchema:generatedIdSchema,
    annotations:{...localWrite,idempotentHint:true},
  },(input,extra)=>characterParts('register',input,extra?.signal,path=>
    'ローカルのデモ用メタデータを '+path+'/demo.json に記録しました。パーツラボを開くか再読み込みし、Registered Demo Gallery で「このキャラで試す」を選んでください。'));
  return server;
}

function locallyAllowed(req, port) {
  const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
  const peer=req.socket.remoteAddress;
  const origin=req.headers.origin;
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) &&
    hosts.includes(req.headers.host) &&
    (!origin || hosts.some(x=>origin==='http://'+x)) &&
    !['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto'].some(x=>req.headers[x]);
}

export function createCompanionChatGptHttpServer({apiBase=API,readOnly=false}={}) {
  if(typeof readOnly!=='boolean') throw new TypeError('readOnly must be boolean');
  // Stateless requests each create an MCP instance. Keep reviews at server scope.
  const segmentReviews=new Map();
  const server=createServer(async(req,res)=>{
    const port=server.address()?.port;
    if(!locallyAllowed(req,port)) {
      res.writeHead(403,{'Content-Type':'text/plain'}).end('Private localhost only');
      return;
    }
    const url=new URL(req.url ?? '/', 'http://localhost');
    if(req.method==='GET' && url.pathname==='/health') {
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'})
        .end(JSON.stringify({ok:true,name:'creature-lab-companion',private:true,port,
          tools:readOnly ? READ_ONLY_TOOLS.size : 16}));
      return;
    }
    if(url.pathname!=='/mcp' || !['POST','GET','DELETE'].includes(req.method)) {
      res.writeHead(404).end('Not found');return;
    }
    if(req.method==='POST' && Number(req.headers['content-length']??0)>MAX_REQUEST_BYTES) {
      res.writeHead(413).end('Request too large');return;
    }
    const mcp=makeCompanionChatGptMcp({apiBase,readOnly,segmentReviews});
    const transport=new StreamableHTTPServerTransport({
      sessionIdGenerator:undefined,enableJsonResponse:true,
    });
    res.on('close',()=>{transport.close();mcp.close();});
    try {await mcp.connect(transport);await transport.handleRequest(req,res);}
    catch(e){
      // No private token/body details in logs.
      console.error('Companion MCP failed:',e instanceof Error?e.message:'unknown');
      if(!res.headersSent)res.writeHead(500).end('MCP error');
    }
  });
  return server;
}

export function parseCompanionChatGptArgs(args) {
  let readOnly=false,port;
  for(const arg of args) {
    if(arg==='--read-only' && !readOnly) readOnly=true;
    else if(/^--port=[1-9]\d{0,4}$/.test(arg) && port===undefined) {
      port=Number(arg.slice('--port='.length));
      if(port>65535) throw new Error('Invalid port');
    } else throw new Error('Invalid arguments');
  }
  return {readOnly,port:port ?? (readOnly ? CHATGPT_READ_ONLY_MCP_PORT : CHATGPT_MCP_PORT)};
}

// Bootstrap only when directly run; importing does not create a listener.
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    const {readOnly,port}=parseCompanionChatGptArgs(process.argv.slice(2));
    const server=createCompanionChatGptHttpServer({readOnly});
    server.on('error',()=>{
      process.stderr.write(`Creature Lab private ChatGPT MCP could not listen on 127.0.0.1:${port}\n`);
      process.exitCode=1;
    });
    server.listen(port,'127.0.0.1',()=>{
      process.stdout.write(`Creature Lab private ChatGPT MCP ready: http://127.0.0.1:${port}/mcp${readOnly ? ' (read-only metadata)' : ''}\n`);
    });
  } catch {
    process.stderr.write('Usage: node mcp/companion-chatgpt.mjs [--read-only] [--port=1..65535]\n');
    process.exitCode=1;
  }
}
