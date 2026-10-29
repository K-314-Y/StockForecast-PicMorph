import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../../web/game.html",import.meta.url),"utf8");
class Element {
  constructor(){this.children=[];this.style={};this.attrs={};this.listeners={};this.value="";}
  appendChild(child){this.children.push(child);}
  replaceChildren(){this.children=[];}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,fn){this.listeners[k]=fn;}
}
function controls(call){
  const elements=new Map();
  const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  $("challengeMode").value="market";
  $("marketCode").value="7203";
  $("marketEndDate").value="2025-06-30";
  const context=vm.createContext({$,call,renderChallengeResult:()=>{throw Error("unexpected successful render");}});
  const start=source.indexOf("let marketConfigured=");
  const end=source.indexOf("loadMarketStatus();",start);
  vm.runInContext(source.slice(start,end),context);
  return {$,context};
}

test("script parses; real market is the default and challenge precedes practice",()=>{
  new vm.Script(source.slice(source.indexOf("<script>")+8,source.indexOf("</script>")));
  assert.ok(source.includes('<option value="market" selected>'));
  assert.ok(source.indexOf('id="challengeSection"') < source.indexOf('id="mine"'));
  assert.ok(source.includes('id="challengeAnalysis"><summary>'));
  assert.ok(source.includes('[hidden]{display:none!important}'));
  assert.ok(!source.includes('type="password"'));
});

test("missing configuration disables real replay, explicit synthetic selection remains available",async()=>{
  const paths=[];
  const {$,context}=controls(async path=>{paths.push(path);return {configured:false,message:"設定未完了",max_end_date:"2026-10-29"};});
  await context.loadMarketStatus();
  assert.deepEqual(paths,["/api/market/status"]);
  assert.equal($("marketStatus").textContent,"設定未完了");
  assert.equal($("runChallenge").disabled,true);
  assert.equal($("marketControls").hidden,false);
  assert.equal($("syntheticControls").hidden,true);
  $("challengeMode").value="synthetic";
  vm.runInContext("scenarioAvailable=true;updateChallengeMode()",context);
  assert.equal($("runChallenge").disabled,false);
  assert.equal($("marketControls").hidden,true);
  assert.equal($("syntheticControls").hidden,false);
});

test("provider error clears stale result and never calls synthetic fallback",async()=>{
  const calls=[];
  const {$,context}=controls(async(path,payload)=>{calls.push({path,payload});throw Error("J-Quants HTTP 403");});
  vm.runInContext("marketConfigured=true",context);
  $("challengeResult").hidden=false;
  await $("runChallenge").listeners.click();
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,"/api/market/replay");
  assert.equal(JSON.stringify(calls[0].payload),JSON.stringify({code:"7203",end_date:"2025-06-30"}));
  assert.equal($("challengeResult").hidden,true);
  assert.match($("challengeStatus").textContent,/HTTP 403/);
  assert.equal($("challengeMode").value,"market");
  assert.equal($("challengeMode").disabled,false);
  assert.equal($("runChallenge").disabled,false);
});

test("invalid form never fetches; double mode changes cannot mix responses",async()=>{
  let called=false;
  const {$}=controls(async()=>{called=true;});
  $("marketCode").value="https://example.com";
  await $("runChallenge").listeners.click();
  assert.equal(called,false);
  let resolve;
  const pending=new Promise(r=>{resolve=r;});
  const second=controls(()=>pending);
  second.context.renderChallengeResult=data=>{second.$("challengeResult").hidden=false;};
  vm.runInContext("marketConfigured=true",second.context);
  const run=second.$("runChallenge").listeners.click();
  assert.equal(second.$("challengeMode").disabled,true);
  assert.equal(second.$("runChallenge").disabled,true);
  resolve({scenario_name:"日本株",warning:"過去リプレイ"});
  await run;
  assert.equal(second.$("challengeResult").hidden,false);
  assert.equal(second.$("challengeMode").disabled,false);
});

test("explicit synthetic mode preserves original API and body",async()=>{
  const calls=[];
  const {$,context}=controls(async(path,payload)=>{calls.push({path,payload});throw Error("test stops before rendering");});
  $("challengeMode").value="synthetic";$("scenario").value="rising";
  vm.runInContext("scenarioAvailable=true",context);
  await $("runChallenge").listeners.click();
  assert.equal(calls[0].path,"/api/challenge/run");
  assert.equal(JSON.stringify(calls[0].payload),JSON.stringify({scenario_id:"rising"}));
});

test("market metadata, full hash and dates render as text, analysis stays collapsed",()=>{
  const elements=new Map();
  const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const context=vm.createContext({$,fmt:String,renderChallengeDetails:()=>{},document:{createElement:()=>new Element()}});
  const start=source.indexOf("function renderChallengeResult");
  vm.runInContext(source.slice(start,source.indexOf("let marketConfigured=",start)),context);
  const history=Array.from({length:12},(_,i)=>({step:i+1}));
  context.data={steps:12,initial_coins_each:10000,uniform_baseline_brier:2/3,flat_threshold_pct:.8,
    source_revision:0,lineup_revision:0,growth_revision:0,warning:"過去の結果は今後の予測能力を保証しません",
    market:{code:"72030",provider:"<script>not HTML</script>",fetched_at:"2026-10-30T01:00:00+00:00",prediction_start_date:"2025-06-12",first_target_date:"2025-06-13",final_date:"2025-06-30",requested_end_date:"2025-06-30",warmup_start_date:"2025-04-18",warmup_end_date:"2025-06-12",warmup_sessions:40,price_series_sha256:"a".repeat(64)},
    contestants:Object.fromEntries(["mine","owl","turtle"].map(key=>[key,{name:key,history,brier_mean:.4,profit_coins:123,max_drawdown_pct:1,accuracy_pct:50,ranks:{profit:1,brier:1,drawdown:1}}]))};
  vm.runInContext("renderChallengeResult(data)",context);
  assert.equal($("challengeCards").children.length,3);
  assert.equal($("challengeAnalysis").open,false);
  assert.equal($("challengeMarket").hidden,false);
  assert.ok($("challengeMarket").textContent.includes("a".repeat(64)));
  assert.ok($("challengeMarket").textContent.includes("2025-06-13"));
  assert.ok($("challengeMarket").textContent.includes("<script>not HTML</script>"));
  assert.equal($("challengeMarket").children.length,0);
  assert.equal($("challengeResult").hidden,false);
});
