import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const script=await readFile(new URL('../../game_runtime/quick-home.mjs',import.meta.url),'utf8');
const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');

async function mount(models=[]) {
  const nodes=new Map(),calls=[],scrolls=[],storageWrites=[];
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
    focus(options){document.activeElement=this;this.focusOptions=options;}
    blur(){if(document.activeElement===this)document.activeElement=null;}
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
    daily_balances:[10000,10010,9995,10000,10005,10010,10015,10020,10010,10015,10020,10030,10025],
    daily_ai_signals:Array.from({length:12},(_,i)=>i%2===0?'LONG':'CASH'),
    daily_synthetic_prices:[100,110,99,105,100,110,99,105,100,110,99,105,100],
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
  const storage={
    getItem:()=>null,
    setItem:(...args)=>storageWrites.push(['setItem',...args]),
    removeItem:(...args)=>storageWrites.push(['removeItem',...args]),
    clear:()=>storageWrites.push(['clear']),
  };
  const context={document,fetch,localStorage:storage,sessionStorage:storage};
  context.window=context;
  runInNewContext(script,context);
  await new Promise(resolve=>setImmediate(resolve));
  const get=id=>nodes.get(id);
  return {get,calls,scrolls,storageWrites,document,state,fire:(id,event)=>get(id).fire(event)};
}

// Track actual HTML ancestry so a closed advanced panel cannot hide the scene.
function htmlNodes() {
  const stack=[],nodes=[];
  const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
  for(const match of html.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    const [,closing,tag,attributes]=match;
    if(closing){assert.equal(stack.pop()?.tag,tag);continue;}
    const node={tag,id:attributes.match(/\bid="([^"]+)"/)?.[1],attributes,
      parents:stack.map(parent=>parent.id),offset:match.index};
    nodes.push(node);
    if(!voidTags.has(tag))stack.push(node);
  }
  assert.equal(stack.length,0);
  return nodes;
}

test('the single original scene is the first game panel, outside advanced training',()=>{
  const nodes=htmlNodes();
  const get=id=>nodes.find(node=>node.id===id);
  const front=get('frontCharacter');
  assert.equal(front.tag,'section');
  assert.deepEqual(front.parents,[undefined,undefined,undefined]); // html > body > main
  assert.doesNotMatch(front.attributes,/\bhidden\b/);
  assert.equal(nodes.find(node=>node.tag==='section').id,'frontCharacter');
  assert.ok(front.offset<get('scene').offset);
  assert.ok(get('scene').offset<get('simpleHome').offset);
  assert.ok(get('simpleHome').offset<get('advancedEntry').offset);
  for(const id of ['scene','companionName','speech','chibi','portrait','artworkStage',
    'artworkBase','artworkOutfit','artworkFace','artworkHair','skinCaption']) {
    assert.equal(nodes.filter(node=>node.id===id).length,1,id);
    assert.ok(get(id).parents.includes('frontCharacter'),id);
    assert.ok(!get(id).parents.includes('advancedEntry'),id);
    if(id!=='scene')assert.ok(get(id).parents.includes('scene'),id);
  }
  const buttons=nodes.filter(node=>node.tag==='button'&&node.parents.includes('frontCharacter'));
  assert.deepEqual(buttons.map(node=>node.id),['quickCustomize','quickArtwork']);
  for(const button of buttons)assert.match(button.attributes,/type="button"/);
  for(const id of ['quickModel','quickAmount','quickLeverage','quickReplay'])
    assert.ok(get(id).parents.includes('simpleHome'),id);
  for(const id of ['play','companionControls','artworkControls','artworkWorkshop','brainControls',
    'modelLabSection','modelShopSection','arenaSection','growthInfo'])
    assert.ok(get(id).parents.includes('advancedEntry'),id);
  assert.match(html,/未保存時はデモchibi。SAVEした完成イラスト（base）は再読込後も表示/);
  assert.match(html,/髪・顔・服は任意の追加レイヤー。画像選択は仮表示、各SAVEで保存/);
});

