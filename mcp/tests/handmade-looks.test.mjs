import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {runInNewContext} from 'node:vm';
import {createLookStore,validateLook} from '../../game_runtime/looks.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createCompanionChatGptHttpServer} from '../companion-chatgpt.mjs';
const DEFAULT={hair_style:'bob',expression:'cheerful',accessory:'ribbon'};
const CUSTOM={hair_style:'twintails',expression:'determined',accessory:'star'};
async function listen(server){
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  return 'http://127.0.0.1:'+server.address().port;
}
async function setup(t,cb){
  const dir=await mkdtemp(join(tmpdir(),'creature-looks-s33-'));
  const file=join(dir,'looks.json'),store=createLookStore({file});
  const game=createGameServer({lookStore:store});
  const gameUrl=await listen(game);
  const mcp=createCompanionChatGptHttpServer({apiBase:gameUrl});
  const mcpUrl=await listen(mcp);
  t.after(async()=>{
    await new Promise(ok=>mcp.close(ok));
    await new Promise(ok=>game.close(ok));
    await rm(dir,{force:true,recursive:true});
  });
  await cb({gameUrl,mcpUrl,file,dir});
}
test('look defaults do not write and rejects invalid parts without side effects',async t=>{
  await setup(t,async({gameUrl,file,dir})=>{
    const data=await fetch(gameUrl+'/api/looks').then(r=>r.json());
    assert.deepEqual(data,{revision:0,created:false,look:DEFAULT});
    await assert.rejects(stat(file),{code:'ENOENT'});
    assert.deepEqual(await readdir(dir),[]);
    for (const invalid of [
      {hair_style:'../../../etc/passwd',expression:'calm',accessory:'ribbon'},
      {hair_style:'long',expression:'angry',accessory:'ribbon'},
      {hair_style:'bob',expression:'calm',accessory:'file:///secret'},
      {...DEFAULT,arbitrary:'code'},
    ]){
      assert.throws(()=>validateLook(invalid));
      const response=await fetch(gameUrl+'/api/looks',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:0,look:invalid})});
      assert.equal(response.status,400);
    }
    assert.deepEqual(await readdir(dir),[]);
  });
});
test('saving look through MCP updates the same Node game; stale writes rejected',async t=>{
  await setup(t,async({gameUrl,mcpUrl,file,dir})=>{
    const client=new Client({name:'looks-test',version:'1.0.0'});
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl+'/mcp')));
    try{
      const names=(await client.listTools()).tools.map(x=>x.name);
      assert.ok(names.includes('get_my_look')&&names.includes('save_my_look'));
      const before=await client.callTool({name:'get_my_look',arguments:{}});
      assert.equal(before.structuredContent.created,false);
      const saved=await client.callTool({name:'save_my_look',arguments:{expected_revision:0,...CUSTOM}});
      assert.equal(saved.isError,undefined,JSON.stringify(saved));
      assert.equal(saved.structuredContent.revision,1);
      assert.deepEqual(saved.structuredContent.look,CUSTOM);
      const loaded=await fetch(gameUrl+'/api/looks').then(r=>r.json());
      assert.deepEqual(loaded.look,CUSTOM);
      assert.equal(loaded.revision,1);
      assert.equal(JSON.parse(await readFile(file,'utf8')).schema,1);
      const conflict=await client.callTool({name:'save_my_look',arguments:{expected_revision:0,...DEFAULT}});
      assert.equal(conflict.isError,true);
      assert.match(conflict.content[0].text,/409/);
      const wrong=await client.callTool({name:'save_my_look',arguments:{expected_revision:1,...DEFAULT,profit_coins:500000}});
      assert.equal(wrong.isError,true);
      assert.equal((await fetch(gameUrl+'/api/looks').then(r=>r.json())).revision,1);
      assert.deepEqual(await readdir(dir),['looks.json']);
    }finally{await client.close();}
  });
});
test('parallel look saves accept one winner, malformed record is never reset',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'creature-looks-concurrent-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'look.json');
  const a=createLookStore({file}),b=createLookStore({file});
  const [one,two]=await Promise.allSettled([
    a.save({expected_revision:0,look:CUSTOM}),
    b.save({expected_revision:0,look:DEFAULT}),
  ]);
  assert.equal([one,two].filter(x=>x.status==='fulfilled').length,1);
  assert.equal([one,two].filter(x=>x.status==='rejected').length,1);
  assert.equal((await a.read()).revision,1);
  await import('node:fs/promises').then(fs=>fs.writeFile(file,'{"broken":true}'));
  await assert.rejects(a.read(),{status:503});
  await assert.rejects(a.save({expected_revision:0,look:DEFAULT}),{status:503});
});
test('2D stage exposes 36 combinations with non-executable CSS and proper labels',async()=>{
  const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
  const js=await readFile(new URL('../../game_runtime/demo.mjs',import.meta.url),'utf8');
  for(const id of ['lookHair','lookExpression','lookAccessory']){
    assert.match(html,new RegExp('id="'+id+'"'));
    assert.match(html,new RegExp('for="'+id+'"'));
  }
  for(const value of ['twintails','long','determined','calm','star','glasses']){
    assert.match(html,new RegExp('data-(?:hair-style|expression|accessory)="'+value+'"'));
  }
  assert.match(js,/dataset\.hairStyle/);
  assert.match(js,/dataset\.expression/);
  assert.match(js,/dataset\.accessory/);
  assert.doesNotMatch(js,/innerHTML|localStorage/);
});
test('browser stage preview changes before save but only explicit save sends /api/looks',async()=>{
  const script=await readFile(new URL('../../game_runtime/demo.mjs',import.meta.url),'utf8');
  const nodes=new Map(), calls=[];
  class E {
    constructor(){this.children=[];this.handlers={};this.attributes={};this.dataset={};this.value='';this.textContent='';}
    addEventListener(k,cb){this.handlers[k]=cb;}
    setAttribute(k,v){this.attributes[k]=v;}
    replaceChildren(...list){this.children=list;}
    append(el){this.children.push(el);}
    async fire(name='click'){await this.handlers[name]?.({preventDefault(){}});}
    set innerHTML(_){throw Error('no HTML injection');}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new E());return nodes.get(id);};
  let record={revision:0,created:false,look:{...DEFAULT}};
  const fetch=async(path,opts)=>{
    const body=opts?.body?JSON.parse(opts.body):undefined;
    calls.push({path,body});
    let value;
    if(path==='/api/looks'){
      if(body){assert.equal(body.expected_revision,record.revision);record={
        revision:record.revision+1,created:true,look:body.look};}
      value=record;
    }else if(path==='/api/growth')value={revision:0,slots:[{slot:'mine',
      level:1,xp:0,achievements:[]}]};
    else if(path==='/api/companion')value={revision:0,created:false,companion:{
      name:'私の相棒',hair_color:'#8882db',clothing_color:'#92e1d4',approach:'trend',risk_percent:35}};
    else throw Error('unexpected path '+path);
    return {ok:true,json:async()=>value};
  };
  runInNewContext(script,{fetch,document:{getElementById:get,createElement:()=>new E()}});
  await new Promise(r=>setImmediate(r));
  assert.equal(get('lookHair').value,'bob');
  assert.equal(get('chibi').dataset.accessory,'ribbon');
  get('lookHair').value='twintails'; get('lookExpression').value='determined';
  get('lookAccessory').value='star';
  await get('lookHair').fire('change');
  assert.equal(get('chibi').dataset.hairStyle,'twintails');
  assert.equal(get('chibi').dataset.expression,'determined');
  assert.equal(get('chibi').dataset.accessory,'star');
  assert.equal(calls.filter(c=>c.path==='/api/looks'&&c.body).length,0);
  await get('lookForm').fire('submit');
  assert.equal(calls.filter(c=>c.path==='/api/looks'&&c.body).length,1);
  assert.deepEqual(record.look,CUSTOM);
  assert.match(get('lookStatus').textContent,/保存しました/);
});
