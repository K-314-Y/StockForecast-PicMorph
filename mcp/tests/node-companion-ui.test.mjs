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
async function mount({created=false,beforeLoad,beforeSave}={}) {
  const nodes=new Map(),calls=[];
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  let saved={revision:created?1:0,created,companion:{...defaults}};
  const fetch=async(path,options)=>{
    const body=options?.body ? JSON.parse(options.body) : undefined;
    calls.push({path,body});
    let value;
    if(path==='/api/companion') {
      if(body) {
        await beforeSave?.();
        if(body.expected_revision!==saved.revision)
          return {ok:false,status:409,json:async()=>({error:'相棒が更新されています。再取得してください'})};
        saved={revision:saved.revision+1,created:true,companion:body.companion};
      } else await beforeLoad?.();
      value=JSON.parse(JSON.stringify(saved));
    } else if(path==='/api/growth') value={revision:0,slots:[{slot:'mine',level:1,xp:0,achievements:[]}]};
    else if(path==='/api/practice') value={mode:'PRACTICE_SYNTHETIC_ONLY',companion_name:saved.companion.name,
      companion_created:saved.created,companion_revision:saved.revision,approach:saved.companion.approach,
      risk_percent:saved.companion.risk_percent,final_coins:10000,profit_coins:0,max_drawdown_pct:0,
      decisions:Array.from({length:12},(_,i)=>({price:100+i,signals:{mine:'CASH'}})),equity_path:Array(13).fill(10000)};
    else if(path==='/api/appearance/drafts')value={drafts:[{id:'bp_'+'a'.repeat(32),name:'旧画像',has_image:true}]};
    else if(path==='/api/trained/versions')value={versions:[]};
    else throw Error('unexpected '+path);
    return {ok:true,json:async()=>value};
  };
  get('adventureMode').value='solo';
  runInNewContext(script,{document:{getElementById:get,createElement:()=>new Element()},fetch});
  await new Promise(r=>setImmediate(r));
  return {get,calls,fire:(id,event)=>get(id).fire(event),
    updateSaved:edits=>{saved={revision:saved.revision+1,created:true,companion:{...saved.companion,...edits}};}};
}
const companionWrites=calls=>calls.filter(call=>call.path==='/api/companion'&&call.body).map(call=>call.body);

