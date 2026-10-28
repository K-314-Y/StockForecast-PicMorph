import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_MCP="http://127.0.0.1:8766/mcp";
const URL_CORE="http://127.0.0.1:8765/api/state";
const eyes=["falcon","owl","turtle"];
const outcomeKeys=["UP","FLAT","DOWN"];

test("MCP handshake, safe edits, bidirectional reflection and revision rejection", async()=>{
  const client=new Client({name:"creature-lab-tests",version:"0.2.0"});
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_MCP)));
  let original;
  let current;
  const call=async(name,args={})=>client.callTool({name,arguments:args});
  const state=async()=> {
    const result=await call("get_creature_state");
    assert.ok(!result.isError);
    return result.structuredContent.state;
  };
  try {
    const tools=await client.listTools();
    const names=tools.tools.map(x=>x.name);
    for(const name of [ "get_creature_manual","get_creature_state","list_creature_parts","set_eye","set_shield","set_model_parameters","run_coin_practice","list_saved_models","save_current_model","load_saved_model","list_analysis_plugins","set_analysis_plugins","configure_analysis_plugins","set_plugin_strengths","get_character_lineup","assign_character_version","get_creature_growth","complete_creature_training","equip_creature_gear","list_challenge_scenarios","run_challenge_comparison"]){
      assert.ok(names.includes(name),`missing tool: ${name}`);
    }
    const meta=await call("get_creature_manual");
    assert.ok(!meta.isError);
    assert.ok(meta.structuredContent.meta.manual.includes("revision"));
    assert.equal(meta.structuredContent.meta.plugins.length,4);
    assert.equal(meta.structuredContent.meta.scenarios.length,3);
    const catalog=await call("list_creature_parts");
    assert.equal(catalog.structuredContent.parts.length,2);
    const practice=await call("run_coin_practice",{mine_pct:40,owl_pct:30,turtle_pct:20});
    assert.ok(!practice.isError);
    assert.equal(practice.structuredContent.result.initial_coins,10000);
    assert.equal(practice.structuredContent.result.steps,12);
    const pluginCatalog=await call("list_analysis_plugins");
    assert.equal(pluginCatalog.structuredContent.plugins.length,4);
    const roster=await call("get_character_lineup");
    assert.equal(roster.isError,undefined);
    assert.equal(roster.structuredContent.lineup.slots.length,2);
    const growth=await call("get_creature_growth");
    assert.ok(!growth.isError);
    assert.equal(growth.structuredContent.growth.slots.length,3);
    assert.equal(growth.structuredContent.growth.notice.includes("予測精度"),true);
    const challenges=await call("list_challenge_scenarios");
    assert.ok(!challenges.isError);
    assert.equal(challenges.structuredContent.scenarios.length,3);
    const challenge=await call("run_challenge_comparison",{scenario_id:"rising"});
    assert.ok(!challenge.isError);
    assert.equal(challenge.structuredContent.result.mode,"FIXED_SYNTHETIC_CHALLENGE_NOT_VALIDATION");
    assert.equal(challenge.structuredContent.result.steps,12);
    assert.equal(challenge.structuredContent.result.has_overall_winner,false);
    assert.equal(names.length,21);
    for(const base of Object.values(challenge.structuredContent.result.baselines)){
      assert.equal(base.history.length,12);
      assert.ok(Math.abs(Object.values(base.history[0].prediction).reduce((a,b)=>a+b,0)-1)<1e-12);
    }
    assert.equal(typeof challenge.structuredContent.result.contestants.mine.baseline_comparison.uniform.won_steps,"number");
    const savedModels=await call("list_saved_models");
    assert.ok(!savedModels.isError);
    assert.ok(Array.isArray(savedModels.structuredContent.versions));
    original=await state();
    current=original;

    const nextEye=eyes.find(x=>x!==current.visual.eye) || "owl";
    let edited=await call("set_eye",{eye:nextEye,expected_revision:current.revision});
    assert.equal(edited.isError,undefined);
    current=edited.structuredContent.state;
    assert.equal(current.visual.eye,nextEye);
    assert.equal(current.revision,original.revision+1);
    assert.equal(current.model.fast_window,nextEye==="falcon"?3:nextEye==="owl"?5:8);
    assert.ok(outcomeKeys.every(k=>typeof current.prediction[k]==="number"));

    edited=await call("set_shield",{risk_fraction:0.6,expected_revision:current.revision});
    assert.equal(edited.isError,undefined);
    current=edited.structuredContent.state;
    assert.equal(current.sample_coins_exposed,6000);
    assert.equal(current.model.risk_fraction,0.6);

    edited=await call("set_model_parameters",{
      fast_window:4,slow_window:13,risk_fraction:0.25,expected_revision:current.revision
    });
    assert.equal(edited.isError,undefined);
    current=edited.structuredContent.state;
    assert.equal(current.visual.eye,"custom");
    assert.equal(current.model.fast_window,4);
    assert.equal(current.model.slow_window,13);
    assert.equal(current.sample_coins_exposed,2500);
    assert.ok(current.python.includes("FAST_WINDOW = 4"));
    assert.ok(current.python.includes("SLOW_WINDOW = 13"));
    assert.deepEqual(current.prediction,(await state()).prediction);

    const oldPredict=current.prediction;
    edited=await call("set_analysis_plugins",{
      trend_pct:50,momentum_pct:30,volatility_pct:20,expected_revision:current.revision
    });
    assert.ok(!edited.isError);
    current=edited.structuredContent.state;
    assert.deepEqual(current.model.plugin_weights,{trend:50,momentum:30,volatility:20,reversion:0});
    assert.notDeepEqual(current.prediction,oldPredict);
    const badWeights=await call("set_analysis_plugins",{
      trend_pct:50,momentum_pct:50,volatility_pct:50,expected_revision:current.revision
    });
    assert.ok(badWeights.isError);
    assert.equal((await state()).revision,current.revision);

    edited=await call("configure_analysis_plugins",{
      weights:{trend:20,momentum:10,volatility:10,reversion:60},
      expected_revision:current.revision
    });
    assert.ok(!edited.isError);
    current=edited.structuredContent.state;
    assert.equal(current.model.plugin_weights.reversion,60);
    assert.equal(current.visual.dominant_plugin,"reversion");
    const missing=await call("configure_analysis_plugins",{
      weights:{trend:100,momentum:0,volatility:0},
      expected_revision:current.revision
    });
    assert.equal(missing.isError,true);
    assert.equal((await state()).revision,current.revision);
    edited=await call("set_plugin_strengths",{
      strengths:{trend:130,momentum:90,volatility:100,reversion:120},
      expected_revision:current.revision,
    });
    assert.ok(!edited.isError);
    current=edited.structuredContent.state;
    assert.equal(current.model.plugin_strengths.trend,130);
    const stale=await call("set_eye",{eye:"owl",expected_revision:original.revision});
    assert.equal(stale.isError,true);
    assert.match(stale.content[0].text,/revision|409/);
    assert.equal((await state()).revision,current.revision);

    const evil=await fetch(URL_MCP,{
      method:"POST",headers:{"Content-Type":"application/json","Origin":"https://evil.invalid"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})
    });
    assert.equal(evil.status,403);
    const health=await fetch("http://127.0.0.1:8766/health");
    assert.equal(health.status,200);
    assert.equal((await health.json()).localOnly,true);
    assert.ok((await fetch(URL_CORE)).ok);
  } finally {
    if(original){
      const fresh=await state();
      const restore=await call("set_model_parameters",{
        fast_window:original.model.fast_window,
        slow_window:original.model.slow_window,
        risk_fraction:original.model.risk_fraction,
        expected_revision:fresh.revision,
      });
      assert.ok(!restore.isError,`cleanup failed: ${JSON.stringify(restore)}`);
      const weights=original.model.plugin_weights;
      const back=await call("configure_analysis_plugins",{
        weights,expected_revision:restore.structuredContent.state.revision,
      });
      assert.ok(!back.isError,`plugin restore failed: ${JSON.stringify(back)}`);
      const oldStrengths=original.model.plugin_strengths;
      const backSettings=await call("set_plugin_strengths",{
        strengths:oldStrengths,expected_revision:back.structuredContent.state.revision
      });
      assert.ok(!backSettings.isError,`strength restore failed: ${JSON.stringify(backSettings)}`);
    }
    await client.close();
  }
});
