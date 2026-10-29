import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('parts page invalidates edited and in-flight previews; saves only current loadout',async()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.events={};this.value='';this.disabled=false;}
    append(...children){this.children.push(...children);}
    replaceChildren(){this.children=[];}
    addEventListener(name,fn){this.events[name]=fn;}
  }
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,new Element('div'));return nodes.get(id)};
  get('name').value='観測隊';get('window').value='window:balanced';get('risk').value='risk:normal';
  const ids=['trend','momentum','volatility','reversion'];
  const catalog={parts:ids.map(id=>({part_id:'indicator:'+id,kind:'builtin_indicator',name:id,explanation:'説明',config:{indicator_id:id}}))};
  const preview={compiled:{engine_parameters:{plugin_weights:{trend:75,momentum:25,volatility:0,reversion:0}}},fixtures:[{name:'架空',predicted:'UP',probabilities:{UP:.5,FLAT:.3,DOWN:.2}}],notice:'架空データ'};
  const calls=[];let release=null,hold=false;
  const context=vm.createContext({document:{getElementById:get,createElement:t=>new Element(t),createTextNode:text=>({textContent:text})},fetch:async(path,options)=>{calls.push([path,options?.body]);if(hold&&path.endsWith('/preview'))await new Promise(r=>release=r);return {ok:true,json:async()=>path.endsWith('/catalog')?catalog:preview}}});
  const script=readFileSync(new URL('../../web/assemble.html',import.meta.url),'utf8').split('<script>')[1].split('</script>')[0];
  await vm.runInContext(script,context);
  const submit=()=>get('builder').events.submit({preventDefault(){}});
  await submit();assert.equal(get('save').disabled,false);
  get('builder').events.input();assert.equal(get('save').disabled,true);assert.equal(get('result').hidden,true);
  await get('save').events.click();assert.equal(calls.filter(([p])=>p.endsWith('/draft')).length,0);
  hold=true;const pending=submit();get('builder').events.input();release();await pending;
  assert.equal(get('save').disabled,true);assert.equal(get('result').hidden,true);
  hold=false;await submit();await get('save').events.click();
  assert.equal(calls.filter(([p])=>p.endsWith('/draft')).length,1);
  assert.equal(get('save').disabled,true);
  const saved=JSON.parse(calls.find(([p])=>p.endsWith('/draft'))[1]);assert.equal(saved.analysis.length,2);
  assert.equal(saved.analysis[0].share,3);
});