test('both front editing actions precede the short save explanation',()=>{
  const nodes=htmlNodes();
  const front=nodes.filter(node=>node.parents.includes('frontCharacter'));
  const heading=front.find(node=>node.id==='frontCharacterTitle');
  const paragraphs=front.filter(node=>node.tag==='p'&&node.offset>heading.offset);
  assert.equal(paragraphs.length,2);
  for(const id of ['quickCustomize','quickArtwork']) {
    assert.equal(nodes.filter(node=>node.id===id).length,1,id);
    const button=front.find(node=>node.id===id);
    assert.equal(button.tag,'button');
    assert.match(button.attributes,/type="button"/);
    assert.ok(button.offset>heading.offset);
    assert.ok(button.offset<paragraphs[0].offset,id+' must be before explanatory copy');
  }
  const copy=html.slice(paragraphs[0].offset,html.indexOf('</section>',paragraphs[0].offset));
  assert.ok(copy.replace(/<[^>]*>/g,'').trim().length<=120,'keep the front hint short');
});

test('front actions reuse editor and artwork navigation, focus without saves or mutations',async()=>{
  const {get,fire,calls,storageWrites,scrolls,document}=await mount();
  const before=calls.slice();
  for(const [button,target,opened] of [
    ['quickCustomize','companionEditorTitle',['advancedEntry','companionControls']],
    ['quickArtwork','artworkTitle',['advancedEntry','artworkControls','artworkWorkshop']],
  ]) {
    for(const id of opened)get(id).open=false;
    await fire(button);
    for(const id of opened)assert.equal(get(id).open,true);
    assert.equal(document.activeElement,get(target));
    assert.equal(get(target).focusOptions.preventScroll,true);
    assert.equal(scrolls.at(-1),get(target==='artworkTitle'?'artworkControls':target));
    assert.deepEqual(calls,before);
    assert.deepEqual(storageWrites,[]);
  }
  assert.match(script,/element\('quickCustomize'\)\.addEventListener\('click',openEditor\)/);
  assert.match(script,/element\('quickArtwork'\)\.addEventListener\('click',openArtwork\)/);
});

