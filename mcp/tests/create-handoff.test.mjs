import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const draft='bp_'+'1'.repeat(32);
const version='tv_'+'2'.repeat(32);
const createHtml=await readFile(new URL('../../web/create.html',import.meta.url),'utf8');
const gameHtml=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
const gameScript=await readFile(new URL('../../game_runtime/demo.mjs',import.meta.url),'utf8');

class Element {
  constructor(tag='div') {
    this.tag=tag;this.children=[];this.handlers={};this.attributes={};this.files=[];
    this.textContent='';this.value='';this.disabled=false;this.hidden=false;this.style={};
    this.dataset={};this.open=false;
  }
  append(...items){this.children.push(...items)}
  prepend(item){this.children.unshift(item)}
  replaceChildren(...items){this.children=[...items]}
  addEventListener(name,fn){this.handlers[name]=fn}
  setAttribute(name,val){this.attributes[name]=val}
  async fire(name='click'){return this.handlers[name]?.()}
}
const all=root=>[root,...root.children.flatMap(all)];

test('creator generates a verified link only after saved training; listing also provides direct game handoff',async()=>{
  const nodes=new Map(),requests=[];
  const get=id=>{
    if(!nodes.has(id))nodes.set(id,new Element());
    return nodes.get(id);
  };
  const draftRecord={id:draft,title:'候補',reasoning:'テスト',
    blueprint:{engine_parameters:{plugin_weights:{trend:100},fast_window:3,slow_window:9,risk_fraction:.35}},
    capacity_parts:[{name:'トレンド',indicator_id:'trend'}],
    user_declared:{name:'星読み',concept:'',style:''}};
  const preview={scores:{trained_train_brier:.5,original_train_brier:.6,
    trained_validation_brier:.55,original_validation_brier:.62,uniform_brier:2/3},
    notice:'架空データのみ',engine_parameters:{},dataset:{},training_job:{}};
  const context={document:{getElementById:get,createElement:t=>new Element(t),
    querySelectorAll:()=>[...nodes.values()].flatMap(all).filter(e=>e.tag==='button')},
    fetch:async(path,options)=>{
      requests.push(path);
      let payload;
      if(path==='/api/blueprints')payload={drafts:[draftRecord]};
      else if(path==='/api/blueprints/train-preview')payload=preview;
      else if(path==='/api/blueprints/train-save')payload={version:{id:version,source_draft_id:draft}};
      else if(path==='/api/blueprints/trained')payload={versions:[{
        id:version,source_draft_id:draft,created_at:'today'}]};
      else throw Error('unexpected request '+path);
      return {ok:true,json:async()=>payload};
    },
  };
  const script=createHtml.split('<script>')[1].split('</script>')[0]
    .replace('Promise.all([gallery(),trained()]).catch(error=>status(error.message));','');
  runInNewContext(script,context);
  await runInNewContext('gallery()',context);
  await runInNewContext('trained()',context);
  const gallery=all(get('gallery'));
  assert.equal(requests.filter(x=>x==='/api/blueprints/train-save').length,0);
  const galleryTrain=gallery.find(n=>n.textContent==='架空データで学習して比較');
  await galleryTrain.onclick();
  assert.equal(requests.filter(x=>x==='/api/blueprints/train-save').length,0);
  const save=all(get('gallery')).find(n=>n.textContent==='練習版保存');
  assert.ok(save);
  await save.onclick();
  assert.equal(requests.filter(x=>x==='/api/blueprints/train-save').length,1);
  const expected='http://127.0.0.1:8898/game?trained_version_id='+version+'&draft_id='+draft;
  const links=all(get('gallery')).concat(all(get('trained'))).filter(n=>n.tag==='a');
  assert.ok(links.length>=2);
  assert.ok(links.every(link=>link.href===expected));
  assert.match(get('status').textContent,/リンクからゲームへ進めます/);
  const invalid=runInNewContext("gameHref('tv_../bad','bp_'+ '1'.repeat(32))",context);
  assert.equal(invalid,null);
  assert.match(createHtml,/Nodeゲームへ戻る/);
});

async function mountHandoff(search,versions){
  const nodes=new Map(),requests=[];
  const get=id=>{
    if(!nodes.has(id))nodes.set(id,new Element());
    return nodes.get(id);
  };
  const fetch=async path=>{
    requests.push(path);
    if(path==='/api/growth')return {ok:true,json:async()=>({
      revision:0,slots:[{slot:'mine',gear:'none',level:1,xp:0,
        gear_options:[{id:'none',icon:'·',name:'装備なし',unlocked:true}]}]})};
    if(path==='/api/companion')return {ok:true,json:async()=>({
      created:false,revision:0,companion:{name:'私の相棒',hair_color:'#8882db',
        clothing_color:'#92e1d4',approach:'trend',risk_percent:35}})};
    if(path==='/api/trained/versions')return {ok:true,json:async()=>({versions})};
    if(path==='/api/appearance/drafts')return {ok:true,json:async()=>({
      drafts:[{id:draft,name:'星読み',has_image:true}]})};
    throw Error('unexpected call '+path);
  };
  runInNewContext(gameScript,{document:{getElementById:get,createElement:t=>new Element(t)},
    fetch,window:{location:{search}},URLSearchParams});
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  return {get,requests};
}

test('valid creator link preselects trained brain and appearance without starting trading or claiming XP',async()=>{
  const {get,requests}=await mountHandoff('?trained_version_id='+version+'&draft_id='+draft,
    [{id:version,source_draft_id:draft,source_name:'星読み'}]);
  assert.equal(get('brainSelect').value,version);
  assert.equal(get('skinSelect').value,draft);
  assert.equal(get('portrait').src,'/api/appearance/image/'+draft);
  assert.equal(get('brainControls').open,true);
  assert.equal(get('skinControls').open,true);
  assert.equal(get('play').disabled,false);
  assert.equal(get('resetBrain').hidden,true);
  assert.match(get('brainNotice').textContent,/引き継ぎました/);
  assert.equal(requests.filter(x=>x==='/api/practice').length,0);
  assert.equal(requests.filter(x=>x==='/api/training/complete').length,0);
});

test('missing or mismatched version blocks play until explicit fallback',async()=>{
  for(const versions of [[],[{id:version,source_draft_id:'bp_'+'3'.repeat(32)}]]){
    const {get}=await mountHandoff('?trained_version_id='+version+'&draft_id='+draft,versions);
    assert.equal(get('play').disabled,true);
    assert.equal(get('resetBrain').hidden,false);
    assert.match(get('brainNotice').textContent,/存在しないか元の下書きが一致しません/);
    await get('resetBrain').fire();
    assert.equal(get('play').disabled,false);
    assert.equal(get('brainSelect').value,'');
  }
});

test('bad IDs are rejected without requesting a trained model',async()=>{
  const {get,requests}=await mountHandoff('?trained_version_id=tv_bad&draft_id='+draft,[]);
  assert.equal(get('play').disabled,true);
  assert.equal(get('resetBrain').hidden,false);
  assert.match(get('brainNotice').textContent,/IDが不正/);
  assert.equal(requests.includes('/api/trained/versions'),false);
  assert.match(gameHtml,/練習版を保存し/);
});
