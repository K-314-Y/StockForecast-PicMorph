import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const script=await readFile(new URL('../../game_runtime/quick-home.mjs',import.meta.url),'utf8');
const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');

async function mount(models=[]) {
  const nodes=new Map(),calls=[],scrolls=[];
  let document;
  class Element {
    constructor(tagName) {
      this.tagName=tagName.toUpperCase();
      this.children=[];this.handlers={};this.attributes={};
      this.textContent='';this._value='';this.hidden=false;this.open=false;this.disabled=false;
    }
    set innerHTML(value){throw Error('HTML insertion forbidden');}
    get value(){return this._value;}
    set value(value){this._value=String(value);}
    get selectedOptions(){return this.children.filter(option=>option.value===this.value);}
    setAttribute(key,value){this.attributes[key]=String(value);}
    removeAttribute(key){delete this.attributes[key];}
    addEventListener(name,handler){this.handlers[name]=handler;}
    replaceChildren(...children){this.children=children;if(this.tagName==='SELECT')this.value='';}
    append(...children){this.children.push(...children);}
    focus(){document.activeElement=this;}
    scrollIntoView(){scrolls.push(this);}
    async fire(name='click'){await this.handlers[name]?.({preventDefault(){}});}
  }
  for(const [,tag,attributes,id] of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const node=new Element(tag);
    node.hidden=/\bhidden(?:\s|$)/.test(attributes);
    node.open=/\bopen(?:\s|$)/.test(attributes);
    node.value=attributes.match(/\bvalue="([^"]*)"/)?.[1]||'';
    nodes.set(id,node);
  }
  document={getElementById:id=>nodes.get(id)||null,createElement:tag=>new Element(tag)};
  const state={models,practice:async body=>({
    mode:'SIMPLE_SYNTHETIC_PRACTICE_ONLY',real_market:false,persisted:false,
    invested_coins:body.amount,leverage:body.leverage,liquidated_at_step:null,
    final_balance:10025,profit_coins:25,max_drawdown_pct:1,
  })};
  const fetch=async(path,options)=>{
    const body=options?.body?JSON.parse(options.body):undefined;
    calls.push({path,body});
    if(path==='/api/model-shop')return {ok:true,json:async()=>({models:state.models})};
    assert.equal(path,'/api/quick-practice');
    assert.equal(options.method,'POST');
    const value=await state.practice(body);
    return {ok:!value.error,json:async()=>value};
  };
  runInNewContext(script,{document,fetch});
  await new Promise(resolve=>setImmediate(resolve));
  const get=id=>nodes.get(id);
  return {get,calls,scrolls,document,state,fire:(id,event)=>get(id).fire(event)};
}

test('shop and editor navigation opens details, scrolls and focuses the destination',async()=>{
  const {get,fire,scrolls,document}=await mount();
  for(const id of ['quickShop','quickNextShop']) {
    get('advancedEntry').open=false;
    await fire(id);
    assert.equal(get('advancedEntry').open,true);
    assert.equal(scrolls.at(-1),get('modelShopSection'));
    assert.equal(document.activeElement,get('modelShopTitle'));
    assert.equal(get('modelShopTitle').attributes.tabindex,'-1');
  }
  get('advancedEntry').open=false;
  get('companionControls').open=false;
  await fire('quickCustomize');
  assert.equal(get('advancedEntry').open,true);
  assert.equal(get('companionControls').open,true);
  assert.equal(scrolls.at(-1),get('companionEditorTitle'));
  assert.equal(document.activeElement,get('companionEditorTitle'));
  assert.equal(get('companionEditorTitle').attributes.tabindex,'-1');
});

test('both return buttons refresh owned AI choices and preserve the current selection',async()=>{
  const owned={id:'demo_one',name:'<img src=x onerror=alert(1)>',owned:true};
  const locked={id:'demo_two',name:'次のAI',owned:false};
  const {get,fire,state,calls,scrolls,document}=await mount([owned,locked]);
  get('quickModel').value=owned.id;
  get('quickAmount').value='2345';
  assert.deepEqual(get('quickModel').children.map(option=>option.value),['self',owned.id]);
  state.models=[owned,{...locked,owned:true}];
  await fire('shopReturn');
  assert.equal(scrolls.at(-1),get('simpleHome'));
  assert.equal(document.activeElement,get('quickModel'));
  assert.equal(get('quickModel').value,owned.id);
  assert.deepEqual(get('quickModel').children.map(option=>option.value),['self',owned.id,locked.id]);
  assert.equal(get('quickModel').children[1].textContent,owned.name+'（解放済み）');
  get('quickModel').value=locked.id;
  await fire('companionReturn');
  assert.equal(get('quickModel').value,locked.id);
  assert.equal(document.activeElement,get('quickModel'));
  assert.equal(get('quickAmount').value,'2345');
  assert.equal(calls.filter(call=>call.path==='/api/model-shop').length,3);
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.deepEqual(calls.at(-1),{path:'/api/quick-practice',body:{model_id:locked.id,amount:2345,leverage:1}});
  state.models=[owned];
  await fire('shopReturn');
  assert.equal(get('quickModel').value,'self');
});

