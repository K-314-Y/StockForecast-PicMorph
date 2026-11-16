import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createGameServer} from '../../game_runtime/server.mjs';
import {CHATGPT_TIMEOUT_MS,createChatGPTPlanDialogue,validateDialogueInput,validateDialogueResult} from '../../game_runtime/chatgpt-dialogue.mjs';
const input={choice:'buy',reason:'trend',note:'流れを見た',ai_action:'CASH'};
function sdk(overrides={}) {
  const calls=[];
  return {calls,client:{
    getSession:async()=>{calls.push('session');return {status:'connected',sharing:true};},
    listModels:async()=>{calls.push('models');return [{slug:'account-first'},{slug:'account-second'}];},
    streamResponse:async options=>{calls.push(options);options.onDelta('振り返り');return {text:'何を重視しましたか？'};},
    ...overrides,
  }};
}
test('strict four-field JSON boundary sanitizes controls without interpreting notes',()=>{
  assert.deepEqual(validateDialogueInput({...input,note:'<script>\u0000\u202E日本語'}),{...input,note:'<script>日本語'});
  for(const value of [null,[],{}, {...input,choice:'LONG'}, {...input,reason:'__proto__'},
    {...input,ai_action:'BUY'},{...input,note:7},{...input,note:'a'.repeat(121)},
    {...input,model:'x'},{...input,image:'data:xxx'},{...input,day:1}]) {
    assert.throws(()=>validateDialogueInput(value),{status:400});
  }
});
test('inert construction; sharing permission blocks catalog and inference',async()=>{
  for(const sharing of [false,undefined,'true']) {
    const {client,calls}=sdk({getSession:async()=>({sharing})});
    const dialogue=createChatGPTPlanDialogue({client});
    assert.equal(calls.length,0);
    assert.deepEqual(await dialogue(input),{status:'unavailable'});
    assert.equal(calls.length,0);
  }
  assert.throws(()=>createChatGPTPlanDialogue());
});
test('uses fresh account catalog, SDK completed result and bounded data-only request',async()=>{
  const {client,calls}=sdk();
  const dialogue=createChatGPTPlanDialogue({client});
  const value=await dialogue(input);
  assert.equal(value.status,'ok');
  assert.match(value.label,/ChatGPT生成/);
  assert.match(value.disclaimer,/クライアント申告/);
  const options=calls[2];
  assert.equal(options.model,'account-first');
  assert.equal(options.store,false);assert.equal(options.stream,true);
  assert.deepEqual(JSON.parse(options.input),input);
  assert.match(options.instructions,/真の判断理由/);
  assert.match(options.instructions,/精度向上/);
  assert.equal(options.tools,undefined);
  await dialogue({...input,choice:'wait'});
  assert.equal(calls.filter(x=>x==='models').length,2);
  const chosen=sdk();
  await createChatGPTPlanDialogue({client:chosen.client,model:'account-second'})(input);
  assert.equal(chosen.calls[2].model,'account-second');
});
test('missing model, empty catalog, SDK failures/partial responses and excess output are unavailable',async()=>{
  const missing=sdk();
  assert.deepEqual(await createChatGPTPlanDialogue({client:missing.client,model:'not-in-account'})(input),{status:'unavailable'});
  assert.equal(missing.calls.length,2);
  for(const overrides of [
    {listModels:async()=>[]}, {listModels:async()=>({models:[]})},
    {getSession:async()=>{throw Error('secret');}},
    ...['response.failed','response.incomplete','stream_interrupted','subscription_sharing_usage_limit_exceeded'].map(code=>({
      streamResponse:async()=>{throw Error(code);},
    })),
    ...[{type:'response.output_text.delta',delta:'partial'}, {text:''}, {text:'a'.repeat(1201)},
      {text:'\u0000'}, {text:'partial',type:'response.incomplete'}].map(result=>({streamResponse:async()=>result})),
    {streamResponse:async options=>{options.onDelta('a'.repeat(1201));return {text:'late'};}},
  ]) {
    assert.deepEqual(await createChatGPTPlanDialogue({client:sdk(overrides).client})(input),{status:'unavailable'});
  }
  assert.deepEqual(validateDialogueResult({status:'ok',commentary:'hello',tools:[]}),{status:'unavailable'});
});
test('deadline includes hung session/catalog/stream; no later inference after timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const phase of ['getSession','listModels','streamResponse']) {
    let release,signal;
    const fake=sdk({[phase]:options=>{signal=options?.signal;return new Promise(resolve=>{release=resolve;});}});
    const dialogue=createChatGPTPlanDialogue({client:fake.client});
    let settled=false;
    const pending=dialogue(input).then(value=>{settled=true;return value;});
    for(let i=0;i<5;i++)await Promise.resolve();
    assert.equal(CHATGPT_TIMEOUT_MS,45000);
    t.mock.timers.tick(44999);
    for(let i=0;i<5;i++)await Promise.resolve();
    assert.equal(settled,false);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending,{status:'unavailable'});
    if(signal)assert.equal(signal.aborted,true);
    assert.deepEqual(await dialogue(input),{status:'unavailable'});
    const count=fake.calls.length;
    release(phase==='getSession'?{status:'connected',sharing:true}:phase==='listModels'?[{slug:'late'}]:{text:'late'});
    for(let i=0;i<5;i++)await Promise.resolve();
    assert.equal(fake.calls.length,count);
  }
});
// Exercise the actual Node request handler without listening on a socket.
const servers=new Map();
let nextPort=42000;
async function fetch(url,options={}) {
  const address=new URL(url),server=servers.get(address.origin);
  assert.ok(server,'only the in-memory test server is reachable');
  const headers={host:address.host};
  for(const [key,value] of Object.entries(options.headers || {}))headers[key.toLowerCase()]=value;
  if(options.body!==undefined && headers['content-length']===undefined)
    headers['content-length']=String(Buffer.byteLength(options.body));
  const req=Readable.from(options.body===undefined ? [] : [Buffer.from(options.body)]);
  Object.assign(req,{method:options.method || 'GET',url:address.pathname+address.search,headers,
    socket:{remoteAddress:'127.0.0.1'}});
  return new Promise((resolve,reject)=>{
    let status=200,responseHeaders={};
    const res=Object.assign(new EventEmitter(),{writeHead(code,values){status=code;responseHeaders=values;},
      end(body){resolve(new Response(body,{status,headers:responseHeaders}));}});
    options.signal?.addEventListener('abort',()=>res.emit('close'),{once:true});
    Promise.resolve(server.listeners('request')[0](req,res)).catch(reject);
  });
}
async function withServer(dialogue,fn,client=null) {
  const forbidden=()=>{throw Error('Gameplay/storage accessed by dialogue');};
  const server=createGameServer({chatgptDialogue:dialogue,chatgptClient:client,store:{public:forbidden,complete:forbidden},
    companionStore:{read:forbidden,save:forbidden},lookStore:{read:forbidden,save:forbidden},
    artworkStore:{read:forbidden,save:forbidden},modelShopStore:{read:forbidden,save:forbidden},
    loadSnapshot:forbidden,predict:forbidden});
  const port=nextPort++,base='http://127.0.0.1:'+port;
  server.address=()=>({port});servers.set(base,server);
  try {await fn(base);}
  finally {servers.delete(base);server.close();}
}
const post=(base,body=input,headers={})=>fetch(base+'/api/chatgpt-dialogue',{
  method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),
});
test('default route absent and HTML capability disabled, configured HTML reveals no credentials',async()=>{
  await withServer(null,async base=>{
    assert.equal((await post(base)).status,404);
    assert.match(await (await fetch(base+'/')).text(),/data-chatgpt-dialogue="disabled"/);
  });
  await withServer(async()=>({status:'unavailable'}),async base=>{
    assert.equal((await fetch(base+'/api/chatgpt-dialogue')).status,404);
    assert.match(await (await fetch(base+'/')).text(),/data-chatgpt-dialogue="enabled"/);
    assert.equal((await post(base)).status,503);
  });
});
test('strict same-origin <=1024 JSON POST; result is literal text and no game paths run',async()=>{
  let calls=0;
  await withServer(async fields=>{calls++;assert.equal(fields.note.includes('\u0000'),false);
    return {status:'ok',commentary:'<img src=x onerror=alert(1)>'};},async base=>{
    const success=await post(base,{...input,note:'<script>\u0000'});
    assert.equal(success.status,200);assert.match(success.headers.get('content-type'),/application\/json/);
    assert.equal((await success.json()).commentary,'<img src=x onerror=alert(1)>');
    const invalid=[
      [input,{Origin:'https://evil.example'},403],
      [input,{'Sec-Fetch-Site':'cross-site'},403],
      [input,{'X-Forwarded-For':'127.0.0.1'},403],
      [input,{'Content-Type':'text/plain'},415],
      [{...input,note:'x'.repeat(1100)},{},413],
      [{...input,note:'x'.repeat(121)},{},400],
      [{...input,settings:{}},{},400],
      [{...input,ai_action:'bad'},{},400],
    ];
    for(const [body,headers,status] of invalid)assert.equal((await post(base,body,headers)).status,status);
    assert.equal((await fetch(base+'/api/chatgpt-dialogue',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
    assert.equal(calls,1);
  });
});
test('serial requests and injected errors cannot leak secrets or fabricate responses',async()=>{
  let release;
  await withServer(()=>new Promise(resolve=>{release=resolve;}),async base=>{
    const pending=post(base);
    while(!release)await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await post(base)).status,429);
    release({status:'ok',commentary:'問い'});
    assert.equal((await pending).status,200);
  });
  for(const dialogue of [async()=>{throw Error('SECRET');},async()=>({status:'ok',commentary:'x',credential:'SECRET'})]) {
    await withServer(dialogue,async base=>{
      const response=await post(base);assert.equal(response.status,503);
      assert.deepEqual(await response.json(),{status:'unavailable'});
    });
  }
});

test('HTTP framing rejects missing length, transfer encoding and invalid lengths before provider',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;return {status:'ok',commentary:'ok'};},async base=>{
    for(const headers of [
      {'Content-Length':'0'}, {'Content-Length':'bad'},
      {'Content-Length':'1'}, {'Transfer-Encoding':'chunked'},
    ])assert.equal((await post(base,input,headers)).status,400);
    assert.equal(calls,0);
  });
});
test('server deadline returns unavailable and retains guard for uncooperative provider',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  await withServer(()=>new Promise(()=>{}),async base=>{
    let settled=false;
    const pending=post(base).then(value=>{settled=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(49999);
    for(let i=0;i<5;i++)await Promise.resolve();
    assert.equal(settled,false);
    t.mock.timers.tick(1);
    const response=await pending;
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{status:'unavailable'});
    assert.equal((await post(base)).status,429);
  });
});

