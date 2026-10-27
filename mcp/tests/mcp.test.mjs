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
    for(const name of ["get_creature_state","list_creature_parts","set_eye","set_shield","set_model_parameters","run_coin_practice","list_saved_models","save_current_model","load_saved_model"]){
      assert.ok(names.includes(name),`missing tool: ${name}`);
    }
    const catalog=await call("list_creature_parts");
    assert.equal(catalog.structuredContent.parts.length,2);
    const practice=await call("run_coin_practice",{mine_pct:40,owl_pct:30,turtle_pct:20});
    assert.ok(!practice.isError);
    assert.equal(practice.structuredContent.result.initial_coins,10000);
    assert.equal(practice.structuredContent.result.steps,12);
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
    }
    await client.close();
  }
});
