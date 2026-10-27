/**
 * Creature Lab MCP, Sprint 2.
 * Local-only bridge from MCP tools to the existing Python/SVG prototype.
 * Deliberately NOT a public or authenticated MCP endpoint.
 */
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const UI_ORIGIN = "http://127.0.0.1:8765";
const PORT = 8766;
const MCP_PATH = "/mcp";
const MAX_INPUT_BYTES = 16384;

async function requestCore(path, data) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(UI_ORIGIN + path, {
      method: data === undefined ? "GET" : "POST",
      headers: data === undefined ? {} : {"Content-Type": "application/json"},
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(`Creature core HTTP ${response.status}: ${result.error ?? "invalid request"}`);
    }
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Creature core connection timed out");
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

function responseFor(state, label) {
  const girl = ({falcon: "アカリ", owl: "ルナ", turtle: "ミドリ", custom: "オリジナル"})[state.visual.eye] ?? "オリジナル";
  return {
    content: [{type:"text", text:`${label}。revision=${state.revision}、キャラ=${girl}、分析タイプ=${state.visual.eye}、UP=${(state.prediction.UP*100).toFixed(1)}%、FLAT=${(state.prediction.FLAT*100).toFixed(1)}%、DOWN=${(state.prediction.DOWN*100).toFixed(1)}%。すべて架空価格。`}],
    structuredContent: {state}
  };
}
function toolError(error) {
  return {isError:true,content:[{type:"text",text:`変更できませんでした: ${error.message}`}]};
}
const expected = z.number().int().min(0).describe("get_creature_stateで取得した現在のrevision。競合防止のため必須");
const risk = z.number().min(.05).max(1).finite().describe("仮想コイン運用の参考配分比率。実売買なし");

function makeMcpServer() {
  const server = new McpServer(
    {name:"creature-lab",version:"0.8.0"},
    {instructions:"Creature Labは架空データで動く開発用ゲーム。装備変更前にget_creature_stateでrevisionを取得し、set_eye等に渡す。予測を実際の投資助言として扱わない。勝手な実取引やV6ファイル操作はできない。"}
  );
  server.registerTool("get_creature_state",{
    title:"予測クリーチャーの状態を見る",
    description:"現在のキャラクター装備、Python定数、合成価格による予測確率、revisionを読む。設定変更前に呼ぶ。",
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{try{return responseFor(await requestCore("/api/state"),"現在のモデルを取得")}catch(e){return toolError(e)}});

  server.registerTool("list_creature_parts",{
    title:"装備とプラグインの種類を確認する",
    description:"Sprint 2で利用可能なゲーム内プラグインを一覧表示。自由なコードや実市場データは未実装。",
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>({
    content:[{type:"text",text:"目: falcon(3/9日)、owl(5/12日)、turtle(8/20日)。盾: risk_fraction 0.05〜1.0。各数値はサンプル。"}],
    structuredContent:{parts:[{id:"eye",modes:["falcon","owl","turtle"],effect:"移動平均期間を変更"},{id:"shield",range:[0.05,1.0],effect:"最大参考コイン配分を変更"}],mode:"synthetic-only"}
  }));

  server.registerTool("set_eye",{
    title:"クリーチャーの目を装備変更",
    description:"目の装備を変更し、移動平均設定と架空の予測確率を同時に変更する。予測に影響する書き込み操作。",
    inputSchema:{eye:z.enum(["falcon","owl","turtle"]),expected_revision:expected},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({eye,expected_revision})=>{try{return responseFor(await requestCore("/api/visual",{eye,expected_revision}),"目を変更")}catch(e){return toolError(e)}});

  server.registerTool("set_shield",{
    title:"クリーチャーの盾を調整",
    description:"盾の外見と仮想コインの参考リスク配分枠を変更する。価格予測値や現実の資金は操作しない。",
    inputSchema:{risk_fraction:risk,expected_revision:expected},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({risk_fraction,expected_revision})=>{try{return responseFor(await requestCore("/api/visual",{risk:risk_fraction,expected_revision}),"盾を変更")}catch(e){return toolError(e)}});

  server.registerTool("set_model_parameters",{
    title:"予測モデルの計算定数を編集",
    description:"短期・長期移動平均期間とリスク比率を設定し、Pythonとキャラ表示を双方向同期する。任意コード実行はしない。",
    inputSchema:{
      fast_window:z.number().int().min(2).max(19),
      slow_window:z.number().int().min(3).max(20),
      risk_fraction:risk,
      expected_revision:expected,
    },
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({fast_window,slow_window,risk_fraction,expected_revision})=>{
    try {
      if(fast_window>=slow_window) throw new Error("fast_window は slow_window より短くする必要があります");
      const current = await requestCore("/api/state");
      if(current.revision !== expected_revision) throw new Error("revision が更新されています。再読み込みしてからやり直してください");
      const source=current.python
        .replace(/^FAST_WINDOW = .*$/m,`FAST_WINDOW = ${fast_window}`)
        .replace(/^SLOW_WINDOW = .*$/m,`SLOW_WINDOW = ${slow_window}`)
        .replace(/^RISK_FRACTION = .*$/m,`RISK_FRACTION = ${risk_fraction}`);
      return responseFor(await requestCore("/api/code",{python:source,expected_revision}),"計算定数を変更");
    } catch(e){return toolError(e)}
  });
  server.registerTool("list_analysis_plugins",{
    title:"分析プラグインの一覧",
    description:"安全な内蔵分析プラグイン（トレンド・モメンタム・ボラティリティ）の定義。任意コード実行なし。",
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try{
      const result=await requestCore("/api/plugins");
      return {content:[{type:"text",text:"利用できる内蔵分析プラグインの一覧です。重みの合計を100%にして設定します。"}],structuredContent:result};
    }catch(e){return toolError(e)}
  });

  server.registerTool("set_analysis_plugins",{
    title:"3種類の分析プラグインを組み合わせる",
    description:"登録済み分析のうち従来の3種＋平均回帰を整数％で加重平均。モデルのPython定数・キャラ装飾・予測確率・練習ゲームに反映。合計100%必須。",
    inputSchema:{
      trend_pct:z.number().int().min(0).max(100),
      momentum_pct:z.number().int().min(0).max(100),
      volatility_pct:z.number().int().min(0).max(100),
      reversion_pct:z.number().int().min(0).max(100).optional().default(0),
      expected_revision:expected,
    },
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({trend_pct,momentum_pct,volatility_pct,reversion_pct=0,expected_revision})=>{
    try{
      const state=await requestCore("/api/plugins",{
        weights:{trend:trend_pct,momentum:momentum_pct,volatility:volatility_pct,reversion:reversion_pct},
        expected_revision,
      });
      return responseFor(state,"分析プラグインを変更");
    }catch(e){return toolError(e)}
  });

  server.registerTool("configure_analysis_plugins",{
    title:"登録済み分析プラグインの比率を設定する",
    description:"登録済みプラグインIDと重みのマップを使用。種類が追加されても同じMCPインターフェース。登録済み全種の指定と合計100%が必須。",
    inputSchema:{
      weights:z.record(z.number().int().min(0).max(100)),
      expected_revision:expected,
    },
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({weights,expected_revision})=>{
    try{
      return responseFor(await requestCore("/api/plugins",{weights,expected_revision}),"分析プラグインを更新");
    }catch(e){return toolError(e)}
  });

  server.registerTool("set_plugin_strengths",{
    title:"分析プラグイン固有の感度を設定",
    description:"登録済み4つの分析それぞれの感度を50〜150の整数で設定する。モデル表示・予測とコード・保存データ・シミュレーションに連動。",
    inputSchema:{strengths:z.record(z.number().int().min(50).max(150)),expected_revision:expected},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({strengths,expected_revision})=>{
    try {return responseFor(await requestCore("/api/plugin-settings",{strengths,expected_revision}),"プラグイン感度を更新")}
    catch(e){return toolError(e)}
  });

  server.registerTool("get_character_lineup",{
    title:"キャラ別の予測モデル編成を確認",
    description:"ルナ・ミドリへ設定した保存済み予測モデルと編成revisionを返す。",
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try {const lineup=await requestCore("/api/lineup");return {content:[{type:"text",text:"キャラ別の保存モデル割当と現在の編成を取得"}],structuredContent:{lineup}}}
    catch(e){return toolError(e)}
  });

  server.registerTool("assign_character_version",{
    title:"保存済みモデルをキャラへ装備する",
    description:"ルナまたはミドリに名前付き保存モデルを割り当てる。version_id=nullで標準モデルに戻す。仮想相場のみ。",
    inputSchema:{
      slot:z.enum(["owl","turtle"]),
      version_id:z.string().length(32).nullable(),
      expected_lineup_revision:z.number().int().min(0),
    },
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({slot,version_id,expected_lineup_revision})=>{
    try {const lineup=await requestCore("/api/lineup",{slot,version_id,expected_lineup_revision});
      return {content:[{type:"text",text:"キャラ編成を更新しました。"}],structuredContent:{lineup}}}
    catch(e){return toolError(e)}
  });

  server.registerTool("list_challenge_scenarios",{
    title:"架空対戦チャレンジのシナリオ一覧",
    description:"ローカルの固定架空シナリオ3種の名前・説明・ステップ数を取得。モデルや育成データは変更しない。",
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try {
      const result=await requestCore("/api/challenge/scenarios");
      return {content:[{type:"text",text:"架空対戦チャレンジ一覧を取得しました。"}],structuredContent:result};
    }catch(e){return toolError(e)}
  });

  server.registerTool("run_challenge_comparison",{
    title:"3体の架空予測チャレンジを比較",
    description:"同一の固定合成シナリオで確率予測のBrier Score、架空コイン損益、最大下落率を別々に順位付け。報酬や保存状態を変更しない。市場データではない。",
    inputSchema:{scenario_id:z.enum(["rising","falling","sideways"])},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async({scenario_id})=>{
    try {
      const result=await requestCore("/api/challenge/run",{scenario_id});
      const summary=Object.entries(result.contestants).map(([slot,item])=>
        slot+": Brier="+item.brier_mean+", "+item.profit_coins+" C, MaxDD="+item.max_drawdown_pct+"%"
      ).join("; ");
      return {
        content:[{type:"text",text:result.scenario_name+"。"+summary+"。すべて固定架空データであり実力評価ではありません。"}],
        structuredContent:{result},
      };
    }catch(e){return toolError(e)}
  });

  server.registerTool("get_creature_growth",{
    title:"キャラ育成のレベル・経験値・装備を見る",
    description:"ローカルのチュートリアル実績を読み取る。経験値は仮想コインの利益で増えない。",
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try {
      const growth=await requestCore("/api/growth");
      return {content:[{type:"text",text:"3体の育成課題・XP・装備を取得しました。"}],structuredContent:{growth}};
    }catch(e){return toolError(e)}
  });

  server.registerTool("complete_creature_training",{
    title:"完了したチュートリアル課題のXPを記録する",
    description:"指定配分の架空練習を検証し、各課題を各キャラ一度だけXP付与する。利益・的中率に連動せず、保存済みモデルも編集しない。",
    inputSchema:{
      mine_pct:z.number().int().min(0).max(100),
      owl_pct:z.number().int().min(0).max(100),
      turtle_pct:z.number().int().min(0).max(100),
      expected_growth_revision:expected,
    },
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({mine_pct,owl_pct,turtle_pct,expected_growth_revision})=>{
    try {
      const result=await requestCore("/api/training/complete",{
        allocations:{mine:mine_pct,owl:owl_pct,turtle:turtle_pct},
        expected_growth_revision
      });
      return {content:[{type:"text",text:"チュートリアル課題の達成を記録しました。繰り返しても重複XPは得られません。"}],structuredContent:result};
    }catch(e){return toolError(e)}
  });

  server.registerTool("equip_creature_gear",{
    title:"育成で解放した装備をキャラへ付ける",
    description:"キャラごとの育成XPで解放した装備を選ぶ。次回の架空シミュレーションで予測パラメータの感度が変化する。",
    inputSchema:{
      slot:z.enum(["mine","owl","turtle"]),
      gear_id:z.enum(["none","focus_lens","spark_charm","calm_halo"]),
      expected_growth_revision:expected,
    },
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({slot,gear_id,expected_growth_revision})=>{
    try {
      const growth=await requestCore("/api/growth/equip",{slot,gear_id,expected_growth_revision});
      return {content:[{type:"text",text:"ゲーム内の装備を更新しました。"}],structuredContent:{growth}};
    }catch(e){return toolError(e)}
  });

  server.registerTool("run_coin_practice",{
    title:"架空のコイン運用を練習する",
    description:"ユーザーのキャラ、ルナ、ミドリの3体へ無料コインを配分し、架空の12日分の価格で損益・最大下落率を計算。現金取引やランキングは行わない。",
    inputSchema:{
      mine_pct:z.number().int().min(0).max(100),
      owl_pct:z.number().int().min(0).max(100),
      turtle_pct:z.number().int().min(0).max(100),
    },
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async({mine_pct,owl_pct,turtle_pct})=>{
    try{
      const result=await requestCore("/api/practice",{
        allocations:{mine:mine_pct,owl:owl_pct,turtle:turtle_pct}
      });
      return {content:[{type:"text",text:`練習結果: ${result.final_coins}コイン、損益 ${result.profit_coins}コイン、最大下落率 ${result.max_drawdown_pct}%。架空相場のみ。実際の投資には利用不可。`}],structuredContent:{result}};
    }catch(e){return toolError(e)}
  });

  server.registerTool("list_saved_models",{
    title:"保存した予測キャラを一覧表示",
    description:"ローカルに保存した予測モデルのバージョン一覧を確認する。",
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{
    try{
      const result=await requestCore("/api/versions");
      return {content:[{type:"text",text:`保存されたバージョンは${result.versions.length}件です。`}],structuredContent:result};
    }catch(e){return toolError(e)}
  });

  server.registerTool("save_current_model",{
    title:"現在の予測キャラを保存",
    description:"今の予測モデルを名前付きバージョンとしてLinux内へ永続保存。既存V6には触れない。",
    inputSchema:{name:z.string().min(1).max(40),expected_revision:expected},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({name,expected_revision})=>{
    try{
      const result=await requestCore("/api/version/save",{name,expected_revision});
      return {content:[{type:"text",text:`「${result.saved.name}」を保存しました。ID=${result.saved.id}`}],structuredContent:result};
    }catch(e){return toolError(e)}
  });

  server.registerTool("load_saved_model",{
    title:"保存済み予測キャラを復元",
    description:"選んだモデルの設定で、現在のキャラと予測コードを上書きする。revisionを必ず確認。",
    inputSchema:{id:z.string().length(32),expected_revision:expected},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({id,expected_revision})=>{
    try{return responseFor(await requestCore("/api/version/load",{id,expected_revision}),"モデルを復元")}
    catch(e){return toolError(e)}
  });
  return server;
}

const server = createServer(async(req,res)=>{
  // Never expose this prototype outside the local computer. No public tunnel
  // until per-user authentication, data isolation and explicit permission exist.
  const host=req.headers.host;
  const origin=req.headers.origin;
  const peer=req.socket.remoteAddress;
  if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(peer) ||
     ![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(host) ||
     (origin && ![`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(origin))) {
    res.writeHead(403,{"content-type":"text/plain"}).end("Local access only");
    return;
  }
  const url = new URL(req.url ?? "/", `http://${host}`);
  if(req.method==="GET" && url.pathname==="/health"){
    res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({ok:true,localOnly:true}));
    return;
  }
  if(url.pathname!==MCP_PATH || !["POST","GET","DELETE"].includes(req.method)){
    res.writeHead(404).end("Not found");return;
  }
  if(req.method==="POST" && Number(req.headers["content-length"]??0)>MAX_INPUT_BYTES){
    res.writeHead(413).end("Request too large");return;
  }
  const mcp=makeMcpServer();
  const transport=new StreamableHTTPServerTransport({
    sessionIdGenerator:undefined,
    enableJsonResponse:true,
  });
  res.on("close",()=>{transport.close();mcp.close()});
  try{
    await mcp.connect(transport);
    await transport.handleRequest(req,res);
  }catch(error){
    console.error("MCP request failed:",error instanceof Error?error.message:String(error));
    if(!res.headersSent)res.writeHead(500).end("MCP error");
  }
});

server.listen(PORT,"127.0.0.1",()=>{
  console.log(`Creature Lab MCP ready: http://127.0.0.1:${PORT}/mcp (LOCAL ONLY)`);
});
