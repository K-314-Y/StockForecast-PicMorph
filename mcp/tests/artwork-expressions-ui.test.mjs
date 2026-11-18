import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
const script=await readFile(new URL('../../game_runtime/demo.mjs',import.meta.url),'utf8');
const fixtures=JSON.parse(await readFile(new URL('./artwork-fixtures.json',import.meta.url),'utf8'));
const api='/api/artwork-expressions';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const dimensions=[128,192];
const emptyMood={exists:false,mime:null,size:0};
const storedMood={exists:true,mime:'image/png',size:88};

function file(width=128,height=192,options={}) {
  const data=Uint8Array.from(Buffer.from(fixtures.png.base64,'base64'));
  return {name:'synthetic.png',type:'image/png',size:data.length,dimensions:[width,height],
    slice:(start,end)=>new Blob([data.slice(start,end)]),
    arrayBuffer:async()=>data.buffer,...options};
}

async function mount({base=dimensions,happy=null,cautious=null,loadError=false}={}) {
  const requests=[],imageRequests=[],confirms=[],urls=new Map(),nodes=new Map();
  const state={base,happy,cautious,loadError,accept:false,saveError:false};
  let record={revision:0,created:false,moods:{happy:emptyMood,cautious:emptyMood}};
  for (const mood of ['happy','cautious']) {
    if (state[mood]) {
      record.created=true;
      record.revision=1;
      record.moods[mood]=storedMood;
    }
  }
  const size=src=>urls.get(src)?.dimensions ??
    state[/\/image\/(\w+)/.exec(src)?.[1]];
  class Element {
    constructor(tagName) {
      this.tagName=tagName;
      this.handlers={};this.children=[];this.dataset={};this.attributes={};
      this.value='';this.textContent='';
    }
    set src(src) {
      this._src=src;this.currentSrc='';this.complete=false;
      this.naturalWidth=0;this.naturalHeight=0;
      if (!src) return;
      imageRequests.push(src);
      queueMicrotask(()=>{
        if (this._src!==src) return;
        const decoded=size(src);
        [this.naturalWidth,this.naturalHeight]=decoded||[0,0];
        this.currentSrc=src;this.complete=true;
        const event=decoded?'load':'error';
        this['on'+event]?.();
        this.handlers[event]?.();
      });
    }
    get src() {return this._src;}
    removeAttribute(key) {if (key==='src') this.src='';}
    setAttribute(key,value) {this.attributes[key]=value;}
    addEventListener(event,handler) {this.handlers[event]=handler;}
    replaceChildren(...children) {this.children=children;}
    append(child) {this.children.push(child);}
  }
  const get=id=>{
    if (!nodes.has(id)) nodes.set(id,new Element(id==='artworkExpressions'?'DETAILS':''));
    return nodes.get(id);
  };
  const response=value=>({ok:true,json:async()=>value});
  const failure=error=>({ok:false,json:async()=>({error})});
  const fetch=async(path,options)=>{
    const body=options?.body?JSON.parse(options.body):undefined;
    requests.push({path,body});
    if (path===api) {
      if (!body) return state.loadError?failure('表情イラストを読み込めません'):response(record);
      if (state.saveError) return failure('更新されています。再取得してください');
      assert.equal(body.expected_revision,record.revision);
      state[body.mood]=body.image?dimensions:null;
      record={revision:record.revision+1,created:true,
        moods:{...record.moods,[body.mood]:body.image?storedMood:emptyMood}};
      return response(record);
    }
    if (path==='/api/artwork') {
      const exists=Boolean(state.base);
      return response({revision:exists?1:0,created:exists,slots:{
        base:exists?storedMood:emptyMood,hair:emptyMood,face:emptyMood,outfit:emptyMood,
      }});
    }
    if (path==='/api/growth') return response({revision:0,slots:[{slot:'mine',level:1,xp:0,achievements:[]}]});
    if (path==='/api/looks') return response({revision:0,created:false,look:{hair_style:'bob',expression:'cheerful',accessory:'ribbon'}});
    if (path==='/api/companion') return response({revision:0,created:false,companion:{
      name:'私の相棒',hair_color:'#8882db',clothing_color:'#92e1d4',approach:'trend',risk_percent:35,
    }});
    throw Error('Unexpected path '+path);
  };
  class Image {
    set src(src) {
      this.url=src;
      if (!urls.has(src)) queueMicrotask(()=>{
        [this.naturalWidth,this.naturalHeight]=size(src)||[0,0];
        (this.naturalWidth?this.onload:this.onerror)?.();
      });
    }
    async decode() {
      const decoded=size(this.url);
      if (!decoded) throw Error('Decode error');
      [this.naturalWidth,this.naturalHeight]=decoded;
    }
  }
  let nextBlob=0;
  const context={document:{getElementById:get,createElement:()=>new Element()},fetch,Image,
    URL:{createObjectURL(value){const src='blob:synthetic-'+ ++nextBlob;urls.set(src,value);return src;},
      revokeObjectURL:src=>urls.delete(src)},
    btoa:value=>Buffer.from(value,'binary').toString('base64'),
    window:{confirm(message){confirms.push(message);return state.accept;},addEventListener(){}},
  };
  runInNewContext(script,context);
  await tick();
  async function fire(id,event='click') {
    await get(id).handlers[event]();
    await tick();
  }
  async function select(id,chosen) {
    get(id).files=[chosen];
    await fire(id,'change');
  }
  return {get,fire,select,state,requests,imageRequests,confirms,urls,
    writes:()=>requests.filter(({body})=>body!==undefined),
    mood:(name,otherModel=false)=>runInNewContext(`scene('${name}', 'Synthetic', ${otherModel})`,context)};
}

