import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio bridge exposes same manual & tools; no extra HTTP server", async()=>{
  const client=new Client({name:"creature-stdio-test",version:"0.1.0"});
  const transport=new StdioClientTransport({
    command:process.execPath,
    args:[fileURLToPath(new URL("../stdio.mjs", import.meta.url))],
    env:{...process.env,CREATURE_LAB_STDIO:"1"},
  });
  try{
    await client.connect(transport);
    const tools=await client.listTools();
    const names=tools.tools.map(t=>t.name);
    for(const name of ["get_creature_manual","get_creature_state",
                       "list_analysis_plugins","run_challenge_comparison"]){
      assert.ok(names.includes(name),name);
    }
    const manual=await client.callTool({name:"get_creature_manual",arguments:{}});
    assert.ok(!manual.isError);
    assert.ok(manual.structuredContent.meta.manual.includes("revision"));
    assert.equal(manual.structuredContent.meta.plugins.length,4);
    const state=await client.callTool({name:"get_creature_state",arguments:{}});
    assert.ok(!state.isError);
    assert.equal(typeof state.structuredContent.state.revision,"number");
  }finally{
    await transport.close();
  }
});
