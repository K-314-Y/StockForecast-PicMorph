import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const script=await readFile(new URL('../../game_runtime/quick-home.mjs',import.meta.url),'utf8');
const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');

async function mount(models=[],chatgpt=false) {
  const nodes=new Map(),calls=[],scrolls=[],storageWrites=[],copies=[];
  let observeSource=()=>{};
  let document;
  class Element {
    constructor(tagName) {
      this.tagName=tagName.toUpperCase();
      this.children=[];this.handlers={};this.attributes={};this.dataset={};
      this.textContent='';this._value='';this.checked=false;this.hidden=false;this.open=false;this.disabled=false;
      this.complete=false;this.naturalWidth=0;this.style={};this.srcAssignments=0;
    }
    set innerHTML(value){throw Error('HTML insertion forbidden');}
    get value(){return this._value;}
    set value(value){this._value=String(value);}
    get selectedOptions(){return this.children.filter(option=>option.value===this.value);}
    get src(){return this.getAttribute('src')||'';}
    set src(value){this.setAttribute('src',value);}
    getAttribute(key){return this.attributes[key]??null;}
    setAttribute(key,value){
      this.attributes[key]=String(value);
      if(key==='src' && this.tagName==='IMG'){
        this.complete=false;this.naturalWidth=0;this.srcAssignments++;
      }
    }
    removeAttribute(key){delete this.attributes[key];if(key==='src'){this.complete=false;this.naturalWidth=0;}}
    addEventListener(name,handler){this.handlers[name]=handler;}
    replaceChildren(...children){this.children=children;if(this.tagName==='SELECT')this.value='';}
    append(...children){this.children.push(...children);}
    focus(options){document.activeElement=this;this.focusOptions=options;}
    blur(){if(document.activeElement===this)document.activeElement=null;}
    scrollIntoView(){scrolls.push(this);}
    async fire(name='click'){
      if(this.tagName==='IMG' && (name==='load'||name==='error')){
        this.complete=true;this.naturalWidth=name==='load'?150:0;
      }
      await this.handlers[name]?.({preventDefault(){}});
    }
  }
  for(const [,tag,attributes,id] of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const node=new Element(tag);
    node.hidden=/\bhidden(?:\s|$)/.test(attributes);
    node.open=/\bopen(?:\s|$)/.test(attributes);
    node.value=attributes.match(/\bvalue="([^"]*)"/)?.[1]||'';
    if(id==='quickChatGPTConnection')node.dataset.chatgptSession=chatgpt==='session'?'enabled':'disabled';
    if(id==='quickChatGPT')node.dataset.chatgptDialogue=chatgpt?'enabled':'disabled';
    nodes.set(id,node);
  }
  document={getElementById:id=>nodes.get(id)||null,createElement:tag=>new Element(tag)};
  const state={models,session:async()=>({connected:true,sharing:true}),dialogue:async()=>({status:'ok',commentary:'何を重視しましたか？'}),practice:async body=>({
    mode:'SIMPLE_SYNTHETIC_PRACTICE_ONLY',real_market:false,persisted:false,
    scenario_token:body.scenario_token??'v1_0123456789abcdef',
    scenario_kind:body.scenario_token?'replay':'new',
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
    if(path==='/api/chatgpt-session'){
      assert.equal(options?.method??'GET','GET');
      assert.equal(body,undefined);
      return {ok:true,json:async()=>state.session(options)};
    }
    if(path==='/api/chatgpt-dialogue'){
      const value=await state.dialogue(body,options);
      return {ok:value.status==='ok',json:async()=>value};
    }
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
  state.copy=async text=>{copies.push(text);};
  state.navigator={clipboard:{writeText:text=>state.copy(text)}};
  const context={document,fetch,AbortController,setTimeout,clearTimeout,localStorage:storage,sessionStorage:storage,
    navigator:state.navigator,
    getComputedStyle:node=>({display:'block',visibility:'visible',opacity:'1',...node.style}),
    MutationObserver:class {
      constructor(callback){observeSource=callback;}
      observe(target,options){assert.equal(target,nodes.get('scene'));assert.equal(options.subtree,true);}
    }};
  const windowHandlers={};
  context.addEventListener=(event,handler)=>{windowHandlers[event]=handler;};
  context.window=context;
  runInNewContext(script,context);
  await new Promise(resolve=>setImmediate(resolve));
  const get=id=>nodes.get(id);
  return {get,calls,scrolls,storageWrites,copies,document,state,sourceChanged:()=>observeSource(),
    pagehide:()=>windowHandlers.pagehide?.(),
    fire:(id,event)=>get(id).fire(event)};
}

// Track actual HTML ancestry so a closed advanced panel cannot hide the scene.
function htmlNodes() {
  const stack=[],nodes=[];
  const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
  for(const match of html.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    const [,closing,tag,attributes]=match;
    if(closing){assert.equal(stack.pop()?.tag,tag);continue;}
    const node={tag,id:attributes.match(/\bid="([^"]+)"/)?.[1],attributes,
      parents:stack.map(parent=>parent.id),ancestorAttributes:stack.map(parent=>parent.attributes),offset:match.index};
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
    'artworkBase','artworkOutfit','artworkFace','artworkHair','skinCaption','generatedAvatar']) {
    assert.equal(nodes.filter(node=>node.id===id).length,1,id);
    assert.ok(get(id).parents.includes('frontCharacter'),id);
    assert.ok(!get(id).parents.includes('advancedEntry'),id);
    if(id!=='scene')assert.ok(get(id).parents.includes('scene'),id);
  }
  const buttons=nodes.filter(node=>node.tag==='button'&&node.parents.includes('frontCharacter'));
  assert.deepEqual(buttons.map(node=>node.id),['generatedAvatarPause','quickArtwork','quickCustomize','hatchIdleToggle','hatchPartsToggle']);
  for(const button of buttons)assert.match(button.attributes,/type="button"/);
  for(const id of ['quickModel','quickAmount','quickLeverage','quickReplay'])
    assert.ok(get(id).parents.includes('simpleHome'),id);
  for(const id of ['play','companionControls','artworkControls','artworkWorkshop','brainControls',
    'modelLabSection','modelShopSection','arenaSection','growthInfo'])
    assert.ok(get(id).parents.includes('advancedEntry'),id);
  assert.match(html,/未保存時はデモchibi。SAVEした完成イラスト（base）は再読込後も表示/);
  assert.match(html,/髪・顔・服は任意の追加レイヤー。画像選択は仮表示、各SAVEで保存/);
});

test('advanced entry groups appearance and prediction in separate disclosures and forms',()=>{
  const nodes=htmlNodes();
  const get=id=>nodes.find(node=>node.id===id);
  for(const [studio,contents] of [
    ['appearanceStudio',['appearanceBasicsForm','lookControls','artworkControls','artworkWorkshop','skinControls']],
    ['predictionStudio',['companionControls','companionForm','brainControls']],
  ]) {
    assert.equal(get(studio).tag,'details');
    assert.equal(get(studio).parents.at(-1),'advancedEntry');
    assert.match(get(studio).attributes,/name="creator-studio"/);
    assert.doesNotMatch(get(studio).attributes,/\bopen\b/);
    for(const id of contents) {
      assert.deepEqual(get(id).parents.filter(parent=>parent?.endsWith('Studio')),[studio],id);
    }
  }
  for(const [form,fields,save] of [
    ['appearanceBasicsForm',['creatorName','creatorHair','creatorClothing'],'saveAppearanceBasics'],
    ['companionForm',['creatorApproach','creatorRisk'],'saveCompanion'],
  ]) {
    assert.equal(get(form).tag,'form');
    assert.doesNotMatch(get(form).attributes,/\bnovalidate\b/);
    const controls=nodes.filter(node=>node.parents.includes(form) && /^creator(?:Name|Hair|Clothing|Approach|Risk)$/.test(node.id));
    assert.deepEqual(controls.map(node=>node.id),fields);
    assert.ok(get(save).parents.includes(form));
    assert.match(get(save).attributes,/type="submit"/);
  }
  assert.ok(get('companionReturn').parents.includes('companionForm'));
  for(const id of ['play','quickForm','modelLabSection','modelShopSection'])
    assert.ok(!get(id).parents.some(parent=>parent?.endsWith('Studio')),id);
});

test('advanced mode starts collapsed and easy practice leaves it collapsed',async()=>{
  const advanced=htmlNodes().find(node=>node.id==='advancedEntry');
  assert.equal(advanced.tag,'details');
  assert.doesNotMatch(advanced.attributes,/\bopen\b/);
  const {get,fire}=await mount();
  assert.equal(get('advancedEntry').open,false);
  for(const id of ['frontCharacter','simpleHome'])assert.equal(get(id).hidden,false);
  await fire('quickForm','submit');await fire('quickRun');
  assert.equal(get('quickResult').hidden,false);
  assert.equal(get('advancedEntry').open,false);
});

