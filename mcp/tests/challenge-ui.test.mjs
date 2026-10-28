import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {execFileSync} from "node:child_process";

test("challenge details render all rows, boundary scores, ties, and replace old results safely",()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.style={};this.attrs={};}
    appendChild(child){this.children.push(child);}
    replaceChildren(){this.children=[];}
    setAttribute(k,v){this.attrs[k]=v;}
  }
  const container=new Element("div");
  const source=readFileSync(new URL("../../web/game.html",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("function renderChallengeDetails"),source.indexOf("async function loadChallengeScenarios"));
  const context=vm.createContext({document:{createElement:t=>new Element(t),createElementNS:(_,t)=>new Element(t)},$:()=>container});
  vm.runInContext(code,context);
  const history=Array.from({length:12},(_,i)=>({step:i+1,observed_price:100,prediction:{UP:.5,FLAT:.5,DOWN:0},predicted:"UP",actual:i%2?"DOWN":"UP",brier:i%2?2:0}));
  context.data={flat_threshold_pct:.8,contestants:Object.fromEntries(["mine","owl","turtle"].map(k=>[k,{name:"<script>unsafe</script>",history}]))};
  vm.runInContext("renderChallengeDetails(data)",context);
  assert.equal(container.children.length,3);
  const all=e=>[e,...e.children.flatMap(all)];
  for(const panel of container.children){
    const elements=all(panel);
    assert.equal(panel.tag,"details");
    assert.equal(elements.filter(e=>e.tag==="tbody")[0].children.length,12);
    assert.equal(elements.filter(e=>e.textContent==="○").length,6);
    assert.equal(elements.filter(e=>e.textContent==="×").length,6);
    assert.equal(elements.filter(e=>e.tag==="script").length,0);
    const points=elements.find(e=>e.tag==="polyline").attrs.points.split(" ");
    assert.equal(points.length,12);
    assert.equal(points[0],"40,180");
    assert.equal(points.at(-1),"690,30");
  }
  vm.runInContext("renderChallengeDetails(data)",context);
  assert.equal(container.children.length,3);
  context.data=JSON.parse(execFileSync("python3",["-c",
    "import json; from challenge import run_challenge; from engine import Model; from game import PRESETS; print(json.dumps(run_challenge('rising', {'mine':Model(),**PRESETS})))"],
    {cwd:new URL("../../",import.meta.url),encoding:"utf8"}));
  vm.runInContext("renderChallengeDetails(data)",context);
  for(const [index,panel] of container.children.entries()){
    const elements=all(panel);
    assert.equal(elements.filter(e=>e.tag==="polyline").length,3);
    const bodies=elements.filter(e=>e.tag==="tbody");
    assert.equal(bodies.length,3);
    for(const body of bodies)assert.equal(body.children.length,12);
    for(const [b,base] of Object.values(context.data.baselines).entries()){
      base.history.forEach((row,i)=>{
        assert.equal(bodies[b+1].children[i].children[5].textContent,row.brier.toFixed(6));
        assert.equal(bodies[b+1].children[i].children[1].textContent,(row.prediction.UP*100).toFixed(2)+"%");
      });
    }
    assert.ok(elements.some(e=>String(e.textContent).includes("統計的優位性")));
  }
});
