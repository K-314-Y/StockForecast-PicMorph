import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// No browser, sockets, or dependencies: exercise the page's actual event handlers.
test('saved blueprint preview, safe rendering, collapsed details, explicit save and errors', async()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.style={};this.disabled=false;this.files=[];}
    append(...children){this.children.push(...children);}
    prepend(child){this.children.unshift(child);}
    replaceChildren(){this.children=[];}
    addEventListener(){}
    setAttribute(key,value){this[key]=value;}
  }
  const nodes=new Map();
  const all=e=>[e,...e.children.flatMap(all)];
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element('div'));return nodes.get(id);};
  const calls=[];
  let fail=false;
  const result={scores:{trained_train_brier:.6,original_train_brier:.7,trained_validation_brier:.8,original_validation_brier:.7,uniform_brier:2/3},notice:'固定架空40点での学習演習。実相場の能力を証明しない。検証期間は選択に使わない。',engine_parameters:{plugin_weights:{trend:100}},dataset:{train_indices:[20],validation_indices:[32]},training_job:{candidate_count:56}};
  const draft={id:'bp_test',title:'test',reasoning:'test',blueprint:{engine_parameters:{plugin_weights:{trend:100},fast_window:3,slow_window:9,risk_fraction:.35}},capacity_parts:[{name:'trend',indicator_id:'trend'}],user_declared:{name:'<script>bad</script>',concept:'x',style:'x'}};
  const context=vm.createContext({document:{getElementById:get,createElement:t=>new Element(t),querySelectorAll:()=>[...nodes.values()].flatMap(all).filter(n=>n.tag==='button')},fetch:async(path,options)=>{
    calls.push([path,options?.body ? JSON.parse(options.body) : null]);
    if(fail)return {ok:false,json:async()=>({error:'保存できません'})};
    const data=path.endsWith('/train-preview')?result:path.endsWith('/train-save')?{version:{id:'tv_test'}}:path.endsWith('/trained')?{versions:[{id:'tv_test',created_at:'now',source_draft_id:'bp_test'}]}:{drafts:[draft]};
    return {ok:true,json:async()=>data};
  }});
  const html=readFileSync(new URL('../../web/create.html',import.meta.url),'utf8');
  const script=html.split('<script>')[1].split('</script>')[0];
  vm.runInContext(script.replace('Promise.all([gallery(),trained()]).catch(error=>status(error.message));',''),context);
  await vm.runInContext('gallery()',context);
  const gallery=all(get('gallery'));
  assert.ok(gallery.some(n=>n.textContent==='<script>bad</script>'));
  assert.ok(!gallery.some(n=>n.tag==='script'));
  const button=gallery.find(n=>n.textContent==='架空データで学習して比較');
  await button.onclick();
  assert.equal(calls.filter(([p])=>p.endsWith('/train-save')).length,0);
  const rendered=all(get('gallery'));
  assert.ok(rendered.some(n=>n.textContent==='0.800000'));
  assert.ok(rendered.some(n=>n.textContent==='0.666667'));
  assert.ok(rendered.filter(n=>n.tag==='details').every(n=>!n.open));
  await rendered.find(n=>n.textContent==='練習版保存').onclick();
  assert.deepEqual(calls.find(([p])=>p.endsWith('/train-save'))[1],{draft_id:'bp_test'});
  assert.ok(all(get('trained')).some(n=>n.textContent?.includes('tv_test')));
  fail=true;
  await button.onclick();
  assert.equal(get('status').textContent,'保存できません');
  assert.equal(button.disabled,false);
});