test('initial companion restores form and permits default play without silently saving',async()=>{
  const {get,calls,fire}=await mount();
  assert.equal(get('creatorName').value,defaults.name);
  assert.equal(get('creatorRisk').value,'35');
  assert.match(get('brainStatus').textContent,/未作成/);
  assert.equal(get('saveAppearanceBasics').disabled,false);
  assert.equal(get('saveCompanion').disabled,false);
  await fire('play');
  assert.match(get('resultCompanion').textContent,/未作成の標準モデル/);
  assert.equal(calls.filter(c=>c.path==='/api/companion'&&c.body).length,0);
});
test('each submit merges the latest saved fields and keeps the other form draft visible',async()=>{
  const {get,calls,fire}=await mount();
  const name='<b>私の子</b>';
  get('creatorName').value=name;get('creatorHair').value='#112233';get('creatorClothing').value='#445566';
  get('creatorApproach').value='momentum';get('creatorRisk').value='75';
  await fire('creatorName','input');
  await fire('creatorRisk','input');
  assert.equal(get('companionName').textContent,name);
  assert.match(get('chibi').attributes.style,/--hair:#112233;--clothing:#445566/);
  assert.match(get('creatorPreview').textContent,/勢い.*75%/);
  assert.match(get('brainStatus').textContent,/未作成/);
  assert.equal(calls.filter(c=>c.body).length,0);
  await fire('play');
  assert.match(get('resultCompanion').textContent,/未作成/);
  await fire('appearanceBasicsForm','submit');
  const appearance={name,hair_color:'#112233',clothing_color:'#445566'};
  assert.deepEqual(companionWrites(calls),[{expected_revision:0,companion:{...defaults,...appearance}}]);
  assert.match(get('appearanceBasicsStatus').textContent,/保存しました/);
  assert.match(get('companionStatus').textContent,/まだ保存されていません/);
  assert.equal(get('creatorApproach').value,'momentum');
  assert.equal(get('creatorRisk').value,'75');
  await fire('play');
  assert.match(get('resultCompanion').textContent,/revision 1.*トレンド.*35%/);

  get('creatorName').value='未保存の外見';get('creatorHair').value='#001122';get('creatorClothing').value='#334455';
  await fire('creatorClothing','input');
  await fire('companionForm','submit');
  const prediction={approach:'momentum',risk_percent:75};
  assert.deepEqual(companionWrites(calls)[1],{expected_revision:1,companion:{...appearance,...prediction}});
  assert.match(get('companionStatus').textContent,/保存しました/);
  assert.match(get('appearanceBasicsStatus').textContent,/まだ保存されていません/);
  assert.equal(get('creatorName').value,'未保存の外見');
  assert.equal(get('creatorHair').value,'#001122');
  assert.equal(get('creatorClothing').value,'#334455');
  assert.equal(get('companionName').textContent,'未保存の外見');
  assert.match(get('chibi').attributes.style,/--hair:#001122;--clothing:#334455/);
  await fire('play');
  assert.match(get('resultTitle').textContent,/<b>私の子<\/b>/);
  assert.match(get('resultCompanion').textContent,/revision 2.*勢い.*75%.*反映/);
  assert.match(get('speech').textContent,/<b>私の子<\/b>/);
  const practice=calls.filter(c=>c.path==='/api/practice');
  assert.ok(practice.every(c=>JSON.stringify(c.body)==='{"allocations":{"mine":100,"owl":0,"turtle":0}}'));

  await fire('loadBrains');
  assert.equal(get('creatorName').value,'未保存の外見');
  await fire('appearanceBasicsForm','submit');
  assert.deepEqual(companionWrites(calls)[2],{expected_revision:2,companion:{
    name:'未保存の外見',hair_color:'#001122',clothing_color:'#334455',...prediction}});
  assert.equal(companionWrites(calls).length,3);
});
test('both forms report a 409 locally, keep drafts, and only retry after an explicit reload and submit',async()=>{
  for(const [form,status,otherStatus,reload] of [
    ['appearanceBasicsForm','appearanceBasicsStatus','companionStatus','reloadAppearanceBasics'],
    ['companionForm','companionStatus','appearanceBasicsStatus','reloadCompanion'],
  ]) {
    const {get,fire,calls,updateSaved}=await mount({created:true});
    updateSaved({name:'別の画面で保存',approach:'volatility'});
    get('creatorName').value='未保存';await fire('creatorName','input');
    get('creatorRisk').value='80';await fire('creatorRisk','input');
    await fire(form,'submit');
    assert.match(get(status).textContent,/保存できません.*再取得/);
    assert.match(get(otherStatus).textContent,/まだ保存されていません/);
    assert.equal(get('creatorName').value,'未保存');
    assert.equal(get('creatorRisk').value,'80');
    assert.match(get('brainStatus').textContent,/私の相棒.*revision 1/);
    assert.deepEqual(companionWrites(calls).map(body=>body.expected_revision),[1]);
    assert.equal(calls.filter(call=>call.path==='/api/companion'&&!call.body).length,1);

    await fire(reload);
    if (form === 'appearanceBasicsForm') {
      assert.equal(get('creatorName').value,'別の画面で保存');
      assert.equal(get('creatorApproach').value,'trend'); // other group's draft is retained
      assert.equal(get('creatorRisk').value,'80');
    } else {
      assert.equal(get('creatorName').value,'未保存'); // other group's draft is retained
      assert.equal(get('creatorApproach').value,'volatility');
      assert.equal(get('creatorRisk').value,'35');
    }
    assert.equal(companionWrites(calls).length,1);
    await fire(form,'submit');
    assert.deepEqual(companionWrites(calls).map(body=>body.expected_revision),[1,2]);
  }
});
test('initial load and a pending save block submissions from both forms',async()=>{
  let finishLoad,finishSave;
  const load=new Promise(resolve=>{finishLoad=resolve;});
  const saving=new Promise(resolve=>{finishSave=resolve;});
  const {get,fire,calls}=await mount({beforeLoad:()=>load,beforeSave:()=>saving});
  const assertDisabled=expected=>{
    assert.equal(get('saveAppearanceBasics').disabled,expected);
    assert.equal(get('saveCompanion').disabled,expected);
  };
  assertDisabled(true);
  await fire('appearanceBasicsForm','submit');
  await fire('companionForm','submit');
  assert.equal(companionWrites(calls).length,0);
  finishLoad();
  await new Promise(resolve=>setImmediate(resolve));
  assertDisabled(false);
  const submit=fire('appearanceBasicsForm','submit');
  assertDisabled(true);
  await fire('appearanceBasicsForm','submit');
  await fire('companionForm','submit');
  assert.equal(companionWrites(calls).length,1);
  finishSave();
  await submit;
  assertDisabled(false);
});
test('prediction edits and saves keep the selected image while appearance edits preview the chibi',async()=>{
  const {get,fire}=await mount({created:true});
  await fire('loadSkins');get('skinSelect').value='bp_'+'a'.repeat(32);await fire('skinSelect','change');
  const late=get('portrait').onload;
  late();assert.equal(get('chibi').hidden,true);
  get('creatorRisk').value='50';await fire('creatorRisk','input');
  await fire('companionForm','submit');
  assert.equal(get('skinSelect').value,'bp_'+'a'.repeat(32));
  assert.equal(get('chibi').hidden,true);
  assert.equal(get('portrait').hidden,false);
  get('creatorHair').value='#123456';await fire('creatorHair','input');
  late();assert.equal(get('chibi').hidden,false);assert.equal(get('portrait').hidden,true);
  assert.equal(get('skinSelect').value,'');
  assert.match(get('brainStatus').textContent,/保存済み/);
});
test('creator screen has responsive CSS, labelled fields, text-only input rendering and Official notice',()=>{
  for(const id of ['creatorName','creatorHair','creatorClothing','creatorApproach','creatorRisk']) {
    assert.match(html,new RegExp('for="'+id+'"'));assert.match(html,new RegExp('id="'+id+'"'));
  }
  const namePattern=html.match(/id="creatorName"[^>]*pattern="([^"]+)"/)[1];
  const validName=new RegExp('^(?:'+namePattern+')$','v');
  assert.equal(validName.test('🌱'.repeat(16)),true);
  for(const invalid of ['', '　 ', '🌱'.repeat(17), '名前\t'])assert.equal(validName.test(invalid),false);
  assert.match(html,/var\(--hair\)/);assert.match(html,/var\(--clothing\)/);
  assert.match(html,/株価予測の判断ルール/);assert.match(html,/V6の学習済みOfficialは書き換えません/);
  assert.match(html,/保存した設定だけ/);assert.doesNotMatch(script,/innerHTML|localStorage/);
});