test('connected status and sharing are both required; no catalog/inference on disconnected sessions',async()=>{
  for(const status of ['disconnected','connecting','reauth_required',undefined]) {
    const fake=sdk({getSession:async()=>({status,sharing:true})});
    assert.deepEqual(await createChatGPTPlanDialogue({client:fake.client})(input),{status:'unavailable'});
    assert.equal(fake.calls.length,0);
  }
});
test('caller cancellation discards late SDK completion and blocks duplicate work until settlement',async()=>{
  let release,signal;
  const fake=sdk({streamResponse:options=>{
    signal=options.signal;return new Promise(resolve=>{release=resolve;});
  }});
  const dialogue=createChatGPTPlanDialogue({client:fake.client});
  const controller=new AbortController();
  const pending=dialogue(input,{signal:controller.signal});
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.deepEqual(await dialogue(input),{status:'unavailable'});
  controller.abort();
  assert.deepEqual(await pending,{status:'unavailable'});
  assert.equal(signal.aborted,true);
  assert.deepEqual(await dialogue(input),{status:'unavailable'});
  assert.equal(fake.calls.length,2);
  release({text:'LATE'});
  for(let i=0;i<8;i++)await Promise.resolve();
});
test('optional session endpoint discloses only two booleans and never signs in or infers',async()=>{
  await withServer(null,async base=>{
    assert.equal((await fetch(base+'/api/chatgpt-session')).status,404);
    assert.match(await (await fetch(base+'/')).text(),/data-chatgpt-session="disabled"/);
  });
  for(const status of ['connected','disconnected','reauth_required']) {
    let reads=0;
    const forbidden=()=>{throw Error('Must not sign in or infer');};
    const client={getSession:async()=>{reads++;return {status,sharing:true,
      identity:{email:'SECRET'},accessToken:'SECRET'};},listModels:forbidden,streamResponse:forbidden,signIn:forbidden};
    await withServer(null,async base=>{
      assert.equal(reads,0);
      const html=await (await fetch(base+'/')).text();
      assert.match(html,/data-chatgpt-session="enabled"/);
      assert.equal(reads,0);
      const response=await fetch(base+'/api/chatgpt-session');
      assert.equal(response.status,200);
      assert.deepEqual(await response.json(),{connected:status==='connected',sharing:status==='connected'});
      assert.equal(reads,1);
      assert.equal((await fetch(base+'/api/chatgpt-session',{headers:{Origin:'https://evil.example'}})).status,403);
      assert.equal(reads,1);
      assert.equal((await fetch(base+'/api/chatgpt-signin',{method:'POST'})).status,404);
    },client);
  }
});
test('same-origin means exact host; bounded valid requests have a per-minute limit',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;return {status:'ok',commentary:'ok'};},async base=>{
    assert.equal((await post(base,input,{Origin:base.replace('127.0.0.1','localhost')})).status,403);
    for(let i=0;i<6;i++)assert.equal((await post(base)).status,200);
    assert.equal((await post(base)).status,429);
    assert.equal(calls,6);
  });
});

