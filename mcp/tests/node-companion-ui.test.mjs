import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const script=await readFile(new URL('../../game_runtime/demo.mjs',import.meta.url),'utf8');
const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
const defaults={name:'私の相棒',hair_color:'#8882db',clothing_color:'#92e1d4',approach:'trend',risk_percent:35};
class Element {
  constructor(){this.handlers={};this.children=[];this.attributes={};this.dataset={};this.value='';this.textContent='';}
  set innerHTML(value){throw Error('HTML insertion forbidden');}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,fn){this.handlers[key]=fn;}
  replaceChildren(...nodes){this.children=nodes;}
  append(node){this.children.push(node);}
  async fire(name='click'){await this.handlers[name]?.({preventDefault(){}});}
}
async function mount({created=false,conflict=false}={}) {
  const nodes=new Map(),calls=[];
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  let saved={revision:created?1:0,created,companion:{...defaults}};
  const fetch=async(path,options)=>{
    const body=options?.body ? JSON.parse(options.body) : undefined;
    calls.push({path,body});
    let value;
    if(path==='/api/companion') {
      if(body) {
        if(conflict)return {ok:false,json:async()=>({error:'相棒が更新されています。再取得してください'})};
        assert.equal(body.expected_revision,saved.revision);
        saved={revision:saved.revision+1,created:true,companion:body.companion};
      }
      value=JSON.parse(JSON.stringify(saved));
    } else if(path==='/api/growth') value={revision:0,slots:[{slot:'mine',level:1,xp:0,gear:'none',gear_options:[]}]};
    else if(path==='/api/practice') value={mode:'PRACTICE_SYNTHETIC_ONLY',companion_name:saved.companion.name,
      companion_created:saved.created,companion_revision:saved.revision,approach:saved.companion.approach,
      risk_percent:saved.companion.risk_percent,final_coins:10000,profit_coins:0,max_drawdown_pct:0,
      decisions:Array.from({length:12},(_,i)=>({price:100+i,signals:{mine:'CASH'}})),equity_path:Array(13).fill(10000)};
    else if(path==='/api/appearance/drafts')value={drafts:[{id:'bp_'+'a'.repeat(32),name:'旧画像',has_image:true}]};
    else throw Error('unexpected '+path);
    return {ok:true,json:async()=>value};
  };
  get('adventureMode').value='solo';
  runInNewContext(script,{document:{getElementById:get,createElement:()=>new Element()},fetch});
  await new Promise(r=>setImmediate(r));
  return {get,calls,fire:(id,event)=>get(id).fire(event)};
}
test('initial companion restores form and permits default play without silently saving',async()=>{
  const {get,calls,fire}=await mount();
  assert.equal(get('creatorName').value,defaults.name);
  assert.equal(get('creatorRisk').value,'35');
  assert.match(get('brainStatus').textContent,/未作成/);
  assert.equal(get('saveCompanion').disabled,false);
  await fire('play');
  assert.match(get('resultCompanion').textContent,/未作成の標準モデル/);
  assert.equal(calls.filter(c=>c.path==='/api/companion'&&c.body).length,0);
});
test('creator chooses all fields; preview never saves; only saved settings appear in practice results',async()=>{
  const {get,calls,fire}=await mount();
  const name='<b>私の子</b>';
  get('creatorName').value=name;get('creatorHair').value='#112233';get('creatorClothing').value='#445566';
  get('creatorApproach').value='momentum';get('creatorRisk').value='75';
  await fire('creatorName','input');
  assert.equal(get('companionName').textContent,name);
  assert.match(get('chibi').attributes.style,/--hair:#112233;--clothing:#445566/);
  assert.match(get('creatorPreview').textContent,/勢い.*75%/);
  assert.match(get('brainStatus').textContent,/未作成/);
  assert.equal(calls.filter(c=>c.body).length,0);
  await fire('play');
  assert.match(get('resultCompanion').textContent,/未作成/);
  await fire('companionForm','submit');
  const save=calls.find(c=>c.path==='/api/companion'&&c.body);
  assert.deepEqual(save.body,{expected_revision:0,companion:{name,hair_color:'#112233',clothing_color:'#445566',approach:'momentum',risk_percent:75}});
  await fire('play');
  assert.match(get('resultTitle').textContent,/<b>私の子<\/b>/);
  assert.match(get('resultCompanion').textContent,/revision 1.*勢い.*75%.*反映/);
  assert.match(get('speech').textContent,/<b>私の子<\/b>/);
  const practice=calls.filter(c=>c.path==='/api/practice');
  assert.ok(practice.every(c=>JSON.stringify(c.body)==='{"allocations":{"mine":100,"owl":0,"turtle":0}}'));
});
test('stale save retains preview and saved rules; explicit reload restores saved fields',async()=>{
  const {get,fire}=await mount({created:true,conflict:true});
  get('creatorName').value='未保存';await fire('creatorName','input');
  await fire('companionForm','submit');
  assert.match(get('companionStatus').textContent,/保存できません.*再取得/);
  assert.equal(get('creatorName').value,'未保存');
  assert.match(get('brainStatus').textContent,/私の相棒/);
  await fire('reloadCompanion');assert.equal(get('creatorName').value,'私の相棒');
});
test('editing switches from DRAFT image to custom chibi and invalidates late image load',async()=>{
  const {get,fire}=await mount({created:true});
  await fire('loadSkins');get('skinSelect').value='bp_'+'a'.repeat(32);await fire('skinSelect','change');
  const late=get('portrait').onload;
  late();assert.equal(get('chibi').hidden,true);
  get('creatorHair').value='#123456';await fire('creatorHair','input');
  late();assert.equal(get('chibi').hidden,false);assert.equal(get('portrait').hidden,true);
  assert.equal(get('skinSelect').value,'');
  assert.match(get('brainStatus').textContent,/保存済み/);
});
test('creator screen has responsive CSS, labelled fields, text-only input rendering and Official notice',()=>{
  for(const id of ['creatorName','creatorHair','creatorClothing','creatorApproach','creatorRisk']) {
    assert.match(html,new RegExp('for="'+id+'"'));assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/var\(--hair\)/);assert.match(html,/var\(--clothing\)/);
  assert.match(html,/私の相棒を作る/);assert.match(html,/V6の学習済みOfficialは書き換えません/);
  assert.match(html,/保存した設定だけ/);assert.doesNotMatch(script,/innerHTML|localStorage/);
});
