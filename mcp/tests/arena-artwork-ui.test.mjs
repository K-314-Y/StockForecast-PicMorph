import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const script=await readFile(new URL('../../game_runtime/arena-ui.mjs',import.meta.url),'utf8');
const draft='bp_'+'a'.repeat(32);
class Element {
  constructor(tag='div') {
    this.tag=tag;this.children=[];this.dataset={};this.attributes={};
    this.style={};this.value='';this.textContent='';
  }
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(){}
  append(...els){this.children.push(...els);}
  remove(){this.removed=true;}
  replaceChildren(...els){this.children=[...els];}
}
const nodes=new Map();
const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
const context={document:{
  getElementById:get,
  createElement:tag=>new Element(tag),
  createElementNS:(_,tag)=>new Element(tag),
},fetch:async()=>{throw Error('No network during avatar construction');}};
runInNewContext(script,context);
const avatar=runInNewContext('buildAvatar',context);
const fighter=(slot,choice,kind,source_draft_id=null)=>({
  slot,choice,kind,source_draft_id,
  name:'試験用の女の子',
  persona:{label:'勢い派',look:{
    hair_style:'twintails',expression:'cheerful',accessory:'ribbon',
    hair_color:'#abcdef',clothing_color:'#445566',
  }},
});
const imageOf=root=>root.children.find(el=>el.tag==='img');

test('only own self model uses the player-authored illustration',()=>{
  const mine=avatar(fighter('mine','self','authored_companion'));
  const image=imageOf(mine);
  assert.ok(image);
  assert.equal(image.src,'/api/artwork/image/base');
  assert.equal(image.alt,'','parent is the named accessible picture');
  assert.equal(image.loading,'lazy');
  assert.equal(image.decoding,'async');
  assert.equal(image.width,106);
  assert.equal(image.height,146);
  assert.match(mine.attributes['aria-label'],/試験用の女の子/);
  image.onload();
  assert.equal(mine.dataset.artwork,'loaded');
  assert.match(mine.attributes['aria-label'],/保存したイラストを表示中/);
});

test('missing custom illustration leaves deterministic 2D avatar visible',()=>{
  const fallback=avatar(fighter('mine','self','standard_mine'));
  const image=imageOf(fallback);
  assert.equal(fallback.children.length,6);
  image.onerror();
  assert.equal(image.removed,true);
  assert.equal(fallback.dataset.artwork,'fallback');
  assert.match(fallback.attributes['aria-label'],/簡易2Dキャラを表示中/);
  assert.ok(fallback.children.some(el=>el.className==='av-face'));
  assert.equal(fallback.attributes.style,'--av-hair:#abcdef;--av-clothing:#445566');
});

test('a trained model uses only its source blueprint, never global self artwork',()=>{
  const trained=avatar(fighter('mine','tv_'+'1'.repeat(32),'trained_practice_only',draft));
  const image=imageOf(trained);
  assert.equal(image.src,'/api/appearance/image/'+draft);
  const invalid=avatar(fighter('mine','tv_'+'1'.repeat(32),'trained_practice_only','bp_invalid'));
  assert.equal(imageOf(invalid),undefined);
  assert.equal(imageOf(avatar(fighter('owl','preset','preset_rival'))),undefined);
  assert.equal(imageOf(avatar(fighter('turtle','preset','preset_rival'))),undefined);
  assert.equal(imageOf(avatar(fighter('owl','self','authored_companion'))),undefined);
});

test('no client-side authority to set prediction weights, XP or edit artworks',()=>{
  assert.doesNotMatch(script,/\/api\/artwork['"]|\/api\/training\/complete|\/api\/growth\/equip/);
});