test('successful practice shows next actions and retry keeps the amount and model',async()=>{
  const {get,fire,calls,document,scrolls}=await mount([{id:'demo',name:'デモ',owned:true}]);
  get('quickModel').value='demo';
  get('quickAmount').value='1234';
  await fire('quickForm','submit');
  assert.match(get('quickReviewText').textContent,/試算額：1,234 C/);
  await fire('quickRun');
  assert.equal(get('quickResult').hidden,false);
  assert.equal(get('quickNext').hidden,false);
  const result=get('quickResult').children.map(node=>node.textContent).join('\n');
  assert.match(result,/試算に使わないコイン/);
  assert.doesNotMatch(result,/現金待機|投資：/);
  assert.match(result,/実際の注文は行いません/);
  assert.match(result,/結果は保存されず/);
  assert.deepEqual(calls.at(-1).body,{model_id:'demo',amount:1234,leverage:1});
  await fire('quickAgain');
  assert.equal(get('quickNext').hidden,true);
  assert.equal(get('quickResult').hidden,true);
  assert.equal(get('quickReview').hidden,true);
  assert.equal(get('quickAmount').value,'1234');
  assert.equal(get('quickModel').value,'demo');
  assert.equal(scrolls.at(-1),get('simpleHome'));
  assert.equal(document.activeElement,get('quickAmount'));
  await fire('quickRun');
  assert.equal(calls.filter(call=>call.path==='/api/quick-practice').length,1);
});

test('new practice clears previous results immediately and errors leave next actions hidden',async()=>{
  const {get,fire,state}=await mount();
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.equal(get('quickNext').hidden,false);
  await fire('quickForm','submit');
  let finish;
  state.practice=()=>new Promise(resolve=>{finish=resolve;});
  const running=fire('quickRun');
  assert.equal(get('quickNext').hidden,true);
  assert.equal(get('quickResult').hidden,true);
  assert.equal(get('quickRun').disabled,true);
  finish({error:'<b>解放されていません</b>'});
  await running;
  assert.equal(get('quickNext').hidden,true);
  assert.equal(get('quickResult').hidden,true);
  assert.equal(get('quickRun').disabled,false);
  assert.equal(get('quickStatus').textContent,'試算できませんでした：<b>解放されていません</b>');
  state.practice=async()=>({mode:'LIVE',real_market:true,persisted:true});
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.equal(get('quickNext').hidden,true);
  assert.match(get('quickStatus').textContent,/結果の形式が不正/);
});

test('25x is selectable, displayed before confirmation, and locked for the request',async()=>{
  const {get,fire,calls}=await mount();
  assert.equal(get('quickLeverage').value,'1');
  assert.equal(get('quickLeverage').children.at(-1).value,'25');
  get('quickLeverage').value='25';
  await fire('quickLeverage','change');
  assert.match(get('quickLeverageHelp').textContent,/試算額が0/);
  await fire('quickForm','submit');
  assert.match(get('quickReviewText').textContent,/倍率：×25/);
  await fire('quickRun');
  assert.deepEqual(calls.at(-1).body,{model_id:'self',amount:1000,leverage:25});
  assert.match(get('quickResult').children[1].textContent,/倍率：×25/);
  get('quickLeverage').value='26';
  await fire('quickLeverage','change');
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.equal(calls.filter(c=>c.path==='/api/quick-practice').length,1);
});

test('invalid amounts cannot trigger practice requests',async()=>{
  const {get,fire,calls}=await mount();
  for(const amount of ['0','10001','1.2','1e3','-1','']) {
    get('quickAmount').value=amount;
    await fire('quickAmount','input');
    await fire('quickForm','submit');
    await fire('quickRun');
    assert.equal(get('quickAmount').attributes['aria-invalid'],'true');
    assert.equal(get('quickNext').hidden,true);
  }
  assert.equal(calls.filter(call=>call.path==='/api/quick-practice').length,0);
});