test('stage and checkpoint animations target the visible character group or CSS features',()=>{
  assert.match(html,/<div id="scene" class="scene" data-mood="ready">/);
  assert.match(html,/\.scene > :is\(#chibi,#artworkStage,#portrait\):not\(\[hidden\]\)\{[^}]*animation:companion-idle/);
  assert.match(html,/\[data-mood="ready"\] #chibi:not\(\[hidden\]\) \.eye\{animation:companion-blink/);
  for(const mood of ['thinking','happy','cautious','growth']) {
    assert.ok(html.includes(`[data-mood="${mood}"] #chibi .mouth{`));
    assert.ok(html.includes(`[data-mood="${mood}"] .scene-mood [data-for="${mood}"]`));
  }
  for(const css of html.matchAll(/([^{}]*artworkStage[^{}]*)\{([^{}]*)\}/g))
    if(/animation:|transform:/.test(css[2]))assert.doesNotMatch(css[1],/\bimg\b|#artwork(?:Base|Hair|Face|Outfit)/);
  for(const keyframes of ['companion-idle','companion-blink','companion-growth','checkpoint-hover','checkpoint-hop','checkpoint-settle'])
    assert.ok(html.includes('@keyframes '+keyframes));
  const reducedMotion=html.match(/@media\(prefers-reduced-motion:reduce\)\{([\s\S]+?)\n\}/)?.[1];
  assert.match(reducedMotion,/data-growing="true"/);
  assert.match(reducedMotion,/#chibi:not\(\[hidden\]\) \.eye/);
  assert.match(reducedMotion,/#quickPreCueIcon\{animation:none;transition:none\}/);
});

test('both front editing actions precede the short save explanation',()=>{
  const nodes=htmlNodes();
  const front=nodes.filter(node=>node.parents.includes('frontCharacter'));
  const heading=front.find(node=>node.id==='frontCharacterTitle');
  const paragraphs=front.filter(node=>node.tag==='p'&&node.offset>heading.offset);
  assert.equal(paragraphs.length,2);
  for(const [id,studio] of [['quickCustomize','predictionStudio'],['quickArtwork','appearanceStudio']]) {
    assert.equal(nodes.filter(node=>node.id===id).length,1,id);
    const button=front.find(node=>node.id===id);
    assert.equal(button.tag,'button');
    assert.match(button.attributes,/type="button"/);
    assert.ok(button.attributes.includes('aria-controls="'+studio+'"'));
    assert.ok(front.some(node=>node.id===id+'Help'));
    assert.ok(button.attributes.includes('aria-describedby="'+id+'Help"'));
    assert.ok(button.offset>heading.offset);
    assert.ok(button.offset<paragraphs[0].offset,id+' must be before explanatory copy');
  }
  const copy=html.slice(paragraphs[0].offset,html.indexOf('</section>',paragraphs[0].offset));
  assert.ok(copy.replace(/<[^>]*>/g,'').trim().length<=120,'keep the front hint short');
});

test('front actions reuse editor and artwork navigation, focus without saves or mutations',async()=>{
  const {get,fire,calls,storageWrites,scrolls,document}=await mount();
  const before=calls.slice();
  for(const [button,target,studio,closed,children] of [
    ['quickCustomize','companionEditorTitle','predictionStudio','appearanceStudio',['companionControls']],
    ['quickArtwork','appearanceStudioTitle','appearanceStudio','predictionStudio',[]],
    ['switchToPrediction','companionEditorTitle','predictionStudio','appearanceStudio',['companionControls']],
    ['switchToAppearance','appearanceStudioTitle','appearanceStudio','predictionStudio',[]],
  ]) {
    const opened=['advancedEntry',studio,...children];
    for(const id of opened)get(id).open=false;
    get(closed).open=true;
    await fire(button);
    for(const id of opened)assert.equal(get(id).open,true);
    if(studio==='appearanceStudio') {
      assert.equal(get('lookControls').open,false,'look edit stays collapsed until requested');
      assert.equal(get('artworkControls').open,false,'artwork edit stays collapsed until requested');
    }
    assert.equal(get(closed).open,false);
    assert.equal(get('artworkWorkshop').open,false);
    assert.equal(document.activeElement,get(target));
    assert.equal(get(target).focusOptions.preventScroll,true);
    assert.equal(get(target).getAttribute('tabindex'),null);
    assert.equal(scrolls.at(-1),get(studio));
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
  assert.match(mobile,/\.front-character \.scene>:is\(#chibi,#artworkStage,#portrait,#generatedAvatar\)\{flex-shrink:0\}/);
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
  assert.equal(scrolls.at(-1),get('predictionStudio'));
  assert.equal(document.activeElement,get('companionEditorTitle'));
});

test('artwork shortcut opens only the top-level artwork tools and returns without requests or form changes',async()=>{
  const {get,fire,calls,scrolls,document}=await mount();
  assert.match(html,/<button id="quickArtwork" type="button"[^>]*>外見を選ぶ・作る<\/button>/);
  assert.match(html,/id="quickCustomize"[^>]*>株価予測のAIを作る/);
  get('quickAmount').value='2345';
  get('quickLeverage').value='3';
  get('artworkBase').src='blob:unsaved-selection';
  get('artworkFileBase').value='selected.png';
  await fire('quickForm','submit');
  const priorCalls=calls.length;
  for(let attempt=0;attempt<2;attempt++) {
    const opened=['advancedEntry','appearanceStudio'];
    for(const id of [...opened,'lookControls','artworkControls'])get(id).open=false;
    await fire('quickArtwork');
    for(const id of opened)assert.equal(get(id).open,true);
    assert.equal(get('lookControls').open,false);
    assert.equal(get('artworkControls').open,false);
    assert.equal(get('artworkWorkshop').open,false);
    assert.equal(scrolls.at(-1),get('appearanceStudio'));
    assert.equal(document.activeElement,get('appearanceStudioTitle'));
    await fire('artworkReturn');
    assert.equal(scrolls.at(-1),get('simpleHome'));
    assert.equal(document.activeElement,get('quickModel'));
    assert.equal(get('artworkBase').src,'blob:unsaved-selection');
    assert.equal(get('artworkFileBase').value,'selected.png');
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
    assert.equal(get('quickTacticsDay').textContent,'',id);
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
    assert.equal(get('quickTacticsDay').textContent,'');
  }
  state.practice=async()=>({error:'通信エラー'});
  await fire('quickForm','submit');
  await fire('quickRun');
  assert.equal(get('quickReplayContext').textContent,'');
  assert.equal(get('quickTacticsDay').textContent,'');
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
    {...valid,liquidated_at_step:1.5},{...valid,normal_profit_coins:NaN}]) {
    state.practice=async()=>valid;
    await fire('quickForm','submit');
    await fire('quickRun');
    assert.equal(get('quickBestDay').disabled,false);
    await fire('quickForm','submit');
    let finish;
    state.practice=()=>new Promise(resolve=>{finish=resolve;});
    const running=fire('quickRun');
    assert.equal(get('quickTacticsDay').textContent,'');
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
    assert.equal(get('quickTacticsDay').textContent,'');
  }
});


test('result voice follows best/worst clicks without model-name spoofing, requests or persistence',async()=>{
  const name='<img src=x onerror=alert(1)>自作キャラ';
  for(const model of ['self','owned']) {
    const {get,fire,calls,storageWrites}=await mount([{id:'owned',name,owned:true}]);
    assert.equal(get('quickReplay').hidden,true);
    assert.equal(get('quickTacticsDay').textContent,'');
    assert.equal(get('quickTacticsSummary'),undefined);
    assert.doesNotMatch(script+html,/方向に合った|逆方向|summarizeTactics|quickTacticsSummary/);
    assert.match(html,/<p id="quickTacticsDay" aria-label="振り返りメモ"><\/p>/);
    get('quickModel').value=model;
    get('quickAmount').value='2345';
    await fire('quickForm','submit');
    await fire('quickRun');
    assert.equal(get('quickTacticsDay').textContent,'さあ、12日間の作戦を一緒に振り返ろう！');
    const before=calls.length;
    await fire('quickBestDay');
    assert.equal(get('quickTacticsDay').textContent,'やった！ここが一番残高の増えた日だね。');
    await fire('quickWorstDay'); // CASH + falling price still has a full-wallet loss.
    assert.equal(get('quickTacticsDay').textContent,'うわっ、ここが一番残高の減った日だね…。');
    assert.match(get('quickReplayDay').textContent,/前日比：-15 C/);
    for(let day=3;day<=12;day++)await fire('quickFollowing');
    assert.doesNotMatch(get('quickTacticsDay').textContent,/自作キャラ|<img|損失なし|必ず利益/);
    assert.equal(calls.length,before);
    assert.equal(calls.filter(c=>c.path==='/api/quick-practice').length,1);
    assert.deepEqual(storageWrites,[]);
    assert.equal(get('quickModel').value,model);
    assert.equal(get('quickAmount').value,'2345');
  }
});

test('voice distinguishes original price direction and flat days independently of wallet',async()=>{
  const {get,fire,state}=await mount();
  const valid=await state.practice({amount:1000,leverage:1});
  state.practice=async()=>({...valid,final_balance:10000,profit_coins:0,
    daily_balances:Array(13).fill(10000),
    daily_synthetic_prices:[100,110,100,100,90,100,100,100+1e-12,100,100,100,100,100],
    daily_ai_signals:['LONG','LONG','LONG','CASH','CASH','CASH','LONG','CASH','LONG','CASH','LONG','CASH']});
  await fire('quickForm','submit');await fire('quickRun');
  const expected=[
    '方針は「株を持つ」。架空の価格は前日より上がったね。',
    '方針は「株を持つ」。架空の価格は前日より下がったね。',
    '今日は値動きがなかったね。',
    '方針は「現金で待機」。架空の価格は前日より下がったね。',
    '方針は「現金で待機」。架空の価格は前日より上がったね。',
    '今日は値動きがなかったね。',
    '方針は「株を持つ」。架空の価格は前日より上がったね。',
    '方針は「現金で待機」。架空の価格は前日より下がったね。'];
  for(const text of expected) {
    await fire('quickFollowing');assert.equal(get('quickTacticsDay').textContent,text);
    assert.equal(get('scene').dataset.mood,'thinking');
    assert.equal(get('speech').textContent,text);
  }
});

test('all CASH in falling market never describes avoidance as profit or zero wallet loss',async()=>{
  for(const fee of [0,1]) {
    const {get,fire,state}=await mount();
    const valid=await state.practice({amount:1000,leverage:1});
    state.practice=async()=>({...valid,final_balance:10000-fee*12,profit_coins:-fee*12,
      daily_balances:Array.from({length:13},(_,i)=>10000-fee*i),
      daily_synthetic_prices:Array.from({length:13},(_,i)=>100-i),
      daily_ai_signals:Array(12).fill('CASH')});
    await fire('quickForm','submit');await fire('quickRun');
    assert.equal(get('quickBestDay').disabled,true);
    for(let day=1;day<=12;day++) {
      await fire('quickFollowing');
      assert.equal(get('quickTacticsDay').textContent,fee && day===1 ?
        'うわっ、ここが一番残高の減った日だね…。' :
        '方針は「現金で待機」。架空の価格は前日より下がったね。');
      assert.equal(get('scene').dataset.mood,fee?'cautious':'thinking');
      assert.equal(get('speech').textContent,get('quickTacticsDay').textContent);
      assert.doesNotMatch(get('quickTacticsDay').textContent,/損失なし|損失ゼロ|無損失|無傷|ダメージなし|残高は減らない|利益が出|儲か/);
    }
  }
});

test('25x stopout voice takes priority over worst day and changes after stopout',async()=>{
  for(const stop of [1,2,12]) for(const signal of ['LONG','CASH']) for(const direction of [-1,1]) {
    const {get,fire,state,calls}=await mount();
    const valid=await state.practice({amount:1000,leverage:25});
    state.practice=async()=>({...valid,final_balance:9000,profit_coins:-1000,liquidated_at_step:stop,
      daily_balances:Array.from({length:13},(_,i)=>i<stop?10000:9000),
      daily_ai_signals:Array(12).fill(signal),
      daily_synthetic_prices:Array.from({length:13},(_,i)=>100+direction*i)});
    get('quickLeverage').value='25';await fire('quickLeverage','change');
    await fire('quickForm','submit');await fire('quickRun');
    const before=calls.length;
    await fire('quickWorstDay');
    assert.equal(get('speech').textContent,get('quickTacticsDay').textContent);
    assert.equal(get('scene').dataset.mood,'cautious');
    assert.equal(get('quickTacticsDay').textContent,'あっ…ここで投入したコインが尽きちゃった。悔しい！');
    for(let day=stop+1;day<=12;day++) {
      await fire('quickFollowing');
      assert.equal(get('speech').textContent,get('quickTacticsDay').textContent);
      assert.equal(get('scene').dataset.mood,'cautious');
      assert.equal(get('quickTacticsDay').textContent,'もう投入分は運用されていないけど、相場はまだ動いてるね。');
    }
    assert.equal(get('quickLeverage').value,'25');
    assert.equal(calls.length,before);
  }
});

test('self scene mirrors replay facts through gain, loss, liquidation and post-stop without side effects',async()=>{
  const {get,fire,state,calls,storageWrites}=await mount();
  const valid=await state.practice({amount:1000,leverage:25});
  state.practice=async()=>({...valid,liquidated_at_step:3,final_balance:9000,profit_coins:-1000,
    daily_balances:[10000,10010,9995,...Array(10).fill(9000)]});
  get('quickModel').value='self';get('quickLeverage').value='25';
  await fire('quickForm','submit');await fire('quickRun');
  const before=calls.slice();
  for(const [day,mood,delta] of [[0,'ready',null],[1,'happy','+10'],[2,'cautious','-15'],
    [3,'cautious','-995'],[4,'cautious','+0']]) {
    if(day)await fire('quickFollowing');
    assert.equal(get('scene').dataset.mood,mood);
    assert.equal(get('speech').textContent,get('quickTacticsDay').textContent);
    assert.match(get('quickReplayDay').textContent,new RegExp('第'+day+'日'));
    if(delta)assert.ok(get('quickReplayDay').textContent.includes('前日比：'+delta+' C'));
    if(day===3)assert.match(get('quickReplayContext').textContent,/強制終了しました/);
    if(day===4)assert.match(get('quickReplayContext').textContent,/運用に使われていません/);
  }
  assert.deepEqual(calls,before);assert.deepEqual(storageWrites,[]);
  assert.match(html,/<p id="speech"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('preset replay never takes over the authored scene',async()=>{
  const {get,fire}=await mount([{id:'preset',name:'他のAI',owned:true}]);
  get('speech').textContent='自分の相棒';get('scene').dataset.mood='growth';
  get('quickModel').value='preset';
  await fire('quickForm','submit');await fire('quickRun');
  for(let day=0;day<=12;day++) {
    assert.equal(get('speech').textContent,'自分の相棒');
    assert.equal(get('scene').dataset.mood,'growth');
    await fire('quickFollowing');
  }
  await fire('quickAgain');assert.equal(get('scene').dataset.mood,'growth');
});

test('quick cleanup restores snapshot only while both scene values are still owned',async()=>{
  for(const advanced of ['none','text','mood','both']) {
    for(const [id,event] of [['quickAgain','click'],['quickAmount','input'],
      ['quickModel','change'],['quickLeverage','change'],['quickForm','submit']]) {
      const {get,fire}=await mount();
      get('quickModel').value='self';
      get('speech').textContent='元の台詞';get('scene').dataset.mood='growth';
      await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
      if(advanced==='text'||advanced==='both')get('speech').textContent='詳しい練習';
      if(advanced==='mood'||advanced==='both')get('scene').dataset.mood='thinking';
      const text=get('speech').textContent,mood=get('scene').dataset.mood;
      await fire(id,event);
      assert.equal(get('speech').textContent,advanced==='none'?'元の台詞':text);
      assert.equal(get('scene').dataset.mood,advanced==='none'?'growth':mood);
      assert.equal(get('quickReplay').hidden,true);
    }
  }
});

test('new run and invalid, error or failed responses leave original scene restored',async()=>{
  for(const failure of ['invalid','error','fetch']) {
    const {get,fire,state}=await mount();
    get('quickModel').value='self';
    get('speech').textContent='前の声';get('scene').dataset.mood='ready';
    await fire('quickForm','submit');await fire('quickRun');
    await fire('quickForm','submit');
    let finish;
    state.practice=()=>new Promise((resolve,reject)=>{
      finish=()=>failure==='fetch'?reject(Error('offline')):resolve(failure==='error'?{error:'失敗'}:{});
    });
    const running=fire('quickRun');
    assert.equal(get('speech').textContent,'前の声');
    finish();await running;
    assert.equal(get('speech').textContent,'前の声');
    assert.equal(get('scene').dataset.mood,'ready');
    assert.equal(get('quickReplay').hidden,true);
    assert.match(get('quickStatus').textContent,/試算できませんでした/);
  }
});


const miniSlots=['Base','Outfit','Face','Hair','Portrait'];
function assertMiniCleared(get) {
  assert.equal(get('quickMini').hidden,true);
  for(const slot of miniSlots) {
    assert.equal(get('quickMini'+slot).hidden,true,slot);
    assert.equal(get('quickMini'+slot).getAttribute('src'),null,slot);
  }
}
async function loadMini(get,fire) {
  for(const slot of miniSlots) {
    const image=get('quickMini'+slot);
    if(image.src && !image.complete)await fire('quickMini'+slot,'load');
  }
}
function showComposite(get) {
  get('chibi').hidden=true;
  get('portrait').hidden=true;
  get('artworkStage').hidden=false;
  for(const slot of miniSlots.slice(0,4)) {
    const image=get('artwork'+slot);
    image.src='blob:current-'+slot;
    image.hidden=false;image.complete=true;image.naturalWidth=150;
    image.parentElement=get('artworkStage');
  }
  get('artworkStage').parentElement=get('scene');
}

test('mini composite preserves all source layers, ordering, text safety and original images',async()=>{
  const {get,fire,calls,storageWrites,sourceChanged}=await mount();
  assertMiniCleared(get);
  showComposite(get);
  const originals=miniSlots.slice(0,4).map(slot=>({src:get('artwork'+slot).src,
    hidden:get('artwork'+slot).hidden}));
  await fire('quickForm','submit');await fire('quickRun');
  await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
  for(const [index,slot] of miniSlots.slice(0,4).entries()) {
    assert.equal(get('quickMini'+slot).src,originals[index].src);
    assert.equal(get('quickMini'+slot).hidden,false);
    assert.match(html,new RegExp('#quickMini'+slot+'\\{z-index:'+index+'\\}'));
  }
  assert.equal(get('quickMiniPortrait').hidden,true);
  const before=calls.length;
  get('artworkFace').hidden=true;
  sourceChanged();
  assert.equal(get('quickMiniFace').hidden,true);
  assert.equal(get('quickMiniFace').src,'');
  get('artworkHair').src='blob:unsaved-hair';
  await fire('artworkHair','load');
  assert.equal(get('quickMiniHair').src,'blob:unsaved-hair');
  assert.match(html,/aria-label="現在表示中の相棒のイラスト"/);
  assert.doesNotMatch(get('quickTacticsDay').textContent,/<img|blob:|保存済み/);
  for(const [index,slot] of miniSlots.slice(0,4).entries()) {
    assert.equal(get('artwork'+slot).src,slot==='Hair'?'blob:unsaved-hair':originals[index].src);
    assert.equal(get('artwork'+slot).hidden,slot==='Face');
  }
  await fire('quickBestDay');await fire('quickWorstDay');
  assert.equal(calls.length,before);
  assert.deepEqual(storageWrites,[]);
  const nodes=htmlNodes();
  for(const slot of miniSlots) {
    const matches=nodes.filter(node=>node.id==='quickMini'+slot);
    assert.equal(matches.length,1);
    assert.ok(matches[0].parents.includes('quickReplay'));
    assert.doesNotMatch(matches[0].attributes,/\bsrc=/);
  }
  assert.match(html,/#quickMini\{[^}]*width:80px;[^}]*aspect-ratio:150\/192/);
  assert.match(html,/#quickMini img\{[^}]*object-fit:contain/);
});

test('mini waits for every visible layer and responds to loading, errors and artwork resets',async()=>{
  const {get,fire,sourceChanged}=await mount();
  showComposite(get);
  get('artworkHair').complete=false;
  get('artworkHair').naturalWidth=0;
  await fire('quickForm','submit');await fire('quickRun');
  assertMiniCleared(get);
  get('artworkHair').complete=true;get('artworkHair').naturalWidth=150;
  await fire('artworkHair','load');
  await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
  for(const slot of miniSlots.slice(0,4)) {
    const source=get('artwork'+slot);
    source.naturalWidth=0;
    await fire('artwork'+slot,'error');
    assertMiniCleared(get);
    source.naturalWidth=150;
    await fire('artwork'+slot,'load');
    await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
    source.removeAttribute('src');sourceChanged();
    assertMiniCleared(get);
    source.src='blob:restored-'+slot;source.complete=true;source.naturalWidth=150;sourceChanged();
    await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
  }
  get('artworkStage').hidden=true;get('chibi').hidden=false;sourceChanged();
  assertMiniCleared(get);
  showComposite(get);sourceChanged();
  await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
  for(const [id,property,value] of [['scene','display','none'],['artworkStage','visibility','hidden'],
    ['artworkBase','opacity','0']]) {
    get(id).style[property]=value;sourceChanged();assertMiniCleared(get);
    delete get(id).style[property];sourceChanged();
    await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
  }
});

test('mini uses loaded visible blueprint portrait and hides CSS fallback or missing art',async()=>{
  const {get,fire,sourceChanged}=await mount();
  await fire('quickForm','submit');await fire('quickRun');
  assertMiniCleared(get);
  showComposite(get);
  get('artworkStage').hidden=true;
  const portrait=get('portrait');
  portrait.hidden=false;portrait.src='data:image/png;base64,original';
  sourceChanged();assertMiniCleared(get);
  portrait.complete=true;portrait.naturalWidth=150;
  await fire('portrait','load');
  await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
  assert.equal(get('quickMiniPortrait').src,portrait.src);
  assert.equal(get('quickMiniPortrait').hidden,false);
  for(const slot of miniSlots.slice(0,4))assert.equal(get('quickMini'+slot).src,'');
  portrait.naturalWidth=0;await fire('portrait','error');assertMiniCleared(get);
  portrait.hidden=true;get('chibi').hidden=false;sourceChanged();assertMiniCleared(get);
});

test('demo AI never borrows self art; every review reset clears all preview sources',async()=>{
  for(const [id,event] of [['quickAmount','input'],['quickModel','change'],
    ['quickLeverage','change'],['quickTen','click'],['quickHalf','click'],
    ['quickAll','click'],['quickForm','submit'],['quickAgain','click']]) {
    const {get,fire,sourceChanged,calls,storageWrites}=await mount([
      {id:'demo',name:'<img src=x onerror=alert(1)>',owned:true},
    ]);
    showComposite(get);
    await fire('quickForm','submit');await fire('quickRun');
    await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
    await fire(id,event);assertMiniCleared(get);
    sourceChanged();await fire('artworkBase','load');assertMiniCleared(get);
    get('quickModel').value='demo';
    await fire('quickModel','change');
    await fire('quickForm','submit');await fire('quickRun');
    assertMiniCleared(get);
    await fire('quickFollowing');sourceChanged();assertMiniCleared(get);
    assert.doesNotMatch(get('quickTacticsDay').textContent,/<img|onerror/);
    assert.equal(calls.filter(call=>call.path==='/api/quick-practice').length,2);
    assert.ok(calls.every(call=>['/api/model-shop','/api/quick-practice'].includes(call.path)));
    assert.deepEqual(storageWrites,[]);
  }
});

test('mini remains cleared during pending retry and failed result, even on source load',async()=>{
  const {get,fire,state}=await mount();
  showComposite(get);
  await fire('quickForm','submit');await fire('quickRun');
  await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
  await fire('quickForm','submit');
  let finish;
  state.practice=()=>new Promise(resolve=>{finish=resolve;});
  const running=fire('quickRun');
  assertMiniCleared(get);
  await fire('artworkBase','load');assertMiniCleared(get);
  finish({error:'<img src=x onerror=alert(1)>'});
  await running;
  assertMiniCleared(get);
  assert.match(get('quickStatus').textContent,/<img src=x/); // Literal text, never inserted HTML.
  assert.equal(get('artworkBase').src,'blob:current-Base');
});

test('mini reveals atomically after all copies load and never retries an unchanged failed src',async()=>{
  const {get,fire,sourceChanged,calls,storageWrites}=await mount();
  showComposite(get);
  await fire('quickForm','submit');await fire('quickRun');
  const before=calls.slice();
  assert.equal(get('quickMini').hidden,true);
  for(const [index,slot] of miniSlots.slice(0,4).entries()) {
    const copy=get('quickMini'+slot);
    assert.equal(copy.complete,false);
    assert.equal(copy.naturalWidth,0);
    await fire('quickMini'+slot,'load');
    assert.equal(get('quickMini').hidden,index!==3);
  }
  const hair=get('quickMiniHair');
  await fire('quickMiniHair','error');
  assert.equal(get('quickMini').hidden,true);
  const assignments=hair.srcAssignments;
  sourceChanged();await fire('quickFollowing');await fire('quickMiniHair','error');
  assert.equal(hair.srcAssignments,assignments);
  assert.equal(get('quickMini').hidden,true);
  get('artworkHair').src='blob:replacement';sourceChanged();
  assertMiniCleared(get);
  await fire('artworkHair','load');
  assert.equal(hair.src,'blob:replacement');
  assert.equal(get('quickMini').hidden,true);
  await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
  get('artworkFace').hidden=true;sourceChanged();
  assert.equal(get('quickMiniFace').src,'');
  assert.equal(get('quickMini').hidden,false);
  get('artworkFace').hidden=false;sourceChanged();
  assert.equal(get('quickMini').hidden,true);
  await fire('quickMiniFace','load');
  assert.equal(get('quickMini').hidden,false);
  // A loaded replacement source must also wait for its newly assigned copy.
  get('artworkHair').src='blob:loaded-replacement';
  get('artworkHair').complete=true;get('artworkHair').naturalWidth=150;
  sourceChanged();
  assert.equal(get('quickMini').hidden,true);
  assert.equal(hair.complete,false);
  await fire('quickMiniHair','load');
  assert.equal(get('quickMini').hidden,false);
  assert.deepEqual(calls,before);
  assert.deepEqual(storageWrites,[]);
  await fire('quickAgain');assertMiniCleared(get);
  await fire('quickMiniHair','load');assertMiniCleared(get);
});


test('integrated replay has unique IDs and only the atomic mini image family',()=>{
  const ids=htmlNodes().map(node=>node.id).filter(Boolean);
  assert.equal(new Set(ids).size,ids.length);
  assert.doesNotMatch(html,/id="quickReplay(?:Mini|Base|Outfit|Face|Hair|Portrait)"/);
});

test('empty image sources never reveal the mini despite reported load completion',async()=>{
  for(const src of [undefined,'','   ']) {
    const {get,fire}=await mount();
    showComposite(get);
    const base=get('artworkBase');
    if(src===undefined)base.removeAttribute('src');else base.src=src;
    base.complete=true;base.naturalWidth=150;
    await fire('quickForm','submit');await fire('quickRun');
    assertMiniCleared(get);
  }
});

test('self replay navigation preserves source art and demo switch clears mini while respecting advanced scene',async()=>{
  for(const advanced of ['none','text','mood','both']) {
    const {get,fire,calls,storageWrites}=await mount([{id:'preset',name:'Preset',owned:true}]);
    showComposite(get);
    const sources=miniSlots.slice(0,4).map(slot=>get('artwork'+slot));
    const originals=sources.map(source=>({...source.attributes}));
    get('speech').textContent='元の声';get('scene').dataset.mood='growth';
    get('quickModel').value='self';
    await fire('quickForm','submit');await fire('quickRun');await loadMini(get,fire);
    const assignments=miniSlots.map(slot=>get('quickMini'+slot).srcAssignments);
    const before=calls.slice();
    for(let day=1;day<=12;day++)await fire('quickFollowing');
    for(let repeat=0;repeat<10;repeat++) {
      for(const button of ['quickBestDay','quickWorstDay']) {
        await fire(button);
        for(const [index,slot] of miniSlots.slice(0,4).entries())
          assert.equal(get('quickMini'+slot).src,originals[index].src);
        assert.deepEqual(sources.map(source=>({...source.attributes})),originals);
      }
    }
    assert.deepEqual(sources.map(source=>({...source.attributes})),originals);
    assert.deepEqual(miniSlots.map(slot=>get('quickMini'+slot).srcAssignments),assignments);
    if(advanced==='text'||advanced==='both')get('speech').textContent='詳しい練習';
    if(advanced==='mood'||advanced==='both')get('scene').dataset.mood='thinking';
    const text=get('speech').textContent,mood=get('scene').dataset.mood;
    get('quickModel').value='preset';await fire('quickModel','change');
    assertMiniCleared(get);
    assert.deepEqual(calls,before);
    await fire('quickForm','submit');await fire('quickRun');
    assertMiniCleared(get);
    assert.equal(get('speech').textContent,advanced==='none'?'元の声':text);
    assert.equal(get('scene').dataset.mood,advanced==='none'?'growth':mood);
    assert.deepEqual(sources.map(source=>({...source.attributes})),originals);
    assert.deepEqual(storageWrites,[]);
  }
});

test('result summary uses the submitted self, demo or literal user model name and change clears ownership',async()=>{
  const malicious='<img onerror=alert(1)>';
  for(const [id,companionName] of [
    ['self',undefined],['self',null],['self',''],['self','   '],['self',123],
    ['self','検証用キャラ'],['self',`検証<&"'相棒`],['demo','無視する相棒'],['owned',malicious],
  ]) {
    const {get,fire,calls,state}=await mount([
      {id:'demo',name:'デモAI',owned:true},{id:'owned',name:malicious,owned:true},
    ]);
    showComposite(get);
    get('speech').textContent='元の声';get('scene').dataset.mood='growth';
    get('quickModel').value=id;
    const name=id==='self' && typeof companionName==='string' && companionName.trim() ?
      '自分のAI（相棒：'+companionName+'）' : get('quickModel').selectedOptions[0].textContent;
    get('companionName').value='未保存プレビュー';
    const practice=state.practice;
    let resolveResponse;
    state.practice=body=>new Promise(resolve=>{resolveResponse=async()=>resolve({...await practice(body),
      ...(companionName===undefined?{}:{companion_name:companionName})});});
    await fire('quickForm','submit');
    // Even programmatic selection changes while awaiting a response cannot rename this request.
    const running=fire('quickRun');
    get('quickModel').value=id==='demo'?'self':'demo';
    await resolveResponse();await running;await loadMini(get,fire);
    assert.equal(calls.at(-1).body.model_id,id);
    const summary=get('quickResult').children[1];
    assert.ok(summary.textContent.startsWith('今回のAI：'+name+' ／ 試算額：'));
    assert.equal(summary.children.length,0);
    if(id==='owned')assert.ok(summary.textContent.includes(malicious));
    assert.equal(get('quickResult').hidden,false);
    const before=calls.slice();
    await fire('quickModel','change');
    assert.equal(get('quickResult').hidden,true);
    assert.equal(get('quickReplay').hidden,true);
    assert.equal(get('quickNext').hidden,true);
    assertMiniCleared(get);
    assert.equal(get('speech').textContent,'元の声');
    assert.equal(get('scene').dataset.mood,'growth');
    for(const button of ['quickPrevious','quickFollowing','quickBestDay','quickWorstDay'])await fire(button);
    assert.equal(get('quickReplayDay').textContent,'');
    assert.deepEqual(calls,before);
  }
});

test('base-only artwork reveals mini after load without waiting for hidden optional layers',async()=>{
  const {get,fire}=await mount();
  showComposite(get);
  for(const slot of ['Outfit','Face','Hair']) {
    get('artwork'+slot).hidden=true;
    get('artwork'+slot).complete=false;get('artwork'+slot).naturalWidth=0;
  }
  await fire('quickForm','submit');await fire('quickRun');
  assert.equal(get('quickMini').hidden,true);
  assert.equal(get('quickMiniBase').src,get('artworkBase').src);
  await fire('quickMiniBase','load');
  assert.equal(get('quickMini').hidden,false);
  assert.equal(get('quickMiniBase').hidden,false);
  for(const slot of ['Outfit','Face','Hair']) {
    assert.equal(get('quickMini'+slot).hidden,true);
    assert.equal(get('quickMini'+slot).src,'');
  }
});

async function shareReflection(get,fire,choice='buy',reason='trend',note='') {
  get('quickHumanChoice').value=choice;
  get('quickHumanReason').value=reason;
  get('quickHumanNote').value=note;
  await fire('quickReflectionForm','submit');
}

test('optional post-result reflection has native labels, bounds and explicit privacy copy',()=>{
  const nodes=htmlNodes();
  const get=id=>nodes.find(node=>node.id===id);
  assert.equal(get('quickReflection').tag,'details');
  assert.ok(get('quickReflection').parents.includes('quickReplay'));
  assert.match(html,/結果を見た後の振り返り/);
  assert.match(html,/自由文をAIは解釈しません/);
  assert.match(html,/APIへ送信せず、ディスクに保存せず、モデルにも渡しません/);
  assert.match(html,/ページ内メモリだけ/);
  assert.match(html,/作戦の変更や学習は行いません/);
  assert.match(get('quickReflectionForm').attributes,/autocomplete="off"/);
  for(const id of ['quickHumanChoice','quickHumanReason','quickHumanNote']) {
    assert.ok(nodes.some(node=>node.tag==='label'&&node.attributes.includes('for="'+id+'"')));
    assert.ok(get(id).parents.includes('quickReflectionForm'));
    assert.doesNotMatch(get(id).attributes,/\bname=/); // No native form serialization either.
  }
  for(const id of ['quickHumanChoice','quickHumanReason'])assert.match(get(id).attributes,/required/);
  assert.match(get('quickHumanNote').attributes,/maxlength="120"/);
  assert.match(get('quickHumanNote').attributes,/aria-describedby="quickReflectionPrivacy"/);
  assert.match(get('quickReflectionResult').attributes,/aria-live="polite"/);
  assert.ok(get('quickReflectionPrivacy').parents.includes('quickReflectionForm'));
  assert.ok(get('quickReflectionPrivacy').offset<get('quickHumanChoice').offset);
  assert.equal(get('quickReflectionPrivacyDetails').tag,'details');
  assert.doesNotMatch(get('quickReflectionPrivacyDetails').attributes,/\bopen\b/);
  assert.match(html,/未知の値動きの予測ではありません/);
  assert.match(html,/この日の考えを比較する/);
  assert.doesNotMatch(html,/この日の考えを共有する/);
  assert.match(get('quickReflectionEdit').attributes,/type="button"/);
});

test('reflection rejects invalid choices, reason tags and overlong notes without submission',async()=>{
  const {get,fire,document,calls,storageWrites}=await mount();
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  const before=calls.slice();
  for(const [choice,reason,note,field] of [
    ['','trend','','quickHumanChoice'],['LONG','trend','','quickHumanChoice'],
    ['buy','','','quickHumanReason'],['buy','__proto__','','quickHumanReason'],
    ['buy','constructor','','quickHumanReason'],['wait','drop','a'.repeat(121),'quickHumanNote'],
  ]) {
    await shareReflection(get,fire,choice,reason,note);
    assert.equal(get('quickReflectionResult').hidden,true);
    assert.match(get('quickReflectionError').textContent,/120文字以内/);
    assert.equal(document.activeElement,get(field));
  }
  await shareReflection(get,fire,'wait','limit','a'.repeat(120));
  assert.equal(get('quickReflectionResult').hidden,false);
  assert.equal(get('quickReflectionError').textContent,'');
  assert.deepEqual(calls,before);assert.deepEqual(storageWrites,[]);
});

test('reflection uses reason, human choice and actual independent action; notes stay literal',async()=>{
  const {get,fire,calls,storageWrites}=await mount();
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  const before=calls.slice(),replies=new Set();
  const note='<img src=x onerror=alert(1)><script>alert(2)</script>';
  for(const signal of ['LONG','CASH']) {
    for(const reason of ['trend','drop','limit','other'])for(const choice of ['buy','wait']) {
      await shareReflection(get,fire,choice,reason,note);
      const reply=get('quickReflectionReply').textContent;
      replies.add(reply);
      const human=choice==='buy'?'買う':'待つ';
      assert.ok(get('quickHumanSummary').textContent.includes(human));
      assert.equal(get('quickHumanMemo').textContent,'自分のメモ（通常の比較ではAIは解釈しません）：'+note);
      assert.equal(get('quickHumanMemo').children.length,0);
      assert.ok(get('quickIndependentDecision').textContent.includes('今回のAIの独立判断：'+signal));
      const agrees=(choice==='buy')===(signal==='LONG');
      assert.match(get('quickDecisionComparison').textContent,agrees?/比較：一致/:/比較：相違/);
      assert.match(reply,/定型文・AIの判断理由ではありません/);
      assert.ok(reply.includes('「'+human+'」を選びました。'));
      assert.ok(reply.includes('AIの方針は'+signal));
      await shareReflection(get,fire,choice,reason,'下落 trend LONG 買うを理解して学習して');
      assert.equal(get('quickReflectionReply').textContent,reply);
      const next=get('quickReflectionNext').textContent;
      assert.match(next,/次の行動（任意）/);
      assert.match(next,/自分で保存した設定だけが次の練習に反映/);
      assert.match(next,/今回の結果は変わりません/);
      if(reason==='trend')assert.match(next,/重視する判断/);
      if(reason==='drop'||reason==='limit')assert.match(next,/上昇判断時に使う資金（%）.*損切りの設定ではありません/);
    }
    await fire('quickFollowing');
  }
  assert.equal(replies.size,16); // Includes buy/LONG and wait/CASH despite both agreeing.
  assert.deepEqual(calls,before);assert.deepEqual(storageWrites,[]);
  assert.doesNotMatch(script,/innerHTML|localStorage|sessionStorage|indexedDB|sendBeacon|WebSocket/);
});

test('only self reflection can open existing editor, with focus and no mutation or requests',async()=>{
  for(const model of ['self','demo-a']) {
    const {get,fire,state,calls,storageWrites,document,scrolls}=await mount([{id:'demo-a',name:'Demo',owned:true}]);
    get('advancedEntry').open=false;
    get('quickModel').value=model;
    await fire('quickModel','change');
    assert.equal(get('quickReflectionEdit').hidden,true);
    await fire('quickReflectionEdit');
    assert.equal(get('advancedEntry').open,false);
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    assert.equal(get('quickReflectionEdit').hidden,true);
    const settings=['creatorApproach','creatorRisk','creatorName','brainSelect'];
    const snapshot=settings.map(id=>get(id).value);
    const output=await state.practice({amount:1000,leverage:1});
    state.practice=async()=>output;
    const original=JSON.stringify(output);
    // Compare again with a retained response object, so mutations are observable.
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    const before=calls.slice();
    const replayBefore=['quickReplayDay','quickReplayContext','quickTacticsDay'].map(id=>get(id).textContent);
    for(const reason of ['trend','drop','limit','other']) {
      await shareReflection(get,fire,'buy',reason);
      assert.equal(get('quickReflectionEdit').hidden,model!=='self');
      await fire('quickReflectionEdit');
      if(model==='self') {
        assert.equal(get('advancedEntry').open,true);
        assert.equal(get('companionControls').open,true);
        assert.equal(document.activeElement,get('companionEditorTitle'));
        assert.equal(get('predictionStudio').open,true);
        assert.equal(get('companionEditorTitle').getAttribute('tabindex'),null);
        assert.equal(get('companionEditorTitle').focusOptions.preventScroll,true);
        assert.equal(scrolls.at(-1),get('predictionStudio'));
      } else {
        assert.equal(get('advancedEntry').open,false);
        assert.match(get('quickReflectionNext').textContent,/デモAIの判断ルールはここでは編集できません/);
        assert.doesNotMatch(get('quickReflectionNext').textContent,/保存した設定だけ/);
      }
      assert.deepEqual(settings.map(id=>get(id).value),snapshot);
      assert.equal(JSON.stringify(output),original);
      assert.deepEqual(['quickReplayDay','quickReplayContext','quickTacticsDay'].map(id=>get(id).textContent),replayBefore);
      assert.deepEqual(calls,before);assert.deepEqual(storageWrites,[]);
    }
    await fire('quickPrevious');
    assert.equal(get('quickReflectionEdit').hidden,true);
    await fire('quickAgain');
    assert.equal(get('quickReflectionEdit').hidden,true);
  }
});

test('reflection excludes day zero, isolates all twelve days, and preserves navigation and s65 art',async()=>{
  const {get,fire,calls,storageWrites}=await mount();
  showComposite(get);
  await fire('quickForm','submit');await fire('quickRun');await loadMini(get,fire);
  const before=calls.slice();
  assert.equal(get('quickReflection').hidden,true);
  await shareReflection(get,fire);
  assert.equal(get('quickReflectionResult').hidden,true);
  for(let day=1;day<=12;day++) {
    await fire('quickFollowing');
    assert.equal(get('quickReflection').hidden,false);
    assert.equal(get('quickReflectionDay').textContent,'第'+day+'日の振り返り');
    assert.equal(get('quickHumanNote').value,'');
    await shareReflection(get,fire,'buy','trend','day '+day);
  }
  await fire('quickFollowing');
  assert.equal(get('quickHumanNote').value,'day 12');
  for(let day=11;day>=1;day--) {
    await fire('quickPrevious');
    assert.equal(get('quickHumanNote').value,'day '+day);
  }
  await fire('quickPrevious');await fire('quickPrevious');
  assert.equal(get('quickReflection').hidden,true);
  assert.equal(get('quickHumanMemo').textContent,'');
  await fire('quickBestDay');
  assert.equal(get('quickHumanNote').value,'day 1');
  await fire('quickWorstDay');
  assert.equal(get('quickHumanNote').value,'day 2');
  assert.equal(get('quickMini').hidden,false);
  for(const slot of miniSlots.slice(0,4)) {
    assert.equal(get('quickMini'+slot).src,'blob:current-'+slot);
    assert.equal(get('artwork'+slot).src,'blob:current-'+slot);
  }
  assert.deepEqual(calls,before);assert.deepEqual(storageWrites,[]);
});

test('reflection clears on new practice, retry, errors and reload and never leaks into requests',async()=>{
  const {get,fire,state,calls,storageWrites}=await mount();
  const valid=await state.practice({amount:1000,leverage:1});
  for(const outcome of [valid,{error:'offline'},{...valid,daily_balances:[]}]) {
    state.practice=async()=>valid;
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    await shareReflection(get,fire,'wait','drop','PRIVATE NOTE');
    get('quickReflection').open=true;
    await fire('quickAgain');
    assert.equal(get('quickHumanNote').value,'');
    assert.equal(get('quickReflection').open,false);
    await fire('quickForm','submit');
    let finish;
    state.practice=()=>new Promise(resolve=>{finish=resolve;});
    const running=fire('quickRun');
    assert.equal(get('quickReflection').hidden,true);
    assert.equal(get('quickHumanMemo').textContent,'');
    finish(outcome);await running;
    await fire('quickFollowing');
    assert.equal(get('quickHumanNote').value,'');
    assert.equal(get('quickReflectionResult').hidden,true);
  }
  state.practice=async()=>valid;
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  await shareReflection(get,fire,'buy','limit','PRIVATE NOTE');
  await fire('quickForm','submit'); // New practice without the retry shortcut.
  assert.equal(get('quickHumanNote').value,'');
  await fire('quickRun');await fire('quickFollowing');
  assert.equal(get('quickReflectionResult').hidden,true);
  const fresh=await mount();
  await fresh.fire('quickForm','submit');await fresh.fire('quickRun');await fresh.fire('quickFollowing');
  assert.equal(fresh.get('quickHumanNote').value,'');
  assert.equal(fresh.get('quickReflectionResult').hidden,true);
  for(const call of calls.filter(call=>call.path==='/api/quick-practice'))
    assert.deepEqual(call.body,{model_id:'self',amount:1000,leverage:1});
  assert.ok(calls.every(call=>['/api/model-shop','/api/quick-practice'].includes(call.path)));
  assert.deepEqual(storageWrites,[]);
});


test('reflection distinguishes unused post-liquidation signals and rejects missing results',async()=>{
  const {get,fire,state,calls}=await mount();
  const valid=await state.practice({amount:1000,leverage:1});
  state.practice=async()=>({...valid,liquidated_at_step:1,final_balance:9000,profit_coins:-1000,
    daily_balances:[10000,...Array(12).fill(9000)]});
  await fire('quickForm','submit');await fire('quickRun');
  await fire('quickFollowing');await fire('quickFollowing');
  const before=calls.slice();
  await shareReflection(get,fire,'buy','drop');
  assert.match(get('quickIndependentDecision').textContent,/CASH.*強制終了後のため運用には使われていません/);
  assert.match(get('quickReflectionReply').textContent,/AIの方針はCASH/);
  assert.deepEqual(calls,before);
  for(const failure of [{...valid,daily_ai_signals:undefined},{...valid,daily_ai_signals:['LONG']}]) {
    state.practice=async()=>failure;
    await fire('quickForm','submit');await fire('quickRun');
    await shareReflection(get,fire);
    assert.equal(get('quickReflection').hidden,true);
    assert.equal(get('quickReflectionEdit').hidden,true);
    assert.equal(get('quickReflectionNext').textContent,'');
    assert.equal(get('quickReflectionReply').textContent,'');
    assert.match(get('quickStatus').textContent,/形式が不正/);
  }
});

test('drafts clear on day changes and cancelled retry cannot restore or submit reflection',async()=>{
  const {get,fire,calls}=await mount();
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  get('quickHumanNote').value='uncompared draft';
  await fire('quickFollowing');await fire('quickPrevious');
  assert.equal(get('quickHumanNote').value,'');
  await shareReflection(get,fire,'wait','limit','compared note');
  await fire('quickAgain');
  await fire('quickForm','submit');
  const before=calls.slice();
  await fire('quickEdit');await fire('quickRun');
  assert.deepEqual(calls,before);
  assert.equal(get('quickHumanNote').value,'');
  assert.equal(get('quickReflectionResult').hidden,true);
  assert.equal(get('quickReflectionEdit').hidden,true);
  assert.equal(get('quickReflectionNext').textContent,'');
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  assert.equal(get('quickHumanNote').value,'');
  assert.equal(get('quickReflectionResult').hidden,true);
});

test('replay owner caption is beside existing mini and voice, no duplicates',()=>{
  const owners=htmlNodes().filter(node=>node.id==='quickReplayOwner');
  assert.equal(owners.length,1);
  assert.ok(owners[0].parents.includes('quickReplay'));
  assert.doesNotMatch(html,/id="quickReplayMini"|id="quickReplayIdentity"/);
});

test('owner caption follows self art, other AI and reset without extra network',async()=>{
  const {get,fire,calls,storageWrites,sourceChanged}=await mount([{id:'demo',name:'デモAI',owned:true}]);
  assert.equal(get('quickReplayOwner').textContent,'');
  await fire('quickForm','submit');await fire('quickRun');
  assert.equal(get('quickReplayOwner').textContent,'相棒の外見は上の画面で確認できます');
  showComposite(get);sourceChanged();await loadMini(get,fire);
  assert.equal(get('quickMini').hidden,false);
  assert.equal(get('quickReplayOwner').textContent,'自作キャラと振り返る');
  const before=calls.length;
  await fire('quickFollowing');
  assert.equal(calls.length,before);
  get('quickModel').value='demo';await fire('quickModel','change');
  assert.equal(get('quickReplayOwner').textContent,'');
  assert.equal(get('quickMini').hidden,true);
  await fire('quickForm','submit');await fire('quickRun');
  assert.equal(get('quickReplayOwner').textContent,'別のAIの練習結果です。自作キャラの成績ではありません。');
  assert.equal(get('quickMini').hidden,true);
  await fire('quickAgain');
  assert.equal(get('quickReplayOwner').textContent,'');
  assert.deepEqual(storageWrites,[]);
});

test('ChatGPT is hidden by default and never requests on load, run or reflection submit',async()=>{
  for(const configured of [false,true]) {
    const {get,fire,calls,storageWrites}=await mount([],configured);
    assert.equal(get('quickChatGPT').hidden,true);
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    await shareReflection(get,fire,'wait','drop','note');
    assert.equal(get('quickChatGPT').hidden,!configured);
    assert.equal(calls.filter(x=>x.path==='/api/chatgpt-dialogue').length,0);
    if(!configured)await fire('quickChatGPTAsk');
    assert.equal(calls.filter(x=>x.path==='/api/chatgpt-dialogue').length,0);
    assert.equal(storageWrites.length,0);
  }
});
test('only explicit ChatGPT click sends four fields; model response uses textContent with no game changes',async()=>{
  const {get,fire,calls,state,storageWrites}=await mount([],true);
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  await shareReflection(get,fire,'wait','drop','<script>alert(1)</script>');
  const before=get('quickResult').children[1].textContent;
  state.dialogue=async()=>({status:'ok',commentary:'<img src=x onerror=alert(1)>'});
  await fire('quickChatGPTAsk');
  const requests=calls.filter(x=>x.path==='/api/chatgpt-dialogue');
  assert.equal(requests.length,1);
  assert.equal(JSON.stringify(requests[0].body),JSON.stringify({choice:'wait',reason:'drop',note:'<script>alert(1)</script>',ai_action:'LONG'}));
  assert.match(get('quickChatGPTReply').textContent,/ChatGPT生成コメント.*真の判断理由ではありません/);
  assert.match(get('quickChatGPTReply').textContent,/<img src=x onerror=alert\(1\)>/);
  assert.match(get('quickChatGPTReply').textContent,/クライアント申告/);
  assert.equal(get('quickResult').children[1].textContent,before);
  assert.equal(calls.filter(x=>x.path==='/api/quick-practice').length,1);
  assert.equal(storageWrites.length,0);
});
test('ChatGPT pending responses cannot survive navigation, edits, retry, model switch or new practice',async()=>{
  for(const change of ['day','choice','reason','note','retry','model','run','amount','submit']) {
    const {get,fire,state}=await mount([{id:'other',name:'Other',owned:true}],true);
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    await shareReflection(get,fire);
    let release,signal;
    state.dialogue=async(body,options)=>{signal=options.signal;return new Promise(resolve=>{release=resolve;});};
    const pending=fire('quickChatGPTAsk');
    assert.equal(get('quickChatGPTAsk').disabled,true);
    if(change==='day')await fire('quickFollowing');
    if(['choice','reason','note'].includes(change)) {
      const id={choice:'quickHumanChoice',reason:'quickHumanReason',note:'quickHumanNote'}[change];
      get(id).value='changed';await fire(id,'input');
    }
    if(change==='retry')await fire('quickAgain');
    if(change==='model'){get('quickModel').value='other';await fire('quickModel','change');}
    if(change==='amount'){get('quickAmount').value='23';await fire('quickAmount','input');}
    if(change==='submit')await shareReflection(get,fire,'wait','limit','new');
    if(change==='run'){await fire('quickForm','submit');await fire('quickRun');}
    assert.equal(signal.aborted,true,change);
    release({status:'ok',commentary:'STALE'});await pending;
    assert.doesNotMatch(get('quickChatGPTReply').textContent,/STALE/);
  }
});
test('unavailable ChatGPT preserves human reflection and retry is explicit; reload has no reply',async()=>{
  const {get,fire,state,calls}=await mount([],true);
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  await shareReflection(get,fire);
  for(const fail of [async()=>({status:'unavailable'}),async()=>{throw Error('SECRET');},
    async()=>({status:'ok',commentary:'x'.repeat(1201)})]) {
    state.dialogue=fail;await fire('quickChatGPTAsk');
    assert.match(get('quickChatGPTReply').textContent,/取得できませんでした/);
    assert.doesNotMatch(get('quickChatGPTReply').textContent,/SECRET/);
    assert.equal(get('quickReflectionResult').hidden,false);
    assert.equal(get('quickChatGPTAsk').disabled,false);
  }
  assert.equal(calls.filter(x=>x.path==='/api/chatgpt-dialogue').length,3);
  const fresh=await mount([],true);
  assert.equal(fresh.get('quickChatGPT').hidden,true);
  assert.equal(fresh.get('quickChatGPTReply').textContent,'');
});

test('ChatGPT timeout clears old reply and supports only an explicit retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {get,fire,state,calls}=await mount([],true);
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  await shareReflection(get,fire);
  await fire('quickChatGPTAsk');
  assert.match(get('quickChatGPTReply').textContent,/ChatGPT生成/);
  state.dialogue=async(body,options)=>new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
  });
  const pending=fire('quickChatGPTAsk');
  assert.doesNotMatch(get('quickChatGPTReply').textContent,/ChatGPT生成/);
  assert.match(get('quickChatGPTReply').textContent,/考えています.*55秒.*中断/);
  t.mock.timers.tick(54999);
  await Promise.resolve();
  assert.match(get('quickChatGPTReply').textContent,/考えています/);
  assert.equal(get('quickChatGPTAsk').disabled,true);
  await fire('quickChatGPTAsk');
  assert.equal(calls.filter(x=>x.path==='/api/chatgpt-dialogue').length,2);
  t.mock.timers.tick(1);await pending;
  assert.match(get('quickChatGPTReply').textContent,/取得できませんでした/);
  assert.equal(get('quickChatGPTAsk').disabled,false);
  assert.equal(calls.filter(x=>x.path==='/api/chatgpt-dialogue').length,2);
});

test('invalid submit and pagehide discard replies; pending clicks never start another request',async()=>{
  for(const change of ['invalid','native-invalid','pagehide','edit-resubmit']) {
    const {get,fire,state,calls,pagehide}=await mount([],true);
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    await shareReflection(get,fire);
    let release,signal;
    state.dialogue=async(body,options)=>{signal=options.signal;return new Promise(resolve=>{release=resolve;});};
    const pending=fire('quickChatGPTAsk');
    await fire('quickChatGPTAsk');
    if(change==='pagehide')pagehide();
    if(change==='native-invalid')await fire('quickHumanChoice','invalid');
    if(change==='invalid') {
      get('quickHumanReason').value='invalid';
      await fire('quickReflectionForm','submit');
      assert.equal(get('quickReflectionResult').hidden,true);
    }
    if(change==='edit-resubmit') {
      get('quickHumanNote').value='edited';await fire('quickHumanNote','input');
      await fire('quickReflectionForm','submit');
    }
    assert.equal(signal.aborted,true);
    assert.equal(get('quickChatGPTAsk').disabled,true);
    await fire('quickChatGPTAsk');
    assert.equal(calls.filter(x=>x.path==='/api/chatgpt-dialogue').length,1);
    release({status:'ok',commentary:'STALE'});await pending;
    assert.equal(get('quickChatGPTReply').textContent,'');
    assert.equal(get('quickChatGPTAsk').disabled,false);
  }
});
test('session status is directly after setup, visible before practice only when configured',async()=>{
  const nodes=htmlNodes();
  const find=id=>nodes.find(node=>node.id===id);
  for(const id of ['quickChatGPTConnection','quickChatGPTStatusCheck','quickChatGPTStatus'])
    assert.equal(nodes.filter(node=>node.id===id).length,1,id);
  const panel=find('quickChatGPTConnection');
  assert.deepEqual(panel.parents,[...find('simpleHome').parents,'simpleHome']);
  assert.ok(panel.ancestorAttributes.every(attributes=>! /\bhidden(?:\s|$)/.test(attributes)));
  const siblings=nodes.filter(node=>node.parents.length===panel.parents.length&&node.parents.every((id,i)=>id===panel.parents[i]));
  const index=siblings.indexOf(panel);
  assert.equal(siblings[index-1].id,'quickForm');
  assert.equal(siblings[index+1].id,'quickReview');
  assert.match(panel.attributes,/data-chatgpt-session="disabled"/);
  assert.match(panel.attributes,/\bhidden(?:\s|$)/);
  assert.ok(find('quickChatGPTAsk').parents.includes('quickReflection'));
  assert.ok(find('quickChatGPTAsk').parents.includes('quickReplay'));
  for(const configured of [false,'session']){
    const {get,calls,fire}=await mount([],configured);
    assert.equal(get('quickChatGPTConnection').hidden,!configured);
    assert.equal(get('quickReplay').hidden,true);
    assert.equal(get('quickResult').hidden,true);
    assert.deepEqual(calls.map(call=>call.path),['/api/model-shop']);
    await fire('quickChatGPTStatusCheck');
    assert.deepEqual(calls.map(call=>call.path),configured?['/api/model-shop','/api/chatgpt-session']:['/api/model-shop']);
  }
});

test('session UI is opt-in, click-only, read-only and reports disconnection without a generated reply',async()=>{
  const disabled=await mount();
  assert.equal(disabled.get('quickChatGPTConnection').hidden,true);
  await disabled.fire('quickChatGPTStatusCheck');
  assert.equal(disabled.calls.filter(x=>x.path==='/api/chatgpt-session').length,0);
  const {get,fire,state,calls}=await mount([],'session');
  assert.equal(get('quickChatGPTConnection').hidden,false);
  assert.equal(calls.filter(x=>x.path==='/api/chatgpt-session').length,0);
  await fire('quickChatGPTStatusCheck');
  assert.match(get('quickChatGPTStatus').textContent,/接続済み・共有許可あり/);
  state.session=async()=>({connected:false,sharing:false});
  await fire('quickChatGPTStatusCheck');
  assert.match(get('quickChatGPTStatus').textContent,/未接続.*応答は生成していません/);
  state.session=async()=>{throw Error('SECRET');};
  await fire('quickChatGPTStatusCheck');
  assert.match(get('quickChatGPTStatus').textContent,/確認できません/);
  assert.doesNotMatch(get('quickChatGPTStatus').textContent,/SECRET/);
  assert.equal(calls.filter(x=>x.path==='/api/chatgpt-dialogue').length,0);
  assert.equal(get('quickChatGPTReply').textContent,'');
});

test('pagehide discards a late session read and prevents another request while it is pending',async()=>{
  const {get,fire,state,calls,pagehide}=await mount([],'session');
  let release;
  state.session=()=>new Promise(resolve=>{release=resolve;});
  const pending=fire('quickChatGPTStatusCheck');
  for(let i=0;i<5;i++)await Promise.resolve();
  pagehide();
  await fire('quickChatGPTStatusCheck');
  release({connected:true,sharing:true});await pending;
  assert.equal(get('quickChatGPTStatus').textContent,'');
  assert.equal(calls.filter(x=>x.path==='/api/chatgpt-session').length,1);
});

test('browser deadline discards uncooperative late completion and blocks click spam',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {get,fire,state,calls}=await mount([],true);
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  await shareReflection(get,fire);
  let release;
  state.dialogue=()=>new Promise(resolve=>{release=resolve;});
  const pending=fire('quickChatGPTAsk');
  t.mock.timers.tick(55000);
  await fire('quickChatGPTAsk');
  assert.equal(calls.filter(x=>x.path==='/api/chatgpt-dialogue').length,1);
  release({status:'ok',commentary:'STALE AFTER DEADLINE'});
  await pending;
  assert.doesNotMatch(get('quickChatGPTReply').textContent,/STALE/);
  assert.match(get('quickChatGPTReply').textContent,/取得できませんでした/);
});

test('free manual bridge markup is accessible, separate, and narrow-screen friendly',()=>{
  const nodes=htmlNodes(),get=id=>nodes.find(node=>node.id===id);
  assert.equal(get('quickFreeChatGPT').tag,'section');
  assert.ok(get('quickFreeChatGPT').parents.includes('quickReflection'));
  assert.ok(!get('quickFreeChatGPT').parents.includes('quickChatGPT'));
  assert.match(get('quickFreeChatGPT').attributes,/hidden/);
  assert.match(get('quickFreePrompt').attributes,/readonly/);
  assert.match(get('quickFreePrompt').attributes,/rows="6"/);
  assert.match(get('quickFreePaste').attributes,/maxlength="1500"/);
  for(const id of ['quickFreeCopy','quickFreeShow'])assert.match(get(id).attributes,/type="button"/);
  const link=nodes.find(node=>node.tag==='a'&&node.parents.includes('quickFreeChatGPT'));
  assert.match(link.attributes,/href="https:\/\/chatgpt.com\/"/);
  assert.match(link.attributes,/target="_blank"/);
  assert.match(link.attributes,/rel="noopener noreferrer"/);
  assert.match(html,/ChatGPTを開く（無料版も可）/);
  assert.match(html,/手動 \/ MANUAL/);
  assert.match(html,/アプリ内API連携ではありません/);
  assert.match(html,/送信操作により質問がOpenAIに渡ります/);
  assert.match(html,/サイトを開くだけでは文は転送・貼り付けされません/);
  assert.match(html,/#quickFreeChatGPT textarea\{[^}]*box-sizing:border-box;[^}]*width:100%;[^}]*min-width:0/);
  assert.match(html,/#quickFreeChatGPT button,#quickFreeChatGPT a\{[^}]*white-space:normal;overflow-wrap:anywhere/);
  assert.match(html,/#quickFreeAnswer\{white-space:pre-wrap;overflow-wrap:anywhere/);
});

test('free bridge works without client, generates exact quoted reflection, and copies only on click',async()=>{
  for(const configured of [false,true]) {
    const {get,fire,calls,copies,storageWrites}=await mount([],configured);
    assert.equal(get('quickFreeChatGPT').hidden,true);
    await fire('quickFreeCopy');
    assert.equal(copies.length,0);
    await fire('quickForm','submit');await fire('quickRun');
    assert.equal(get('quickFreeChatGPT').hidden,true); // day 0
    await fire('quickFollowing');
    assert.equal(get('quickFreeChatGPT').hidden,true); // not compared
    const note='引用 " </textarea><img src=x onerror=alert(1)> & \\';
    await shareReflection(get,fire,'wait','drop',note);
    assert.equal(get('quickFreeChatGPT').hidden,false);
    const prompt=get('quickFreePrompt').value;
    assert.ok(prompt.length<=1000);
    assert.ok(prompt.includes(JSON.stringify({choice:'wait',reason:'下落リスク',note})));
    assert.match(prompt,/第1日/);
    assert.match(prompt,/AI記録LONG/);
    assert.match(prompt,/AI判断・結果を見た後の振り返り（事前予測でない）/);
    assert.match(prompt,/真因の捏造・実取引助言・変更・学習は禁止/);
    assert.match(prompt,/価格・指標の根拠は未提供/);
    assert.match(prompt,/理由から選択を決めつけず本人の意図を日本語で1問/);
    assert.equal(copies.length,0);
    const before=calls.slice();
    await fire('quickFreeCopy');
    assert.deepEqual(copies,[prompt]);
    assert.match(get('quickFreeCopyStatus').textContent,/コピーしました/);
    get('quickFreePaste').value='<script>alert(1)</script>\n<img src=x onerror=alert(1)> **text**';
    await fire('quickFreePaste','input');
    assert.equal(get('quickFreeAnswer').textContent,'');
    await fire('quickFreeShow');
    assert.equal(get('quickFreeAnswer').textContent,'未検証のユーザー貼り付け（UNVERIFIED USER-PASTED）：\n'+get('quickFreePaste').value);
    assert.deepEqual(calls,before);
    assert.deepEqual(storageWrites,[]);
    assert.equal(get('quickChatGPTReply').textContent,'');
    if(configured) {
      await fire('quickChatGPTAsk');
      assert.equal(get('quickFreeChatGPT').hidden,false);
      assert.equal(get('quickFreePrompt').value,prompt);
      assert.equal(calls.filter(x=>x.path==='/api/chatgpt-dialogue').length,1);
    }
  }
});

test('copy failure offers manual selection; clipboard completion cannot revive old content',async()=>{
  for(const fail of [false,true]) {
    const {get,fire,state}=await mount();
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    await shareReflection(get,fire);
    state.copy=async()=>{throw Error('SECRET');};
    await fire('quickFreeCopy');
    assert.match(get('quickFreeCopyStatus').textContent,/質問文の欄を選択.*手動でコピー/);
    assert.doesNotMatch(get('quickFreeCopyStatus').textContent,/SECRET/);
    let resolve,reject;
    state.copy=()=>new Promise((ok,no)=>{resolve=ok;reject=no;});
    const pending=fire('quickFreeCopy');
    await fire('quickFollowing');
    if(fail)reject(Error('SECRET'));else resolve();
    await pending;
    assert.equal(get('quickFreeCopyStatus').textContent,'');
    assert.equal(get('quickFreePrompt').value,'');
  }
});

test('manual prompt and pasted answer are bounded even for escaped input and bypassed maxlength',async()=>{
  const {get,fire}=await mount();
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  for(const note of ['\u0000'.repeat(120),'😀'.repeat(60),'x'.repeat(120)]) {
    await shareReflection(get,fire,'buy','limit',note);
    const prompt=get('quickFreePrompt').value;
    assert.ok(prompt.length<=1000,`length ${prompt.length}`);
    assert.ok(prompt.includes(JSON.stringify(note)));
  }
  // Longest structured input, two-digit day and both recorded signals.
  for(let day=2;day<=12;day++) {
    await fire('quickFollowing');
    const note='\u0000'.repeat(120);
    await shareReflection(get,fire,'wait','limit',note);
    const prompt=get('quickFreePrompt').value;
    assert.ok(prompt.length<=1000,`day ${day}: length ${prompt.length}`);
    assert.ok(prompt.includes(JSON.stringify({choice:'wait',reason:'損失を抑えたい',note})));
  }
  get('quickFreePaste').value='x'.repeat(1600);
  await fire('quickFreePaste','input');
  assert.equal(get('quickFreePaste').value.length,1500);
  get('quickFreePaste').value='😀'.repeat(800);
  await fire('quickFreeShow');
  assert.equal(get('quickFreePaste').value.length,1500);
  assert.ok(get('quickFreeAnswer').textContent.endsWith('😀'.repeat(750)));
  get('quickFreePaste').value='';await fire('quickFreePaste','input');
  assert.equal(get('quickFreeAnswer').textContent,'');
  await fire('quickFreeShow');assert.equal(get('quickFreeAnswer').textContent,'');
  await shareReflection(get,fire,'wait','other','x'.repeat(121));
  assert.equal(get('quickFreeChatGPT').hidden,true);
  assert.equal(get('quickFreePrompt').value,'');
});

test('free bridge clears on edits, navigation, new run, modes, invalid input, reflection errors and pagehide',async()=>{
  for(const change of ['choice','reason','note','day','day0','retry','model','amount','leverage','run','invalid','native-invalid','pagehide']) {
    const {get,fire,state,pagehide}=await mount([],true);
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    await shareReflection(get,fire);
    await fire('quickFreeCopy');
    get('quickFreePaste').value='STALE';await fire('quickFreeShow');
    if(['choice','reason','note'].includes(change)) {
      const id={choice:'quickHumanChoice',reason:'quickHumanReason',note:'quickHumanNote'}[change];
      get(id).value='changed';await fire(id,'input');
    }
    if(change==='day')await fire('quickFollowing');
    if(change==='day0')await fire('quickPrevious');
    if(change==='retry')await fire('quickAgain');
    if(change==='model'){get('quickModel').value='other';await fire('quickModel','change');}
    if(change==='amount'){get('quickAmount').value='23';await fire('quickAmount','input');}
    if(change==='leverage'){get('quickLeverage').value='2';await fire('quickLeverage','change');}
    if(change==='run'){state.practice=async()=>{throw Error('failure');};await fire('quickForm','submit');await fire('quickRun');}
    if(change==='invalid'){get('quickHumanReason').value='bad';await fire('quickReflectionForm','submit');}
    if(change==='native-invalid')await fire('quickHumanChoice','invalid');
    if(change==='pagehide')pagehide();
    assert.equal(get('quickFreeChatGPT').hidden,true,change);
    assert.equal(get('quickFreePrompt').value,'',change);
    assert.equal(get('quickFreePaste').value,'',change);
    assert.equal(get('quickFreeAnswer').textContent,'',change);
    assert.equal(get('quickFreeCopyStatus').textContent,'',change);
    await fire('quickFreeCopy');await fire('quickFreeShow');
    assert.equal(get('quickFreeAnswer').textContent,'',change);
  }
  const fresh=await mount();
  assert.equal(fresh.get('quickFreeChatGPT').hidden,true);
  assert.equal(fresh.get('quickFreePrompt').value,'');
  assert.equal(fresh.get('quickFreePaste').value,'');
  assert.equal(fresh.get('quickFreeAnswer').textContent,'');
});


test('manual bridge survives automatic dialogue and session check errors',async()=>{
  for(const change of ['auto-error','status-error']) {
    const {get,fire,state,copies}=await mount([],change==='status-error'?'session':true);
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    await shareReflection(get,fire);
    const prompt=get('quickFreePrompt').value;
    get('quickFreePaste').value='手動の返答';await fire('quickFreeShow');
    const answer=get('quickFreeAnswer').textContent;
    if(change==='auto-error'){state.dialogue=async()=>{throw Error('failure');};await fire('quickChatGPTAsk');}
    else {state.session=async()=>{throw Error('failure');};await fire('quickChatGPTStatusCheck');}
    assert.equal(get('quickFreeChatGPT').hidden,false,change);
    assert.equal(get('quickFreePrompt').value,prompt,change);
    assert.equal(get('quickFreePaste').value,'手動の返答',change);
    assert.equal(get('quickFreeAnswer').textContent,answer,change);
    await fire('quickFreeCopy');
    assert.deepEqual(copies,[prompt],change);
    assert.match(get('quickFreeCopyStatus').textContent,/コピーしました/);
    await fire('quickFreeShow');
    assert.equal(get('quickFreeAnswer').textContent,answer,change);
  }
});

test('missing clipboard API safely offers manual copying',async()=>{
  const {get,fire,state}=await mount();
  await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
  await shareReflection(get,fire);
  delete state.navigator.clipboard;
  await fire('quickFreeCopy');
  assert.match(get('quickFreeCopyStatus').textContent,/質問文の欄を選択.*手動でコピー/);
  assert.equal(get('quickFreeChatGPT').hidden,false);
});


test('saved strategy stays bound to self replay and fits escaped notes without truncation',async()=>{
  for(const [approach,label] of [['trend','トレンド'],['momentum','勢い'],['reversion','平均回帰'],['volatility','変動率']]) {
    const {get,fire,state,calls,copies,storageWrites}=await mount();
    const practice=state.practice;
    const strategy={source:'saved_companion',approach,risk_percent:100};
    state.practice=async body=>({...await practice(body),model_id:'self',companion_strategy:strategy});
    await fire('quickForm','submit');await fire('quickRun');
    assert.equal(get('quickCompanionStrategy').hidden,false);
    assert.match(get('quickCompanionStrategy').textContent,/今回の相棒の設定/);
    assert.ok(get('quickCompanionStrategy').textContent.includes('買う／待つを判断する分析は'+label+'だけ'));
    assert.match(get('quickCompanionStrategy').textContent,/買うと判断した場合に資金の100%を使います/);
    assert.match(get('quickCompanionStrategy').textContent,/資金の割合は買う／待つの判断に影響しません/);
    assert.match(get('quickCompanionStrategy').textContent,/待つ場合は株を保有しません/);
    assert.match(get('quickCompanionStrategy').textContent,/この設定だけでは、その日の選択理由は分かりません/);
    assert.doesNotMatch(get('quickCompanionStrategy').textContent,/LONG|CASH|重み/);
    strategy.approach='trend';strategy.risk_percent=5;
    get('creatorApproach').value='trend';get('creatorRisk').value='5';
    const before=calls.length;
    for(let day=1;day<=12;day++) {
      await fire('quickFollowing');
      const note='\u0000'.repeat(120);
      for(const choice of ['buy','wait'])for(const [reason,reasonLabel] of [
        ['trend','値動きの流れ'],['drop','下落リスク'],['limit','損失を抑えたい'],['other','その他'],
      ]) {
        await shareReflection(get,fire,choice,reason,note);
        const prompt=get('quickFreePrompt').value;
        assert.ok(prompt.length<=1000,`${approach} day ${day} ${choice}/${reason}: ${prompt.length}`);
        assert.ok(prompt.includes(JSON.stringify({choice,reason:reasonLabel,note})));
        assert.ok(prompt.includes('適用した保存設定：方向の分析は'+label+'のみ。資金100%はLONG後の使用割合で、LONG/CASHに影響なし'));
        assert.match(prompt,/CASH＝保有なし/);
        assert.doesNotMatch(prompt,/trend|momentum|reversion|volatility/);
        assert.match(prompt,/設定は当日の理由の証明ではない/);
        assert.match(prompt,/AI判断・結果を見た後の振り返り（事前予測でない）/);
        assert.match(prompt,/価格・指標の根拠は未提供/);
        assert.match(prompt,/考え・設定・判断を区別し、理由から選択を決めつけず本人の意図を日本語で1問/);
        assert.match(prompt,/真因の捏造・実取引助言・変更・学習は禁止/);
      }
    }
    assert.equal(calls.length,before);assert.deepEqual(copies,[]);assert.deepEqual(storageWrites,[]);
    await fire('quickAgain');
    assert.equal(get('quickCompanionStrategy').hidden,true);
    assert.equal(get('quickCompanionStrategy').textContent,'');
    assert.equal(get('quickFreePrompt').value,'');
    state.practice=async body=>({...await practice(body),model_id:'self',companion_strategy:null});
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    await shareReflection(get,fire);
    assert.match(get('quickFreePrompt').value,/保存設定の情報なし/);
    assert.doesNotMatch(get('quickFreePrompt').value,/適用した保存設定/);
  }
});

test('missing, demo, mismatched and malformed strategies are ignored without HTML insertion',async()=>{
  const valid={source:'saved_companion',approach:'momentum',risk_percent:35};
  const bad=[undefined,null,[],true,'saved_companion',{},
    {...valid,source:'editor'},{...valid,approach:'<img src=x onerror=alert(1)>'},
    {...valid,approach:{toString:null}},{...valid,approach:null},
    {...valid,approach:['trend']},{...valid,approach:7},
    {...valid,approach:'__proto__'},{...valid,approach:'toString'},
    {...valid,risk_percent:'35'},{...valid,risk_percent:4},{...valid,risk_percent:101},
    {...valid,risk_percent:7},
    {...valid,risk_percent:5.5},{...valid,risk_percent:NaN},{...valid,risk_percent:Infinity},
    {...valid,extra:'<script>alert(1)</script>'}];
  for(const [model,responseModel,strategy] of [
    ...bad.map(value=>['self','self',value]),['demo_stub','demo_stub',valid],
    ['self','demo_stub',valid],['self',undefined,valid],
  ]) {
    const {get,fire,state}=await mount([{id:'demo_stub',name:'Demo',owned:true}]);
    const practice=state.practice;
    state.practice=async body=>({...await practice(body),model_id:responseModel,companion_strategy:strategy});
    get('quickModel').value=model;
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    assert.equal(get('quickReplay').hidden,false);
    assert.equal(get('quickCompanionStrategy').hidden,true);
    assert.equal(get('quickCompanionStrategy').textContent,'');
    await shareReflection(get,fire);
    assert.match(get('quickFreePrompt').value,/保存設定の情報なし/);
    assert.doesNotMatch(get('quickFreePrompt').value,/適用した保存設定|<img|<script/);
  }
});

test('saved context and manual prompt clear on practice invalidation and failed rerun',async()=>{
  for(const change of ['model','amount','leverage','retry','failure']) {
    const {get,fire,state}=await mount();
    const practice=state.practice;
    state.practice=async body=>({...await practice(body),model_id:'self',
      companion_strategy:{source:'saved_companion',approach:'reversion',risk_percent:5}});
    await fire('quickForm','submit');await fire('quickRun');await fire('quickFollowing');
    await shareReflection(get,fire);
    assert.equal(get('quickCompanionStrategy').hidden,false);
    assert.match(get('quickFreePrompt').value,/適用した保存設定：方向の分析は平均回帰のみ。資金5%はLONG後の使用割合/);
    if(change==='model'){get('quickModel').value='demo_stub';await fire('quickModel','change');}
    if(change==='amount'){get('quickAmount').value='5';await fire('quickAmount','input');}
    if(change==='leverage'){get('quickLeverage').value='2';await fire('quickLeverage','change');}
    if(change==='retry')await fire('quickAgain');
    if(change==='failure'){
      state.practice=async()=>{throw Error('failure');};
      await fire('quickForm','submit');await fire('quickRun');
    }
    assert.equal(get('quickCompanionStrategy').hidden,true,change);
    assert.equal(get('quickCompanionStrategy').textContent,'',change);
    assert.equal(get('quickFreePrompt').value,'',change);
  }
});


async function startPreReveal(ui) {
  await ui.fire('quickForm','submit');
  ui.get('quickPreOptIn').checked=true;
  await ui.fire('quickRun');
}
function assertPreCue(get,reaction,owner='冒険ガイド') {
  const cue=get('quickPreCue');
  assert.equal(cue.hidden,!reaction);
  assert.equal(cue.dataset.reaction,reaction);
  const [icon,label]={
    anticipation:['💭','選択を見守り中'],
    buy:['🌱','「買う」を選んだね'],
    wait:['🍃','「待つ」を選んだね'],
  }[reaction]||['',''];
  assert.equal(get('quickPreCueIcon').textContent,icon);
  assert.equal(get('quickPreCueText').textContent,reaction ? owner+'：'+label : '');
}
function assertFinalHidden(get) {
  for(const id of ['quickResult','quickReplay','quickNext'])assert.equal(get(id).hidden,true,id);
  assert.equal(get('quickResult').children.length,0);
  for(const id of ['quickReplayDay','quickReplayContext','quickCompanionStrategy'])assert.equal(get(id).textContent,'');
  for(const id of ['quickBestDay','quickWorstDay']) {
    assert.equal(get(id).disabled,true);
    assert.doesNotMatch(get(id).textContent,/第[0-9]+日| C/);
  }
}
test('pre-reveal speaker requires a saved companion and the choice compares with the current AI',async()=>{
  const savedName='<b>秘密の相棒</b>';
  const savedStrategy={source:'saved_companion',approach:'trend',risk_percent:35};
  const prompts=[
    '最初の分かれ道だね。ここまでの値動きを見て、どう進もう？',
    '冒険の折り返し。ひと息ついて、次の一歩を選ぼう。',
    '最後の分かれ道だね。自分のペースで選ぼう。',
  ];
  for(const [scenario,model,responseModel,name,strategy] of [
    ['saved self','self','self',savedName,savedStrategy],
    ['unsaved self','self','self',null,null],
    ['demo','demo','demo',null,null],
    ['demo with saved metadata','demo','demo',savedName,savedStrategy],
    ['demo response to self request','self','demo',savedName,savedStrategy],
    ['self response to demo request','demo','self',savedName,savedStrategy],
    ['missing response model','self',undefined,savedName,savedStrategy],
    ['missing strategy','self','self',savedName,undefined],
    ['missing name','self','self',undefined,savedStrategy],
    ['blank name','self','self','  ',savedStrategy],
    ['non-string name','self','self',[savedName],savedStrategy],
    ['invalid strategy source','self','self',savedName,{...savedStrategy,source:'default'}],
    ['invalid strategy risk','self','self',savedName,{...savedStrategy,risk_percent:0}],
  ])for(const loss of [false,true]) {
    const ui=await mount([{id:'demo',name:'別のAI',owned:true}]),{get,fire,state,calls,storageWrites}=ui;
    get('quickModel').value=model;
    get('speech').textContent='自分の相棒の声';get('scene').dataset.mood='ready';
    get('companionName').textContent='未保存の名前';
    showComposite(get);
    const sourceArt=miniSlots.slice(0,4).map(slot=>get('artwork'+slot));
    const practice=state.practice;
    state.practice=async body=>({...await practice(body),model_id:responseModel,
      companion_name:name,companion_strategy:strategy,
      daily_ai_signals:Array(12).fill(loss?'CASH':'LONG'),
      daily_synthetic_prices:Array.from({length:13},(_,i)=>loss?900000-i*1234:100000+i*4567),
      daily_balances:Array.from({length:13},(_,i)=>10000+(loss?-1:1)*i*50),
      final_balance:loss?9400:10600,profit_coins:loss?-600:600,liquidated_at_step:loss?1:null});
    assert.equal(get('quickPreBuddyLine').textContent,'');
    assertPreCue(get);
    await startPreReveal(ui);
    const owner=scenario==='saved self'?'相棒':'冒険ガイド';
    const label=owner+'（定型文）：';
    for(const [index,prompt] of prompts.entries()) {
      assertPreCue(get,'anticipation',owner);
      assertMiniCleared(get);
      const line=get('quickPreBuddyLine').textContent;
      assert.ok(line.length<=65,'keep the line compact');
      assert.equal(line,label+prompt,scenario);
      assert.equal(get('quickPreBuddyLine').children.length,0);
      assert.equal(get('speech').textContent,'自分の相棒の声');
      assert.equal(get('scene').dataset.mood,'ready');
      assert.equal(get('companionName').textContent,'未保存の名前');
      assertFinalHidden(get);
      const waits=index===1;
      await fire(waits?'quickPreWait':'quickPreBuy');
      assertPreCue(get,waits?'wait':'buy',owner);
      assertMiniCleared(get);
      assert.equal(get('quickPreBuddyLine').textContent,label+'あなたの選択は、今回使ったAIの判断'+
        (waits===loss?'と同じだったね。':'とは違ったね。'),scenario);
      await fire('quickPreNext');
    }
    assert.equal(get('quickPreBuddyLine').textContent,'');
    assertPreCue(get);
    for(const [i,source] of sourceArt.entries()) {
      assert.equal(source.src,'blob:current-'+miniSlots[i]);
      assert.equal(source.srcAssignments,1);
    }
    if(model!=='self'||(responseModel!==undefined&&responseModel!=='self')) {
      assertMiniCleared(get);
      assert.equal(get('speech').textContent,'自分の相棒の声');
      await fire('quickFollowing');
      assert.equal(get('scene').dataset.mood,'ready');
    }
    assert.equal(calls.length,2);assert.deepEqual(storageWrites,[]);
  }
});

// Explicit expectations keep AI agreement separate from the price comparison.
for(const [direction,price,buyVerdict,waitVerdict] of [
  ['UP',7213,'値動きに合う','値動きに合わない'],
  ['DOWN',7013,'値動きに合わない','値動きに合う'],
  ['FLAT',7113,'判定なし（価格変化なし）','判定なし（価格変化なし）'],
])for(const choice of ['buy','wait'])for(const signal of ['LONG','CASH']) {
  test('pre-reveal direction '+direction+' / '+choice+' / '+signal,async()=>{
    const ui=await mount(),{get,fire,state,calls,storageWrites}=ui;
    const practice=state.practice;
    let response;
    state.practice=async body=>{
      response=await practice(body);
      response.daily_synthetic_prices=Array.from({length:13},(_,i)=>7000+i*113);
      response.daily_synthetic_prices[2]=7113;
      response.daily_synthetic_prices[3]=price;
      response.daily_ai_signals[2]=signal;
      return response;
    };
    const untouched=['growthInfo','growthAchievements','reward','claim','play','companionName'];
    const saved=untouched.map(id=>[get(id).value,get(id).textContent,get(id).disabled]);
    await startPreReveal(ui);
    const before=structuredClone(response),requests=structuredClone(calls);
    assertFinalHidden(get);
    assertPreCue(get,'anticipation');
    const initial=get('quickPreOutcome').textContent+get('quickPreBuddyLine').textContent;
    assert.doesNotMatch(initial,/値動きとの比較|値動きに合|判定なし|終値：|%/);
    for(let i=3;i<=12;i++) {
      const formatted=response.daily_synthetic_prices[i].toLocaleString('ja-JP');
      assert.ok(!initial.includes(formatted));
      if(direction!=='FLAT' || i!==3)assert.ok(!get('quickPreSnapshot').textContent.includes(formatted));
    }
    await fire(choice==='buy'?'quickPreBuy':'quickPreWait');
    assertPreCue(get,choice);
    const outcome=get('quickPreOutcome').textContent;
    assert.ok(outcome.includes('値動きとの比較：自分は'+(choice==='buy'?buyVerdict:waitVerdict)+
      '、AIは'+(signal==='LONG'?buyVerdict:waitVerdict)+'。'));
    const agrees=(choice==='buy' && signal==='LONG') || (choice==='wait' && signal==='CASH');
    assert.ok(get('quickPreBuddyLine').textContent.includes('今回使ったAIの判断'+
      (agrees?'と同じだったね。':'とは違ったね。')));
    assert.doesNotMatch(get('quickPreBuddyLine').textContent,/正解|正答|的中|成功|失敗|損益|利益|[0-9%]/);
    assert.ok(outcome.includes('% ／ '+(agrees?'一致':'相違')+'。'));
    assert.equal(outcome.match(/架空価格の方向だけ。実際の損益や予測の上手さを示しません。/g)?.length,1);
    assert.doesNotMatch(outcome,/LONG|CASH|正解|正答率|スコア/);
    assert.ok(outcome.includes('架空の終値：'+price.toLocaleString('ja-JP')));
    for(let i=4;i<=12;i++)assert.ok(!outcome.includes(response.daily_synthetic_prices[i].toLocaleString('ja-JP')));
    assertFinalHidden(get);
    await fire('quickPreNext');
    assertPreCue(get,'anticipation');
    assert.doesNotMatch(get('quickPreBuddyLine').textContent,/今回使ったAIの判断/);
    assert.doesNotMatch(get('quickPreOutcome').textContent,/値動きとの比較|判定なし/);
    await fire('quickPreSkip');
    assertPreCue(get);
    assert.equal(get('quickPreBuddyLine').textContent,'');
    assert.doesNotMatch(get('quickPreOutcome').textContent+get('quickPreSummary').textContent,/値動きとの比較|判定なし/);
    assert.match(get('quickPreSummary').textContent,new RegExp('AI方針との一致 '+(agrees?1:0)+'/1回答'));
    assert.deepEqual(response,before,'no price, signal or model changes');
    assert.deepEqual(calls,requests,'no requests for choices, next or skip');
    assert.deepEqual(calls,[{path:'/api/model-shop',body:undefined},
      {path:'/api/quick-practice',body:{model_id:'self',amount:1000,leverage:1}}]);
    assert.deepEqual(storageWrites,[]);
    assert.deepEqual(untouched.map(id=>[get(id).value,get(id).textContent,get(id).disabled]),saved);
  });
}
test('pre-reveal small nonzero moves are not treated as unchanged after rounding',async()=>{
  for(const delta of [-0.001,0.001]) {
    const ui=await mount(),{get,fire,state}=ui,practice=state.practice;
    state.practice=async body=>{
      const result=await practice(body);
      result.daily_synthetic_prices[3]=result.daily_synthetic_prices[2]+delta;
      return result;
    };
    await startPreReveal(ui);await fire('quickPreBuy');
    assert.ok(get('quickPreOutcome').textContent.includes('値動きとの比較：自分は'+
      (delta>0?'値動きに合う':'値動きに合わない')));
    assert.doesNotMatch(get('quickPreOutcome').textContent,/判定なし/);
  }
});
test('default mode and skipping before any answer show no direction verdict',async()=>{
  for(const optIn of [false,true]) {
    const ui=await mount(),{get,fire,calls,storageWrites}=ui;
    await fire('quickForm','submit');get('quickPreOptIn').checked=optIn;await fire('quickRun');
    if(optIn)await fire('quickPreSkip');
    for(const id of ['quickPreOutcome','quickPreSummary'])
      assert.doesNotMatch(get(id).textContent,/値動きとの比較|値動きに合|判定なし|架空価格の方向だけ/);
    assert.equal(get('quickPreReveal').hidden,true);
    assertPreCue(get);
    assert.equal(get('quickPreOutcome').textContent,optIn?'この日のAI判断・価格変化は、選択してから表示します。':'');
    assert.equal(calls.length,2);assert.deepEqual(storageWrites,[]);
  }
});
test('optional pre-reveal uses only fixed past windows, records once and shares the exact normal reveal',async()=>{
  const ui=await mount(),{get,fire,calls,storageWrites,state}=ui;
  const normal=await mount();
  await normal.fire('quickForm','submit');await normal.fire('quickRun');
  assert.equal(normal.get('quickPreOptIn').checked,false);
  assert.equal(normal.get('quickPreReveal').hidden,true);
  assert.equal(normal.get('quickPreSummary').hidden,true);
  assert.equal(normal.get('quickPreBuddyLine').textContent,'');
  const practice=state.practice;
  let received;
  state.practice=async body=>{
    received=await practice(body);
    received.daily_synthetic_prices=Array.from({length:13},(_,i)=>7000+i*13);
    return received;
  };
  await startPreReveal(ui);
  assert.deepEqual(calls.at(-1),{path:'/api/quick-practice',body:{model_id:'self',amount:1000,leverage:1}});
  const before=structuredClone(received);
  const histories=[
    '開始時 7,000 ／ 第1日 7,013 ／ 第2日 7,026',
    '第4日 7,052 ／ 第5日 7,065 ／ 第6日 7,078',
    '第8日 7,104 ／ 第9日 7,117 ／ 第10日 7,130',
  ];
  for(const [index,day] of [3,7,11].entries()) {
    assertFinalHidden(get);
    assert.equal(get('quickPreReveal').hidden,false);
    const snapshot=get('quickPreSnapshot').textContent;
    assert.ok(snapshot.startsWith('判断 '+(index+1)+'/3：第'+day+'日'));
    assert.equal(snapshot,'判断 '+(index+1)+'/3：第'+day+'日 ／ 過去の架空価格：'+histories[index]);
    assert.doesNotMatch(snapshot,/第0日/);
    for(let i=0;i<=12;i++) {
      const price=received.daily_synthetic_prices[i].toLocaleString('ja-JP');
      assert.equal(snapshot.includes(price),i>=day-3 && i<day,'price Day '+i);
    }
    assert.doesNotMatch(get('quickPreOutcome').textContent,/LONG|CASH|終値：|%|損益：/);
    assert.equal(get('quickPreNext').disabled,true);
    assert.equal(get('quickPreNext').textContent,index===2?'12日間の結果を見る':'次へ');
    await fire('quickPreNext'); // no answer: no progression
    assert.equal(get('quickPreSnapshot').textContent,snapshot);
    await fire(index===1?'quickPreWait':'quickPreBuy');
    const outcome=get('quickPreOutcome').textContent;
    assert.match(outcome,new RegExp('第'+day+'日：'));
    assert.match(outcome,index===1?/相違/:/一致/);
    assert.doesNotMatch(outcome.replace('実際の損益や予測の上手さを示しません。',''),/損益|残高|スコア/);
    for(let i=day+1;i<=12;i++)assert.ok(!outcome.includes(received.daily_synthetic_prices[i].toLocaleString('ja-JP')));
    await fire('quickPreBuy');await fire('quickPreWait');await fire('quickPreSkip');
    assert.equal(get('quickPreOutcome').textContent,outcome);
    assertFinalHidden(get);
    assert.equal(get('quickPreReveal').hidden,false,'keep the outcome visible until Next');
    assert.equal(get('quickPreSummary').hidden,true);
    assert.equal(get('quickPreSummary').textContent,'');
    assert.ok(outcome.includes('架空の終値：'+received.daily_synthetic_prices[day].toLocaleString('ja-JP')));
    assert.equal(get('quickPreNext').disabled,false);
    assert.equal(ui.document.activeElement,get('quickPreNext'));
    for(const id of ['quickPreBuy','quickPreWait','quickPreSkip'])assert.equal(get(id).disabled,true);
    assert.equal(calls.length,2,'no requests while holding or answering');
    await fire('quickPreNext');await fire('quickPreNext');
  }
  assert.equal(get('quickPreReveal').hidden,true);
  assert.equal(get('quickPreBuddyLine').textContent,'');
  assert.equal(get('quickPreSummary').hidden,false);
  assert.match(get('quickPreSummary').textContent,/回答 3\/3回.*一致 2\/3回答/);
  assert.equal(get('quickPreSummary').textContent,
    '結果を見る前の記録：回答 3/3回 ／ AI方針との一致 2/3回答。'+
    '第3日：買う（一致） ／ 第7日：待つ（相違） ／ 第11日：買う（一致）。未回答は集計しません。'+
    'AIとの一致数は正解数ではありません。利益や実際の投資技能の評価ではありません。');
  assert.equal(get('quickPreSummary').textContent.match(/第[0-9]+日/g).length,3);
  assert.match(get('quickPreSummary').textContent,/第11日：買う（一致）/);
  assert.doesNotMatch(get('quickPreSummary').textContent,/架空の終値|架空価格の前日比|自分は買う/);
  assert.equal(get('quickPreSummary').textContent.match(/投資技能の評価ではありません/g).length,1);
  assert.deepEqual(get('quickResult').children.map(n=>n.textContent),normal.get('quickResult').children.map(n=>n.textContent));
  for(const id of ['quickResult','quickReplay','quickNext'])assert.equal(get(id).hidden,false);
  assert.deepEqual(received,before,'no result or model mutation');
  assert.equal(calls.length,2);assert.deepEqual(storageWrites,[]);
});
test('checkpoint completion and skip preserve normal and 25x financial displays and responses',async()=>{
  for(const leverage of [1,25]) {
    const normal=await mount();
    const response=await normal.state.practice({amount:1000,leverage});
    if(leverage===25)Object.assign(response,{final_balance:9000,profit_coins:-1000,
      liquidated_at_step:2,daily_balances:[10000,9500,...Array(11).fill(9000)]});
    const original=structuredClone(response);
    normal.state.practice=async()=>response;
    normal.get('quickLeverage').value=String(leverage);
    await normal.fire('quickForm','submit');await normal.fire('quickRun');
    const result=normal.get('quickResult').children.map(node=>node.textContent),days=[];
    for(let day=0;day<=12;day++) {
      days.push(['quickReplayDay','quickReplayContext'].map(id=>normal.get(id).textContent));
      await normal.fire('quickFollowing');
    }
    for(const finish of ['complete','skip']) {
      const ui=await mount(),{get,fire,state,calls,storageWrites}=ui;
      state.practice=async()=>response;
      get('quickLeverage').value=String(leverage);
      await startPreReveal(ui);
      if(finish==='skip')await fire('quickPreSkip');
      else for(let index=0;index<3;index++){await fire('quickPreWait');await fire('quickPreNext');}
      assert.deepEqual(get('quickResult').children.map(node=>node.textContent),result);
      for(let day=0;day<=12;day++) {
        assert.deepEqual(['quickReplayDay','quickReplayContext'].map(id=>get(id).textContent),days[day]);
        await fire('quickFollowing');
      }
      assert.deepEqual(response,original);
      assert.deepEqual(calls,normal.calls);
      assert.deepEqual(storageWrites,[]);
    }
  }
});
test('skip records only answered checkpoints, including zero answers',async()=>{
  for(const count of [0,1,2]) {
    const ui=await mount(),{get,fire,calls}=ui;
    await startPreReveal(ui);
    for(let i=0;i<count;i++){await fire('quickPreBuy');await fire('quickPreNext');}
    await fire('quickPreSkip');await fire('quickPreSkip');await fire('quickPreBuy');
    assert.equal(get('quickPreBuddyLine').textContent,'');
    assert.equal(get('quickResult').hidden,false);
    if(count===0) {
      assert.match(get('quickPreSummary').textContent,/記録なし（未回答は集計しません）/);
      assert.doesNotMatch(get('quickPreSummary').textContent,/0\/0|AI方針との一致/);
    } else assert.match(get('quickPreSummary').textContent,new RegExp('回答 '+count+'/3回.*一致 '+count+'/'+count+'回答'));
    const summary=get('quickPreSummary').textContent;
    assert.equal(summary.match(/AIとの一致数は正解数ではありません。/g)?.length||0,count===0?0:1);
    assert.ok(summary.endsWith('利益や実際の投資技能の評価ではありません。'));
    assert.doesNotMatch(summary.replace('AIとの一致数は正解数ではありません。',''),/正解|正答|的中|値動き|合う|合わない/);
    if(count===0)assert.equal(summary,'結果を見る前の記録：記録なし（未回答は集計しません）。利益や実際の投資技能の評価ではありません。');
    if(count===1)assert.equal(summary,'結果を見る前の記録：回答 1/3回 ／ AI方針との一致 1/1回答。第3日：買う（一致）。未回答は集計しません。'+
      'AIとの一致数は正解数ではありません。利益や実際の投資技能の評価ではありません。');
    assert.equal(get('quickPreSummary').textContent.match(/第[0-9]+日/g)?.length||0,count);
    assert.equal(calls.length,2);
  }
});
test('challenge and summary clear on edits, retry, failure, pagehide and fresh mount',async()=>{
  for(const finished of [false,true])for(const change of ['model','amount','leverage','edit','retry','submit','failure','pagehide']) {
    const ui=await mount(),{get,fire,state,calls}=ui;
    const practice=state.practice;
    state.practice=async body=>({...await practice(body),model_id:body.model_id,companion_name:'保存した相棒',
      companion_strategy:{source:'saved_companion',approach:'trend',risk_percent:35}});
    await startPreReveal(ui);await fire('quickPreBuy');
    assertPreCue(get,'buy','相棒');
    assert.match(get('quickPreBuddyLine').textContent,/^相棒（定型文）：.*今回使ったAIの判断/);
    if(finished){await fire('quickPreNext');await fire('quickPreSkip');}
    if(change==='model')await fire('quickModel','change');
    if(change==='amount')await fire('quickAmount','input');
    if(change==='leverage')await fire('quickLeverage','change');
    if(change==='edit')await fire('quickEdit');
    if(change==='retry')await fire('quickAgain');
    if(change==='submit')await fire('quickForm','submit');
    if(change==='pagehide')ui.pagehide();
    if(change==='failure') {
      await fire('quickForm','submit');get('quickPreOptIn').checked=true;
      state.practice=async()=>{throw Error('failure');};await fire('quickRun');
    }
    for(const id of ['quickPreReveal','quickPreSummary','quickResult','quickReplay','quickNext'])assert.equal(get(id).hidden,true,change+': '+id);
    assertPreCue(get);
    for(const id of ['quickPreBuddyLine','quickPreSummary','quickPreSnapshot','quickPreOutcome'])assert.equal(get(id).textContent,'');
    assert.equal(get('quickPreOptIn').checked,false);
    const before=calls.length;
    for(const id of ['quickPreBuy','quickPreWait','quickPreNext','quickPreSkip'])await fire(id);
    assert.equal(get('quickResult').hidden,true);assert.equal(calls.length,before);
    if(change==='retry') {
      state.practice=async body=>({...await practice(body),model_id:body.model_id,companion_name:null,companion_strategy:null});
      await startPreReveal(ui);
      assertPreCue(get,'anticipation');
      assert.equal(get('quickPreBuddyLine').textContent,'冒険ガイド（定型文）：最初の分かれ道だね。ここまでの値動きを見て、どう進もう？');
    }
  }
  const fresh=await mount();assert.equal(fresh.get('quickPreSummary').textContent,'');
  assert.equal(fresh.get('quickPreBuddyLine').textContent,'');
  assertPreCue(fresh.get);
});
test('in-flight practices hide previous challenge and reject stale responses after invalidation',async()=>{
  for(const change of ['amount','model','leverage','pagehide']) {
    const ui=await mount(),{get,fire,state}=ui;
    await startPreReveal(ui);await fire('quickPreSkip');
    const practice=state.practice;let resolve;
    state.practice=body=>new Promise(done=>{resolve=async()=>done(await practice(body));});
    await fire('quickForm','submit');get('quickPreOptIn').checked=true;
    const running=fire('quickRun');
    assert.equal(get('quickPreBuddyLine').textContent,'');
    assertFinalHidden(get);assert.equal(get('quickPreReveal').hidden,true);assert.equal(get('quickPreSummary').hidden,true);
    assert.equal(get('quickPreOptIn').disabled,true);
    if(change==='amount')await fire('quickAmount','input');
    if(change==='model')await fire('quickModel','change');
    if(change==='leverage')await fire('quickLeverage','change');
    if(change==='pagehide')ui.pagehide();
    await resolve();await running;
    assert.equal(get('quickPreBuddyLine').textContent,'');
    assertFinalHidden(get);assert.equal(get('quickPreReveal').hidden,true);
  }
});
test('malformed synthetic results never enter pre-reveal and use no unsafe HTML',async()=>{
  for(const patch of [{real_market:true},{daily_synthetic_prices:[100,'<img src=x onerror=alert(1)>']},{daily_ai_signals:Array(12).fill('<script>')},{mode:'2026_STALE_SCENE'}]) {
    const ui=await mount(),{get,state}=ui,practice=state.practice;
    state.practice=async body=>({...await practice(body),...patch});
    await startPreReveal(ui);assertFinalHidden(get);
    assert.equal(get('quickPreReveal').hidden,true);assert.equal(get('quickPreSummary').hidden,true);
  }
});
test('pre-reveal markup uses labelled native controls, live regions and wrapping mobile buttons',()=>{
  const nodes=htmlNodes(),find=id=>nodes.find(n=>n.id===id);
  const option=find('quickPreOptIn');
  assert.equal(option.tag,'input');assert.match(option.attributes,/type="checkbox"/);assert.doesNotMatch(option.attributes,/checked/);
  assert.ok(option.parents.includes('quickReview'));
  assert.match(html,/<label[^>]*for="quickPreOptIn"/);
  assert.match(option.attributes,/aria-describedby="quickPreHelp"/);
  assert.ok(find('quickPreHelp').parents.includes('quickReview'));
  assert.match(find('quickPreReveal').attributes,/aria-labelledby="quickPreTitle".*hidden/);
  assert.ok(find('quickPreCue').parents.includes('quickPreReveal'));
  assert.match(find('quickPreCue').attributes,/\bhidden\b/);
  assert.doesNotMatch(find('quickPreCue').attributes,/role=|aria-live|tabindex/);
  assert.match(find('quickPreCueIcon').attributes,/aria-hidden="true"/);
  for(const id of ['quickPreBuy','quickPreWait','quickPreNext','quickPreSkip']) {
    assert.equal(find(id).tag,'button');assert.match(find(id).attributes,/type="button"/);
    assert.ok(find(id).parents.includes('quickPreReveal'));
  }
  for(const id of ['quickPreBuddyLine','quickPreSnapshot','quickPreOutcome','quickPreSummary'])assert.match(find(id).attributes,/role="status" aria-live="polite"/);
  assert.equal(find('quickPreBuddyLine').tag,'p');
  assert.ok(find('quickPreBuddyLine').parents.includes('quickPreReveal'));
  assert.match(find('quickPreBuddyLine').attributes,/class="simple-hint".*aria-atomic="true"/);
  assert.match(html,/#quickPreReveal button\{max-width:100%;white-space:normal\}/);
  assert.match(html,/\.quick-replay \[role="group"\]\{display:flex;flex-wrap:wrap;gap:10px\}/);
});

test('pre-reveal records stay separate from post-result reflection, original AI and manual ChatGPT copy',async()=>{
  for(const model of ['self','demo'])for(const finish of ['complete','skip','one-then-skip']) {
    const ui=await mount([{id:'demo',name:'別のAI',owned:true}]),{get,fire,state,calls,copies,storageWrites}=ui;
    get('quickModel').value=model;
    const practice=state.practice;
    state.practice=async body=>({...await practice(body),model_id:model,
      companion_name:'保存した相棒',daily_ai_signals:Array(12).fill('CASH'),
      companion_strategy:{source:'saved_companion',approach:'momentum',risk_percent:35}});
    await startPreReveal(ui);
    const before=calls.slice();
    if(finish==='complete') {
      await fire('quickPreBuy');await fire('quickPreNext');
      await fire('quickPreBuy');await fire('quickPreNext');await fire('quickPreBuy');
      assertFinalHidden(get);
      await fire('quickPreNext');
      assert.match(get('quickPreSummary').textContent,/一致 0\/3回答/);
    } else {
      if(finish==='one-then-skip'){await fire('quickPreBuy');await fire('quickPreNext');}
      await fire('quickPreSkip');
    }
    const preSummary=get('quickPreSummary').textContent;
    assert.deepEqual(calls,before,'choices, navigation and skip make no requests');
    assert.equal(get('quickReflection').hidden,true,'day zero has no post-result reflection');
    for(let day=1;day<=3;day++)await fire('quickFollowing');
    assert.equal(get('quickReflection').hidden,false);
    assert.equal(get('quickHumanChoice').value,'','pre-choice must not prefill post-result choice');
    assert.equal(get('quickReflectionResult').hidden,true);
    assert.equal(get('quickFreeChatGPT').hidden,true);
    assert.equal(get('quickFreePrompt').value,'');
    assert.equal(get('quickHumanSummary').textContent,'');
    assert.equal(get('quickReplayOwner').textContent,model==='self' ?
      '相棒の外見は上の画面で確認できます' : '別のAIの練習結果です。自作キャラの成績ではありません。');
    assert.match(get('quickReplayContext').textContent,/第|現金で待機/);
    await shareReflection(get,fire,'wait','drop','POST ONLY <img src=x onerror=alert(1)>');
    assert.match(get('quickIndependentDecision').textContent,/AIの独立判断：CASH/);
    assert.match(get('quickHumanSummary').textContent,/自分.*待つ.*下落リスク/);
    const prompt=get('quickFreePrompt').value;
    assert.match(prompt,/架空第3日.*結果を見た後の振り返り（事前予測でない）/);
    assert.ok(prompt.includes(JSON.stringify({choice:'wait',reason:'下落リスク',note:'POST ONLY <img src=x onerror=alert(1)>'})));
    assert.match(prompt,/AI記録CASH/);
    assert.doesNotMatch(prompt,/結果を見る前の記録|"choice":"buy"|一致 0\//);
    if(model==='self')assert.match(prompt,/方向の分析は勢いのみ。資金35%/);
    else assert.match(prompt,/保存設定の情報なし/);
    assert.equal(get('quickReflectionEdit').hidden,model!=='self');
    await fire('quickFreeCopy');assert.deepEqual(copies,[prompt]);
    await fire('quickFollowing');await fire('quickPrevious');
    assert.equal(get('quickHumanChoice').value,'wait');
    assert.equal(get('quickFreePrompt').value,prompt);
    assert.equal(get('quickPreSummary').textContent,preSummary);
    assert.deepEqual(calls,before);assert.deepEqual(storageWrites,[]);
  }
  assert.match(html,/<h3 id="quickPreTitle">結果を見る前に自分で判断（任意）<\/h3>/);
  assert.match(html,/<summary>この日の自分の考えを相棒と振り返る（任意・結果を見た後）<\/summary>/);
});

test('fixed checkpoints hide prior results and scene voice independent of prices, signals or profit',async()=>{
  for(const loss of [false,true]) {
    const ui=await mount(),{get,fire,state,calls,storageWrites}=ui;
    get('speech').textContent='元のゲームの声';get('scene').dataset.mood='authored';
    await fire('quickForm','submit');await fire('quickRun');await fire('quickWorstDay');
    assert.notEqual(get('speech').textContent,'元のゲームの声');
    const practice=state.practice;
    let response;
    state.practice=async body=>{
      response={...await practice(body),
        daily_synthetic_prices:Array.from({length:13},(_,i)=>loss?900000-i*1234:100000+i*4567),
        daily_ai_signals:Array(12).fill(loss?'CASH':'LONG'),
        daily_balances:Array.from({length:13},(_,i)=>10000+(loss?-1:1)*i*50),
        final_balance:loss?9400:10600,profit_coins:loss?-600:600,liquidated_at_step:loss?1:null};
      return response;
    };
    const untouched=['growthInfo','growthAchievements','reward','claim','play','companionName'];
    const snapshot=untouched.map(id=>[get(id).value,get(id).textContent,get(id).disabled]);
    await startPreReveal(ui);
    const responseBefore=structuredClone(response),before=calls.slice();
    for(const day of [3,7,11]) {
      assertFinalHidden(get);
      assert.equal(get('quickPreSummary').hidden,true);assert.equal(get('quickPreSummary').textContent,'');
      for(const id of ['quickTacticsDay','quickReplayOwner','quickIndependentDecision','quickFreePrompt'])
        assert.equal(get(id).textContent||get(id).value,'',id);
      assert.equal(get('quickMini').hidden,true);
      assert.equal(get('speech').textContent,'元のゲームの声');assert.equal(get('scene').dataset.mood,'authored');
      assert.match(get('quickPreSnapshot').textContent,new RegExp('：第'+day+'日'));
      for(const button of ['quickBestDay','quickWorstDay','quickFollowing'])await fire(button);
      assertFinalHidden(get);
      await fire('quickPreWait');
      assertFinalHidden(get);
      assert.equal(get('quickPreReveal').hidden,false);
      await fire('quickPreNext');
    }
    assert.deepEqual(response,responseBefore);assert.deepEqual(calls,before);assert.deepEqual(storageWrites,[]);
    assert.deepEqual(untouched.map(id=>[get(id).value,get(id).textContent,get(id).disabled]),snapshot);
    await fire('quickAgain');await fire('quickForm','submit');await fire('quickRun');
    assert.equal(get('quickPreSummary').hidden,true);assert.equal(get('quickPreSummary').textContent,'');
  }
});

test('pagehide discards practice without form validation or unrelated scene and editor changes',async()=>{
  for(const lateFailure of [false,true]) {
    const ui=await mount(),{get,fire,state,calls}=ui;
    await fire('quickForm','submit');get('quickPreOptIn').checked=true;
    const practice=state.practice;let resolve,reject;
    state.practice=()=>new Promise((done,fail)=>{resolve=done;reject=fail;});
    const running=fire('quickRun');
    get('quickAmount').value='invalid';
    get('quickError').textContent='既存の入力メッセージ';
    get('quickAmount').setAttribute('aria-invalid','true');
    get('quickRisk').textContent='既存のリスク表示';
    get('quickRemaining').textContent='既存の残額表示';
    get('advancedEntry').open=true;get('companionControls').open=true;
    get('companionName').value='未保存の編集';
    get('speech').textContent='別モジュールの場面';get('scene').dataset.mood='growth';
    const ids=['quickAmount','quickModel','quickLeverage','quickError','quickRisk','quickRemaining','companionName','speech'];
    const before=ids.map(id=>[get(id).value,get(id).textContent,get(id).getAttribute('aria-invalid')]);
    ui.pagehide();
    if(lateFailure)reject(Error('late failure'));
    else resolve(await practice({amount:1000,leverage:1}));
    await running;
    assertFinalHidden(get);
    assert.equal(get('quickPreReveal').hidden,true);assert.equal(get('quickPreSummary').textContent,'');
    assert.deepEqual(ids.map(id=>[get(id).value,get(id).textContent,get(id).getAttribute('aria-invalid')]),before);
    assert.equal(get('advancedEntry').open,true);assert.equal(get('companionControls').open,true);
    assert.equal(get('scene').dataset.mood,'growth');
    assert.doesNotMatch(get('quickStatus').textContent,/late failure|試算が完了/);
    await fire('quickRun');assert.equal(calls.length,2,'pagehide also discards pending confirmation');
  }
});

test('sprint75: new by default, page-only replay survives edits, explicit replay is labelled',async()=>{
  const {get,fire,calls,storageWrites,pagehide}=await mount();
  const review=async()=>{get('quickAmount').value='1000';await fire('quickForm','submit');};
  await review();
  assert.equal(get('quickScenarioOption').hidden,true);
  assert.match(get('quickScenarioNote').textContent,/今回は新しい架空相場です/);
  await fire('quickRun');
  assert.deepEqual(calls.at(-1).body,{model_id:'self',amount:1000,leverage:1});
  await fire('quickAgain');
  await review();
  assert.equal(get('quickScenarioOption').hidden,false);
  assert.equal(get('quickSameScenario').checked,false);
  get('quickSameScenario').checked=true;await fire('quickSameScenario','change');
  assert.match(get('quickScenarioNote').textContent,/初見の予想とは比較できません/);
  get('quickPreOptIn').checked=true;
  await fire('quickRun');
  assert.deepEqual(calls.at(-1).body,{model_id:'self',amount:1000,leverage:1,scenario_token:'v1_0123456789abcdef'});
  assert.match(get('quickStatus').textContent,/初見の予想とは比較できません/);
  assert.doesNotMatch(get('quickStatus').textContent,/。。/);
  await fire('quickPreSkip');
  assert.match(get('quickPreSummary').textContent,/初見の予想とは比較できません/);
  assert.ok(get('quickResult').children.some(n=>n.textContent.includes('初見の予想とは比較できません')));
  await review();
  assert.equal(get('quickSameScenario').checked,false);
  assert.equal(get('quickScenarioOption').hidden,false);
  pagehide();await review();
  assert.equal(get('quickScenarioOption').hidden,true);
  assert.deepEqual(storageWrites,[]);
});

test('sprint75: failed, invalid and unrevealed responses never become a replay option',async()=>{
  for(const patch of [{error:'failed'},{scenario_token:'bad'},{scenario_token:'v1_0123456789abcdef\n'},
    {scenario_kind:'replay'},{daily_balances:[]},null]) {
    const {get,fire,state}=await mount();
    const original=state.practice;
    state.practice=async body=>({...await original(body),...patch});
    get('quickAmount').value='1000';
    await fire('quickForm','submit');
    get('quickPreOptIn').checked=true;
    await fire('quickRun');
    assert.equal(get('quickScenarioOption').hidden,true);
    if(patch===null) {
      await fire('quickPreSkip');
      await fire('quickForm','submit');
      assert.equal(get('quickScenarioOption').hidden,false);
    } else {
      await fire('quickForm','submit');
      assert.equal(get('quickScenarioOption').hidden,true);
    }
  }
});

test('sprint75: native replay checkbox is in separate confirm panel with wrapping layout',()=>{
  const nodes=htmlNodes(),input=nodes.find(n=>n.id==='quickSameScenario');
  assert.match(input.attributes,/type="checkbox"/);
  assert.ok(input.parents.includes('quickReview'));
  assert.ok(!input.parents.includes('quickForm'));
  assert.match(html,/for="quickSameScenario"/);
  assert.match(html,/\.quick-pre-option\{[^}]*overflow-wrap:anywhere/);
  assert.match(html,/\.quick-pre-option input\{[^}]*width:auto/);
});

test('sprint75: invalid replay cannot replace the last fully revealed token; fresh remains default',async()=>{
  const {get,fire,state,calls}=await mount();
  const original=state.practice;
  get('quickAmount').value='1000';
  await fire('quickForm','submit');await fire('quickRun');
  for(const patch of [{error:'failed'},{scenario_token:'v1_ffffffffffffffff'},{scenario_kind:'new'}]) {
    await fire('quickForm','submit');
    get('quickSameScenario').checked=true;
    state.practice=async body=>({...await original(body),...patch});
    await fire('quickRun');
    assert.match(get('quickStatus').textContent,/試算できませんでした/);
    assert.equal(get('quickResult').hidden,true);
    assert.equal(calls.at(-1).body.scenario_token,'v1_0123456789abcdef');
  }
  state.practice=original;
  await fire('quickForm','submit');
  assert.equal(get('quickSameScenario').checked,false);
  await fire('quickRun');
  assert.equal(Object.hasOwn(calls.at(-1).body,'scenario_token'),false);
});

test('sprint75: abandoning a blind run and pagehide in flight never unlock a token',async()=>{
  const {get,fire,state,pagehide}=await mount();
  get('quickAmount').value='1000';
  await fire('quickForm','submit');get('quickPreOptIn').checked=true;await fire('quickRun');
  await fire('quickForm','submit');
  assert.equal(get('quickScenarioOption').hidden,true);
  let resolve;
  const original=state.practice;
  state.practice=body=>new Promise(done=>{resolve=async()=>done(await original(body));});
  const running=fire('quickRun');
  pagehide();
  await resolve();await running;
  await fire('quickForm','submit');
  assert.equal(get('quickScenarioOption').hidden,true);
});
