import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('isolated cosmetic panel loads, previews, saves, and handles errors safely',async()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.style={};this.files=[];}
    append(...nodes){this.children.push(...nodes)}
    prepend(node){this.children.unshift(node)}
    replaceChildren(){this.children=[]}
    setAttribute(key,value){this[key]=value}
    addEventListener(){}
  }
  const all=e=>[e,...e.children.flatMap(all)];
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,new Element('div'));return nodes.get(id)};
  const calls=[];let fail=false;
  const id='bp_'+'a'.repeat(32);
  const context=vm.createContext({document:{getElementById:get,createElement:t=>new Element(t)},
    FileReader:class {readAsDataURL(file){this.result=file.uri;this.onload()}},
    fetch:async(path,options)=>{const payload=options?.body?JSON.parse(options.body):null;calls.push([path,payload]);return {ok:!fail,json:async()=>fail?{error:'保存失敗'}:{look:{schema:1,draft_id:id,layers:payload?[{...payload,z:1,asset_id:'acc_test'}]:[]}}}}
  });
  const html=readFileSync(new URL('../../web/create.html',import.meta.url),'utf8');
  vm.runInContext(html.split('<script>')[1].split('</script>')[0].replace('Promise.all([gallery(),trained()]).catch(error=>status(error.message));',''),context);
  context.draft={id,user_declared:{name:'<script>bad</script>'}};context.box=new Element('article');
  vm.runInContext('looksPanel(draft,box)',context);
  const panel=context.box.children[0];assert.equal(panel.open,undefined);assert.equal(calls.length,0);
  const els=all(panel);assert.ok(els.some(n=>n.className==='look-neutral'));
  const button=els.find(n=>n.tag==='button');assert.equal(button.disabled,true);
  panel.open=true;await panel.ontoggle();assert.equal(button.disabled,false);
  const file=els.find(n=>n.type==='file');file.files=[{type:'image/png',size:10,uri:'data:image/png;base64,abc'}];await file.onchange();
  const overlay=els.find(n=>n.className==='look-overlay');assert.equal(overlay.src,file.files[0].uri);
  const sliders=els.filter(n=>n.type==='range');sliders[0].value=-25;sliders[0].oninput();assert.equal(overlay.style.left,'25%');
  const visible=els.find(n=>n.type==='checkbox');visible.checked=false;visible.onchange();assert.equal(overlay.hidden,true);
  await button.onclick();assert.equal(calls.at(-1)[0],'/api/looks2d/save');assert.equal(calls.at(-1)[1].position_x_pct,-25);assert.equal(calls.at(-1)[1].accessory_data_uri,'data:image/png;base64,abc');
  assert.ok(calls.every(([p])=>p.startsWith('/api/looks2d')));
  fail=true;await button.onclick();assert.ok(els.some(n=>n.textContent==='保存失敗'));assert.equal(button.disabled,false);
  file.files=[{type:'image/svg+xml',size:10}];await file.onchange();assert.ok(els.some(n=>n.textContent?.includes('1 MiB以下を選んで')));
  context.box=new Element('article');context.draft.visual_asset={};vm.runInContext('looksPanel(draft,box)',context);
  assert.ok(all(context.box).some(n=>n.alt==='ベースイラスト'));
});
