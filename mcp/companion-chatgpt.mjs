/**
 * Small, private ChatGPT MCP adapter for the Node-owned Creature Lab companion.
 *
 * ChatGPT -> private MCP -> Node 8890 -> node_game/companion.json
 * Does NOT expose the legacy Python 8765 MCP mutation tools, stock V6, XP
 * rewards, files, filesystem access, trade APIs, or arbitrary HTTP destinations.
 * Authentication is supplied by a future Secure MCP Tunnel / private transport.
 * NEVER expose this listener using a public forwarding URL without auth.
 */
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';

export const CHATGPT_MCP_PORT = 8896;
const API = 'http://127.0.0.1:8890';
const MAX_REQUEST_BYTES = 8192;
const MAX_RESPONSE_BYTES = 65536;
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
function errorResult(error) {
  return {
    isError:true,
    content:[{type:'text',text:'Creature Labとの通信に失敗しました: '+String(error?.message || error)}],
  };
}

export function makeCompanionChatGptMcp({apiBase=API}={}) {
  const server = new McpServer(
    {name:'creature-lab-companion',version:'1.2.0'},
    {instructions:
      'ユーザー自身がゲーム用相棒を設計する。まず get_my_companion で現在の設定を取得し、preview_my_companion で未保存の案を架空相場で試す。保存意図を確認してから save_my_companion で保存する。学習済みキャラは list_my_trained_brains で取得し、試遊時にIDを選べる。プレビューにXP・保存・実取引なし。V6変更・画像の自動作画もできない。'}
  );
  server.registerTool('get_my_companion',{
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
  server.registerTool('save_my_companion',{
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
  server.registerTool('list_my_trained_brains',{
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
  server.registerTool('preview_my_companion',{
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
  server.registerTool('get_my_look',{
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
  server.registerTool('save_my_look',{
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
  server.registerTool('get_my_creature_growth',{
    title:'Creature Lab: 育成レベル・装備を確認',
    description:'Nodeゲームの育成XP、レベル、現在の装備を読み取る。XPや装備の変更はしない。',
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try {
      const growth=await jsonFromGame(apiBase,'/api/growth');
      return {content:[{type:'text',text:'保存済みの育成XP・装備を読み取りました。'}],structuredContent:{growth}};
    }catch(e){return errorResult(e);}
  });
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

export function createCompanionChatGptHttpServer(options={}) {
  const server=createServer(async(req,res)=>{
    const port=server.address()?.port;
    if(!locallyAllowed(req,port)) {
      res.writeHead(403,{'Content-Type':'text/plain'}).end('Private localhost only');
      return;
    }
    const url=new URL(req.url ?? '/', 'http://localhost');
    if(req.method==='GET' && url.pathname==='/health') {
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'})
        .end(JSON.stringify({ok:true,name:'creature-lab-companion',private:true,port,tools:7}));
      return;
    }
    if(url.pathname!=='/mcp' || !['POST','GET','DELETE'].includes(req.method)) {
      res.writeHead(404).end('Not found');return;
    }
    if(req.method==='POST' && Number(req.headers['content-length']??0)>MAX_REQUEST_BYTES) {
      res.writeHead(413).end('Request too large');return;
    }
    const mcp=makeCompanionChatGptMcp(options);
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

// Bootstrap only when directly run; importing does not create a listener.
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=createCompanionChatGptHttpServer();
  server.listen(CHATGPT_MCP_PORT,'127.0.0.1',()=>{
    process.stdout.write(`Creature Lab private ChatGPT MCP ready: http://127.0.0.1:${CHATGPT_MCP_PORT}/mcp\n`);
  });
}