test('HTTP close cancels provider signal and discards even an uncooperative completed result',async()=>{
  let release,signal;
  await withServer((fields,options)=>{
    signal=options.signal;return new Promise(resolve=>{release=resolve;});
  },async base=>{
    const controller=new AbortController();
    const pending=fetch(base+'/api/chatgpt-dialogue',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal});
    while(!release)await new Promise(resolve=>setImmediate(resolve));
    controller.abort();
    assert.equal(signal.aborted,true);
    assert.equal((await post(base)).status,429);
    release({status:'ok',commentary:'STALE'});
    assert.deepEqual(await (await pending).json(),{status:'unavailable'});
  });
});
test('read-only session timeout and failure are generic and never release a still-pending read',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const fake=sdk({getSession:()=>new Promise(()=>{})});
  await withServer(null,async base=>{
    const pending=fetch(base+'/api/chatgpt-session');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await fetch(base+'/api/chatgpt-session')).status,429);
    t.mock.timers.tick(3000);
    assert.deepEqual(await (await pending).json(),{status:'unavailable'});
    assert.equal((await fetch(base+'/api/chatgpt-session')).status,429);
  },fake.client);
  await withServer(null,async base=>{
    const result=await fetch(base+'/api/chatgpt-session');
    assert.equal(result.status,503);
    assert.deepEqual(await result.json(),{status:'unavailable'});
  },sdk({getSession:async()=>{throw Error('SECRET');}}).client);
});

test('strict JSON rejects invalid UTF-8, BOM and trailing text before provider access',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;return {status:'ok',commentary:'ok'};},async base=>{
    for(const body of [Buffer.from([0xff]),'\ufeff'+JSON.stringify(input),JSON.stringify(input)+' trailing']) {
      const result=await fetch(base+'/api/chatgpt-dialogue',{method:'POST',
        headers:{'Content-Type':'application/json'},body});
      assert.equal(result.status,400);
    }
    assert.equal(calls,0);
  });
});

test('partial stream stays private through reasoning wait and only completion returns text',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let complete,delta,settled=false;
  const fake=sdk({streamResponse:options=>{
    delta=options.onDelta;
    return new Promise(resolve=>{complete=resolve;});
  }});
  const pending=createChatGPTPlanDialogue({client:fake.client})(input).then(value=>{settled=true;return value;});
  for(let i=0;i<8;i++)await Promise.resolve();
  delta('PRIVATE PARTIAL');
  t.mock.timers.tick(44000);
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(settled,false);
  complete({text:'完成した振り返り'});
  assert.equal((await pending).commentary,'完成した振り返り');
});