test('the editor requires a saved base and validates local type, size and natural dimensions without writes',async()=>{
  const ui=await mount({base:null});
  const {get,select,fire,state,requests,writes}=ui;
  await select('expressionFileHappy',file());
  assert.equal(get('expressionSaveHappy').disabled,true);
  assert.match(get('expressionInfoHappy').textContent,/未保存.*base.*SAVE/);
  await select('artworkFileBase',file());
  assert.equal(get('expressionSaveHappy').disabled,true,'a base preview is insufficient');
  assert.equal(writes().length,0);
  state.base=dimensions;state.accept=true;
  await fire('reloadArtwork');
  const count=requests.length;
  for (const [chosen,message] of [
    [file(128,192,{type:'image/gif'}),/450 KiB以内/],
    [file(128,192,{type:'image/webp'}),/一致しません/],
    [file(128,192,{size:450*1024+1}),/450 KiB以内/],
    [file(64,192),/寸法が違います/],
  ]) {
    await select('expressionFileHappy',chosen);
    assert.equal(get('expressionSaveHappy').disabled,true);
    assert.equal(get('expressionFileHappy').attributes['aria-invalid'],'true');
    assert.match(get('expressionInfoHappy').textContent,message);
  }
  await select('expressionFileHappy',file());
  assert.equal(get('expressionSaveHappy').disabled,false);
  assert.equal(get('expressionFileHappy').attributes['aria-invalid'],'false');
  assert.match(get('expressionInfoHappy').textContent,/未保存.*128×192px/);
  assert.equal(requests.length,count);
  assert.equal(ui.urls.size,0);
  await fire('expressionSaveHappy');
  assert.deepEqual(writes(),[{path:api,body:{expected_revision:0,mood:'happy',image:fixtures.png}}]);
  assert.match(get('expressionStatus').textContent,/このPCに保存しました/);
});

test('overwrite and CLEAR require confirmation and errors preserve the pending selection',async()=>{
  const {get,select,fire,state,writes,confirms}=await mount({happy:dimensions,cautious:dimensions});
  await select('expressionFileHappy',file());
  await fire('expressionSaveHappy');
  await fire('expressionClearCautious');
  assert.equal(writes().length,0);
  assert.match(confirms[0],/置き換え/);
  assert.match(confirms[1],/削除/);
  state.accept=true;
  state.saveError=true;
  await fire('expressionSaveHappy');
  assert.match(get('expressionStatus').textContent,/保存できません.*再取得/);
  assert.match(get('expressionInfoHappy').textContent,/未保存/);
  state.saveError=false;
  await fire('expressionSaveHappy');
  await fire('expressionClearCautious');
  assert.deepEqual(writes().map(({body})=>[body.expected_revision,body.mood,body.image===null]),
    [[1,'happy',false],[1,'happy',false],[2,'cautious',true]]);
  assert.match(get('expressionStatus').textContent,/しんぱい.*削除しました/);
  assert.equal(get('artworkStage').dataset.happyExpression,'true');
  assert.equal(get('artworkStage').dataset.cautiousExpression,'false');
});

test('mood swaps are CSS-only, with fallback for mismatches, broken artwork, unsaved previews and failed storage',async()=>{
  const ui=await mount({happy:dimensions,cautious:[64,192]});
  const {get,fire,select,state,mood,requests,imageRequests}=ui;
  const stage=get('artworkStage');
  assert.equal(stage.hidden,false);
  assert.equal(stage.dataset.happyExpression,'true');
  assert.equal(stage.dataset.cautiousExpression,'false');
  const counts=[requests.length,imageRequests.length];
  for (const name of ['ready','happy','thinking','cautious','growth']) mood(name);
  mood('cautious',true);
  assert.equal(get('scene').dataset.expressionOtherModel,'true');
  mood('happy');
  assert.equal(get('scene').dataset.expressionOtherModel,undefined);
  assert.deepEqual([requests.length,imageRequests.length],counts);
  await select('artworkFileHair',file());
  assert.match(get('artworkHair').src,/^blob:/);
  assert.equal(stage.dataset.happyExpression,'false');
  state.accept=true;
  await fire('reloadArtwork');
  assert.equal(stage.dataset.happyExpression,'true');
  state.happy=null;
  await fire('reloadExpressions');
  assert.equal(stage.dataset.happyExpression,'false');
  assert.match(get('expressionInfoHappy').textContent,/画像を読み込めません/);
  state.loadError=true;
  await fire('reloadExpressions');
  assert.equal(stage.hidden,false);
  assert.equal(get('artworkBase').hidden,false);
  assert.match(get('expressionStatus').textContent,/読み込めません/);
  assert.equal(get('expressionSaveHappy').disabled,true);

  assert.match(html,/<details id="artworkExpressions" class="crop-controls">/);
  assert.match(html,/\.artwork-expression\{display:none\}/);
  for (const [name,suffix] of [['happy','Happy'],['cautious','Cautious']]) {
    const selector='.scene[data-mood="'+name+'"]:not([data-expression-other-model]) #artworkStage[data-'+name+'-expression="true"]';
    assert.ok(html.includes(selector+' #artworkExpression'+suffix));
    assert.ok(html.includes(selector+' img:not(.artwork-expression)'));
  }
  assert.match(html,/img:not\(\.artwork-expression\)\{clip-path:inset\(50%\)\}/);
});
