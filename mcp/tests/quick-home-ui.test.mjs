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
    normal_profit_coins:25,normal_final_balance:10025,normal_max_drawdown_pct:1,
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
  assert.match(get('quickRisk').textContent,/×25.*約−4%.*投入分を失うおそれ/);
  assert.match(get('quickRisk').textContent,/手数料.*日次判定.*厳密な閾値ではありません/);
  await fire('quickForm','submit');
  assert.match(get('quickReviewText').textContent,/倍率：×25/);
  await fire('quickRun');
  assert.deepEqual(calls.at(-1).body,{model_id:'self',amount:1000,leverage:25});
  assert.match(get('quickResult').children[1].textContent,/通常（×1）の損益：/);
  assert.match(get('quickResult').children[1].textContent,/×25の損益：/);
  get('quickLeverage').value='26';
  await fire('quickLeverage','change');
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.equal(calls.filter(c=>c.path==='/api/quick-practice').length,1);
});

test('normal ×1 practice does not duplicate the comparison result in the UI',async()=>{
  const {get,fire}=await mount();
  assert.equal(get('quickLeverage').value,'1');
  await fire('quickForm','submit');
  await fire('quickRun');
  const summary=get('quickResult').children[1].textContent;
  assert.match(summary,/損益倍率：×1/);
  assert.doesNotMatch(summary,/通常（×1）の損益：/);
  assert.doesNotMatch(summary,/×25の損益：/);
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


test('shortcuts are native non-submit controls with accessible risk descriptions',()=>{
  for(const [id,label] of [['quickTen','10%'],['quickHalf','50%'],['quickAll','全額']]) {
    assert.match(html,new RegExp('<button id="'+id+'" type="button">'+label+'</button>'));
  }
  for(const id of ['quickAmount','quickLeverage']) {
    assert.match(html,new RegExp('id="'+id+'"[^>]*aria-describedby="[^"]*quickRisk'));
  }
});

test('initial risk, manual amount and every leverage update without submitting',async()=>{
  const {get,fire,calls}=await mount();
  assert.match(get('quickRisk').textContent,/練習用10,000 Cの10%（1,000C）.*最大損失は1,000C。この試算で投入しない残り9,000C/);
  assert.doesNotMatch(get('quickRisk').textContent,/所持|実残高|約|閾値/);
  get('quickAmount').value='2345';
  await fire('quickAmount','input');
  assert.match(get('quickRisk').textContent,/23.45%（2,345C）.*残り7,655C/);
  for(let leverage=1;leverage<=25;leverage++) {
    get('quickLeverage').value=String(leverage);
    await fire('quickLeverage','change');
    const risk=get('quickRisk').textContent;
    if(leverage===1)assert.doesNotMatch(risk,/約|閾値/);
    else {
      assert.ok(risk.includes('×'+leverage+'では1倍の基準損益が約−'+
        (100/leverage).toLocaleString('ja-JP',{maximumFractionDigits:2})+'%'));
      assert.match(risk,/基準運用の損失100%÷倍率.*手数料.*日次判定.*厳密な閾値ではありません/);
    }
    await fire('quickForm','submit');
    assert.equal(get('quickReviewRisk').textContent,risk);
    assert.match(get('quickReviewText').textContent,/使わないコイン：7,655 C。最大損失は2,345 C/);
  }
  assert.equal(calls.filter(c=>c.path==='/api/quick-practice').length,0);
});

test('each shortcut discards review even when unchanged and clears results without requesting',async()=>{
  const {get,fire,calls}=await mount();
  for(const [id,amount,percent,held] of [
    ['quickTen','1000','10','9,000'],['quickHalf','5000','50','5,000'],['quickAll','10000','100','0'],
  ]) {
    await fire(id);
    assert.equal(get('quickAmount').value,amount);
    assert.ok(get('quickRisk').textContent.includes('の'+percent+'%'));
    assert.ok(get('quickRisk').textContent.includes('この試算で投入しない残り'+held+'C'));
    await fire('quickForm','submit');
    const review=get('quickReviewText').textContent;
    assert.ok(review.includes('最大損失は'+Number(amount).toLocaleString('ja-JP')+' C'));
    assert.ok(review.includes('使わないコイン：'+held+' C'));
    assert.equal(get('quickReviewRisk').textContent,get('quickRisk').textContent);
    const before=calls.length;
    await fire(id); // Same value must still discard the pending confirmation.
    assert.equal(get('quickReview').hidden,true);
    await fire('quickRun');
    assert.equal(calls.length,before);
    await fire('quickForm','submit');
    await fire('quickRun');
    assert.equal(get('quickResult').hidden,false);
    const after=calls.length;
    await fire(id);
    assert.equal(get('quickResult').hidden,true);
    assert.equal(get('quickNext').hidden,true);
    await fire('quickRun');
    assert.equal(calls.length,after);
  }
});

test('manual edits and leverage changes clear completed results and pending confirmation',async()=>{
  for(const [id,event,value] of [['quickAmount','input','4321'],['quickLeverage','change','10']]) {
    const {get,fire,calls}=await mount();
    await fire('quickForm','submit');
    await fire('quickRun');
    assert.equal(get('quickResult').hidden,false);
    await fire('quickForm','submit');
    get(id).value=value;
    await fire(id,event);
    assert.equal(get('quickReview').hidden,true);
    assert.equal(get('quickResult').hidden,true);
    assert.equal(get('quickNext').hidden,true);
    await fire('quickRun');
    assert.equal(calls.filter(c=>c.path==='/api/quick-practice').length,1);
    assert.match(get('quickRisk').textContent,id==='quickAmount'?/43.21%/:/×10.*約−10%/);
  }
});

test('invalid risk hides numeric claims and shortcuts recover from input and API errors',async()=>{
  const {get,fire,state,calls}=await mount();
  for(const invalid of ['','0','10001','-1','1.2','1e3','NaN','<img src=x>']) {
    await fire('quickForm','submit');
    get('quickAmount').value=invalid;
    await fire('quickAmount','input');
    assert.match(get('quickRisk').textContent,/^入力値を確認してください/);
    assert.doesNotMatch(get('quickRisk').textContent,/最大損失|守られる/);
    await fire('quickRun');
  }
  assert.equal(calls.filter(c=>c.path==='/api/quick-practice').length,0);
  await fire('quickHalf');
  assert.equal(get('quickError').textContent,'');
  assert.equal(get('quickAmount').attributes['aria-invalid'],undefined);
  state.practice=async()=>({error:'通信エラー'});
  await fire('quickForm','submit');
  await fire('quickRun');
  for(const id of ['quickTen','quickHalf','quickAll'])assert.equal(get(id).disabled,false);
  await fire('quickTen');
  assert.match(get('quickRisk').textContent,/10%（1,000C）/);
  get('quickLeverage').value='26';
  await fire('quickLeverage','change');
  assert.match(get('quickRisk').textContent,/^入力値を確認してください/);
});

test('in-flight request disables all shortcuts and prevents double submission at 25x full stake',async()=>{
  const {get,fire,state,calls}=await mount();
  await fire('quickAll');
  get('quickLeverage').value='25';
  await fire('quickLeverage','change');
  await fire('quickForm','submit');
  const response=await state.practice({amount:10000,leverage:25});
  let finish;
  state.practice=()=>new Promise(resolve=>{finish=resolve;});
  const running=fire('quickRun');
  for(const id of ['quickTen','quickHalf','quickAll','quickAmount','quickLeverage','quickConfirm','quickRun']) {
    assert.equal(get(id).disabled,true);
  }
  const risk=get('quickRisk').textContent;
  for(const id of ['quickTen','quickHalf','quickAll'])await fire(id); // Defensive handler guard too.
  assert.equal(get('quickAmount').value,'10000');
  assert.equal(get('quickRisk').textContent,risk);
  await fire('quickRun');
  await fire('quickForm','submit');
  assert.deepEqual(calls.filter(c=>c.path==='/api/quick-practice'),[
    {path:'/api/quick-practice',body:{model_id:'self',amount:10000,leverage:25}},
  ]);
  finish(response);
  await running;
  for(const id of ['quickTen','quickHalf','quickAll'])assert.equal(get(id).disabled,false);
  await fire('quickRun');
  assert.equal(calls.filter(c=>c.path==='/api/quick-practice').length,1);
});