test('front layout stacks on mobile, wraps long text and keeps native focus and touch targets',()=>{
  assert.match(html,/\.hero\{display:block;min-inline-size:0\}/);
  assert.match(html,/\.front-character\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(html,/@media\(max-width:680px\)\{\s*\.front-character\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(html,/\.front-character>\*\{min-inline-size:0\}/);
  assert.match(html,/\.front-character-copy\{overflow-wrap:anywhere\}/);
  assert.match(html,/\.front-character \.actions button\{max-inline-size:100%;white-space:normal\}/);
  assert.match(html,/button\{[^}]*min-height:44px/);
  assert.match(html,/button:focus-visible[^}]*outline:3px/);
  assert.match(html,/\.actions\{[^}]*flex-wrap:wrap/);
});

test('mobile front stage overrides desktop spacing while allowing speech and font scaling to grow',()=>{
  const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const mobile=css.slice(css.indexOf('@media(max-width:680px){'),css.indexOf('\n.scene{'));
  // Match the desktop selector specificity: a generic .scene mobile rule loses to it.
  assert.match(mobile,/\.front-character \.scene\{min-height:275px;padding:10px 12px\}/);
  assert.match(mobile,/\.front-character \.speech\{margin:0 0 8px;padding:8px 12px;min-height:0\}/);
  assert.match(mobile,/\.front-character \.scene>h2\{[^}]*overflow-wrap:anywhere;max-width:100%/);
  assert.match(mobile,/\.front-character #artworkStage\{width:min\(150px,100%\)\}/);
  assert.match(mobile,/\.front-character \.scene>:is\(#chibi,#artworkStage,#portrait\)\{flex-shrink:0\}/);
  assert.doesNotMatch(mobile,/(?:^|[;{])(?:height|max-height):/);
  assert.doesNotMatch(css,/position:\s*(?:fixed|sticky)/);
});

test('mobile creator select can shrink within its grid without clipping the page',()=>{
  const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const mobile=css.slice(css.indexOf('@media(max-width:680px){'),css.indexOf('\n.scene{'));
  const rule=mobile.match(/\.creator-grid select\{([^}]+)\}/)?.[1];
  assert.ok(rule,'constrain the native select only at mobile widths');
  const declarations=Object.fromEntries(rule.split(';').map(part=>part.split(':').map(s=>s.trim())));
  assert.equal(declarations['min-width'],'0');
  assert.equal(declarations.width,'100%');
  assert.equal(declarations['box-sizing'],'border-box');
  assert.doesNotMatch(css,/overflow-x:\s*(?:hidden|clip)/);
  assert.match(css,/\.creator-grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  const select=html.match(/<select id="creatorApproach"[^>]*>[\s\S]*?<\/select>/)[0];
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]),
    ['trend','momentum','reversion','volatility']);
  assert.doesNotMatch(select,/\b(?:disabled|hidden)\b/);
});

test('practice heading connects the companion to twelve days and retains the standard AI fallback',()=>{
  assert.match(html,/<h2 id="simpleHomeTitle">この相棒と12日間を練習<\/h2>/);
  assert.match(html,/<select id="quickModel"[^>]*>[\s\S]*?<option value="self">自分のAI（未作成なら標準AI）<\/option>/);
});

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

test('artwork shortcut expands the workshop and returns to practice without requests or form changes',async()=>{
  const {get,fire,calls,scrolls,document}=await mount();
  assert.match(html,/<button id="quickArtwork" type="button"[^>]*>キャラの見た目を作る<\/button>/);
  assert.match(html,/id="quickCustomize"[^>]*>自分のAIを作る・編集する/);
  get('quickAmount').value='2345';
  get('quickLeverage').value='3';
  await fire('quickForm','submit');
  const priorCalls=calls.length;
  for(let attempt=0;attempt<2;attempt++) {
    for(const id of ['advancedEntry','artworkControls','artworkWorkshop'])get(id).open=false;
    await fire('quickArtwork');
    for(const id of ['advancedEntry','artworkControls','artworkWorkshop'])assert.equal(get(id).open,true);
    assert.equal(scrolls.at(-1),get('artworkControls'));
    assert.equal(document.activeElement,get('artworkTitle'));
    assert.equal(get('artworkTitle').attributes.tabindex,undefined); // summary keeps its native Tab stop.
    await fire('artworkReturn');
    assert.equal(scrolls.at(-1),get('simpleHome'));
    assert.equal(document.activeElement,get('quickModel'));
  }
  assert.equal(calls.length,priorCalls);
  assert.equal(get('quickAmount').value,'2345');
  assert.equal(get('quickLeverage').value,'3');
  assert.equal(get('quickReview').hidden,false);
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

test('growth bridge after practice only opens, scrolls and focuses the existing start button',async()=>{
  const {get,fire,calls,scrolls,storageWrites,document}=await mount([{id:'demo',name:'デモ',owned:true}]);
  assert.equal(get('quickNext').hidden,true);
  get('quickModel').value='demo';
  get('quickAmount').value='1000';
  get('quickLeverage').value='3';
  await fire('quickForm','submit');
  await fire('quickRun');
  await fire('quickFollowing');
  assert.equal(get('quickNext').hidden,false);
  assert.deepEqual(calls,[
    {path:'/api/model-shop',body:undefined},
    {path:'/api/quick-practice',body:{model_id:'demo',amount:1000,leverage:3}},
  ]);
  const priorCalls=calls.slice();
  const preserved=['quickModel','quickAmount','quickLeverage','quickResult','quickReplay',
    'quickReplayDay','quickReview','quickNext','growthInfo','growthAchievements','reward','claim','play'];
  const snapshot=()=>preserved.map(id=>{
    const node=get(id);
    return {id,value:node.value,text:node.textContent,hidden:node.hidden,disabled:node.disabled,
      children:node.children.map(child=>child.textContent)};
  });
  const before=snapshot();
  let starts=0,claims=0;
  get('play').addEventListener('click',()=>{starts++;});
  get('claim').addEventListener('click',()=>{claims++;});
  for(let attempt=0;attempt<2;attempt++) {
    get('advancedEntry').open=false;
    await fire('quickGrow');
    await fire('advancedEntry','toggle'); // Opening details must not refresh models either.
    assert.equal(get('advancedEntry').open,true);
    assert.equal(scrolls.at(-1),get('play'));
    assert.equal(document.activeElement,get('play'));
    assert.equal(get('play').focusOptions.preventScroll,true);
    assert.equal(get('play').attributes.tabindex,undefined); // Keep the native button's Tab stop.
    assert.deepEqual(snapshot(),before);
    assert.deepEqual(calls,priorCalls);
    assert.deepEqual(storageWrites,[]);
    assert.equal(starts,0);
    assert.equal(claims,0);
  }
});

test('growth bridge uses a native button with adjacent XP and synthetic practice boundaries',()=>{
  const next=html.match(/<div id="quickNext" hidden>([\s\S]*?)<p id="quickStatus"/)[1];
  assert.match(next,/<button id="quickGrow"[^>]*type="button"[^>]*aria-controls="advancedEntry"[^>]*aria-describedby="quickGrowthHelp">相棒を育てる冒険へ<\/button>/);
  assert.match(next,/id="quickGrowthHelp"[^>]*>今回のかんたん練習ではXPは増えません。別の「詳しい機能」の練習で課題を達成し、「XPを受け取る」を押すと、課題ごとに一度だけXPを獲得できます。XPとレベル、達成した課題を冒険記録で確認できます。/);
  assert.doesNotMatch(next,/装備|focus_lens|spark_charm|calm_halo/);
  assert.match(next,/どちらも架空相場の練習で、実相場の予測力を示すものではありません。/);
  for(const id of ['quickAgain','quickNextShop'])assert.ok(next.includes('id="'+id+'"'));
  assert.match(html,/<button id="claim" type="button" class="primary" disabled>XPを受け取る<\/button>/);
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

test('daily replay navigates all 13 full balances with signed changes and endpoint controls',async()=>{
  const {get,fire}=await mount();
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.equal(get('quickReplay').hidden,false);
  assert.equal(get('quickPrevious').disabled,true);
  assert.equal(get('quickFollowing').disabled,false);
  assert.match(get('quickReplayDay').textContent,/第0日.*全残高：10,000 C.*累計損益：\+0 C.*前日比：算出できません/);
  assert.match(get('quickReplayContext').textContent,/開始前.*AI判断なし.*架空の開始価格：100/);
  await fire('quickPrevious');
  assert.match(get('quickReplayDay').textContent,/第0日/);
  await fire('quickFollowing');
  assert.match(get('quickReplayDay').textContent,/第1日.*10,010 C.*累計損益：\+10 C.*前日比：\+10 C/);
  assert.match(get('quickReplayContext').textContent,/AIの方針：株を持つ.*架空の終値：110.*株価の前日終値比：\+10.00%/);
  await fire('quickFollowing');
  assert.match(get('quickReplayDay').textContent,/第2日.*9,995 C.*累計損益：-5 C.*前日比：-15 C/);
  assert.match(get('quickReplayContext').textContent,/AIの方針：現金で待機.*架空の終値：99.*株価の前日終値比：-10.00%/);
  for(let day=3;day<=12;day++) {
    await fire('quickFollowing');
    assert.ok(get('quickReplayDay').textContent.includes('第'+day+'日'));
    assert.ok(get('quickReplayContext').textContent.includes(day%2?'株を持つ':'現金で待機'));
  }
  assert.match(get('quickReplayDay').textContent,/第12日.*10,025 C/);
  assert.equal(get('quickFollowing').disabled,true);
  await fire('quickFollowing');
  assert.match(get('quickReplayDay').textContent,/第12日/);
  await fire('quickPrevious');
  assert.match(get('quickReplayDay').textContent,/第11日/);
  assert.equal(get('quickFollowing').disabled,false);
});

test('25x replay shows liquidation only from its day and preserves uninvested cash',async()=>{
  const {get,fire,state}=await mount();
  const practice=state.practice;
  state.practice=async body=>({...await practice(body),final_balance:9000,profit_coins:-1000,
    liquidated_at_step:2,daily_balances:[10000,9500,...Array(11).fill(9000)]});
  get('quickLeverage').value='25';
  await fire('quickLeverage','change');
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.doesNotMatch(get('quickReplayDay').textContent,/尽きました/);
  await fire('quickFollowing');
  assert.doesNotMatch(get('quickReplayDay').textContent,/尽きました/);
  await fire('quickFollowing');
  assert.match(get('quickReplayDay').textContent,/全残高：9,000 C.*累計損益：-1,000 C.*前日比：-500 C.*投入した資金は尽きました.*投入しなかった残高は9,000 C残っています/);
  assert.match(get('quickReplayContext').textContent,/AIの方針：現金で待機.*この日の終値で投入資金の運用は強制終了/);
  for(let day=3;day<=12;day++) {
    await fire('quickFollowing');
    assert.match(get('quickReplayContext').textContent,/強制終了後なので、この日のAIの方針は運用に使われていません.*架空の終値/);
    assert.doesNotMatch(get('quickReplayContext').textContent,/AIの方針：/);
    assert.match(get('quickReplayDay').textContent,/全残高：9,000 C/);
  }
  assert.match(get('quickReplayDay').textContent,/第12日.*9,000 C.*前日比：\+0 C.*尽きました/);
});

test('malformed daily balances reject the entire result',async()=>{
  const {get,fire,state}=await mount();
  const valid=await state.practice({amount:1000,leverage:1});
  const path=valid.daily_balances;
  for(const daily_balances of [undefined,null,{},'bad',[],path.slice(1),[...path,10025],
    [9999,...path.slice(1)],[...path.slice(0,12),10025.02],
    ...[NaN,Infinity,-1,'10000',Number.MAX_SAFE_INTEGER+1,undefined].map(n=>
      path.map((v,i)=>i===5?n:v)),Array(13)]) {
    state.practice=async()=>({...valid,daily_balances});
    await fire('quickForm','submit');
    await fire('quickRun');
    assert.match(get('quickStatus').textContent,/結果の形式が不正/);
    assert.equal(get('quickResult').hidden,true);
    assert.equal(get('quickNext').hidden,true);
    assert.equal(get('quickReplay').hidden,true);
    assert.equal(get('quickReplayDay').textContent,'');
    for(const id of ['quickBestDay','quickWorstDay'])assert.equal(get(id).disabled,true);
  }
});

test('input, model, leverage, shortcuts, new practice and retry clear replay state',async()=>{
  for(const [id,event] of [['quickAmount','input'],['quickModel','change'],
    ['quickLeverage','change'],['quickTen','click'],['quickHalf','click'],
    ['quickAll','click'],['quickForm','submit'],['quickAgain','click']]) {
    const {get,fire,document}=await mount();
    await fire('quickForm','submit');
    await fire('quickRun');
    await fire('quickFollowing');
    get('quickBestDay').focus();
    await fire(id,event);
    assert.notEqual(document.activeElement,get('quickBestDay'));
    for(const [button,label] of [['quickBestDay','一番増えた日'],['quickWorstDay','一番減った日']]) {
      assert.equal(get(button).disabled,true);
      assert.equal(get(button).textContent,label);
      await fire(button);
    }
    assert.equal(get('quickReplay').hidden,true,id);
    assert.equal(get('quickReplayDay').textContent,'',id);
    assert.equal(get('quickReplayContext').textContent,'',id);
    assert.equal(get('quickPrevious').disabled,true);
    assert.equal(get('quickFollowing').disabled,true);
    await fire('quickFollowing');
    assert.equal(get('quickReplayDay').textContent,'');
    await fire('quickForm','submit');
    await fire('quickRun');
    assert.match(get('quickReplayDay').textContent,/第0日/);
  }
});

test('invalid signals and synthetic prices reject the entire result and clear context',async()=>{
  const {get,fire,state}=await mount();
  const valid=await state.practice({amount:1000,leverage:1});
  for(const [field,badValues] of [
    ['daily_ai_signals',[undefined,null,{},'LONG',[],Array(11).fill('LONG'),Array(13).fill('CASH'),
      Array(12),...['BUY','long',1,null,'<img src=x>'].map(v=>valid.daily_ai_signals.map((x,i)=>i===3?v:x))]],
    ['daily_synthetic_prices',[undefined,null,{},'100',[],Array(12).fill(100),Array(14).fill(100),
      Array(13),...[0,-1,NaN,Infinity,1e12+1,'100',null,undefined].map(v=>valid.daily_synthetic_prices.map((x,i)=>i===3?v:x))]],
  ]) for(const bad of badValues) {
    state.practice=async()=>valid;
    await fire('quickForm','submit');
    await fire('quickRun');
    await fire('quickFollowing');
    assert.notEqual(get('quickReplayContext').textContent,'');
    state.practice=async()=>({...valid,[field]:bad});
    await fire('quickForm','submit');
    await fire('quickRun');
    assert.match(get('quickStatus').textContent,/練習結果の形式が不正です/);
    for(const id of ['quickReplay','quickResult','quickNext'])assert.equal(get(id).hidden,true);
    assert.equal(get('quickReplayContext').textContent,'');
  }
  state.practice=async()=>({error:'通信エラー'});
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.equal(get('quickReplayContext').textContent,'');
});

test('replay highlights are result-only native buttons and jump using full wallet deltas',async()=>{
  const {get,fire,calls,storageWrites}=await mount();
  for(const id of ['quickBestDay','quickWorstDay']) {
    assert.match(html,new RegExp('<button id="'+id+'" type="button"[^>]* disabled>'));
    assert.equal(get(id).disabled,true);
    await fire(id);
  }
  assert.equal(get('quickReplay').hidden,true);
  assert.match(html,/role="group" aria-label="残高の名場面"/);
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.equal(get('quickBestDay').textContent,'一番増えた日：第1日（+10 C）');
  assert.equal(get('quickWorstDay').textContent,'一番減った日：第2日（-15 C）');
  const count=calls.length,summary=get('quickResult').children[1].textContent;
  await fire('quickWorstDay');
  assert.match(get('quickReplayDay').textContent,/第2日.*前日比：-15 C/);
  assert.match(get('quickReplayContext').textContent,/現金で待機.*終値：99/);
  await fire('quickBestDay');
  assert.match(get('quickReplayDay').textContent,/第1日.*前日比：\+10 C/);
  assert.equal(get('quickPrevious').disabled,false);
  assert.equal(get('quickFollowing').disabled,false);
  await fire('quickPrevious');
  assert.match(get('quickReplayDay').textContent,/第0日/);
  assert.equal(get('quickBestDay').disabled,false);
  await fire('quickWorstDay');
  assert.match(get('quickReplayDay').textContent,/第2日/);
  assert.equal(calls.length,count);
  assert.equal(calls.filter(c=>c.path==='/api/quick-practice').length,1);
  assert.equal(get('quickAmount').value,'1000');
  assert.equal(get('quickModel').value,'self');
  assert.equal(get('quickResult').children[1].textContent,summary);
  assert.deepEqual(storageWrites,[]);
});

test('wallet highlights cover ties, missing signs, day12 and liquidation cutoff at 25x',async()=>{
  const {get,fire,state,calls}=await mount();
  const valid=await state.practice({amount:1000,leverage:25});
  get('quickLeverage').value='25';
  await fire('quickLeverage','change');
  const cases=[
    {balances:[10000,10015,10000,10015,10000,...Array(8).fill(10000)],best:1,worst:2},
    {balances:Array.from({length:13},(_,i)=>10000+i),best:1,worst:null},
    {balances:Array.from({length:13},(_,i)=>10000-i),best:null,worst:1},
    {balances:Array(13).fill(10000),best:null,worst:null},
    {balances:[...Array(12).fill(10000),10020],best:12,worst:null},
    {balances:[...Array(12).fill(10000),9980],best:null,worst:12},
    // Deliberately larger post-liquidation moves must never become highlights.
    {balances:[10000,10005,9995,11000,9000,...Array(8).fill(9000)],stop:2,best:1,worst:2},
    {balances:[10000,9990,11000,...Array(10).fill(9000)],stop:1,best:null,worst:1},
  ];
  for(const {balances,stop=null,best,worst} of cases) {
    state.practice=async()=>({...valid,daily_balances:balances,
      final_balance:balances[12],profit_coins:balances[12]-10000,liquidated_at_step:stop});
    await fire('quickForm','submit');
    await fire('quickRun');
    const before=calls.length;
    for(const [id,day,missing,label] of [
      ['quickBestDay',best,'増えた日なし','一番増えた日'],
      ['quickWorstDay',worst,'減った日なし','一番減った日'],
    ]) {
      assert.equal(get(id).disabled,day===null);
      if(day===null) {
        assert.equal(get(id).textContent,missing);
        const text=get('quickReplayDay').textContent;
        await fire(id);
        assert.equal(get('quickReplayDay').textContent,text);
      } else {
        const delta=balances[day]-balances[day-1];
        assert.equal(get(id).textContent,label+'：第'+day+'日（'+(delta>0?'+':'')+delta+' C）');
        await fire(id);
        assert.ok(get('quickReplayDay').textContent.startsWith('第'+day+'日'));
        assert.equal(get('quickPrevious').disabled,false);
        assert.equal(get('quickFollowing').disabled,day===12);
      }
    }
    assert.equal(calls.length,before);
    assert.equal(get('quickLeverage').value,'25');
  }
});

test('replay highlights clear during retry and after API or validation errors',async()=>{
  const {get,fire,state}=await mount();
  const valid=await state.practice({amount:1000,leverage:1});
  for(const failure of [{error:'通信エラー'},{...valid,daily_balances:[]},
    {...valid,liquidated_at_step:1.5}]) {
    state.practice=async()=>valid;
    await fire('quickForm','submit');
    await fire('quickRun');
    assert.equal(get('quickBestDay').disabled,false);
    await fire('quickForm','submit');
    let finish;
    state.practice=()=>new Promise(resolve=>{finish=resolve;});
    const running=fire('quickRun');
    assert.equal(get('quickReplay').hidden,true);
    for(const id of ['quickBestDay','quickWorstDay'])assert.equal(get(id).disabled,true);
    finish(failure);
    await running;
    assert.equal(get('quickBestDay').textContent,'一番増えた日');
    assert.equal(get('quickWorstDay').textContent,'一番減った日');
    for(const id of ['quickBestDay','quickWorstDay']) {
      assert.equal(get(id).disabled,true);
      await fire(id);
    }
    assert.equal(get('quickReplay').hidden,true);
    assert.equal(get('quickReplayDay').textContent,'');
  }
});
