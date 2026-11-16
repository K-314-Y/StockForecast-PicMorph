import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalDialogue,validateDialogueInput,validateDialogueResult,DIALOGUE_DISCLAIMER} from '../../game_runtime/local-dialogue.mjs';
import {Readable} from 'node:stream';
import {createGameServer} from '../../game_runtime/server.mjs';
const input={choice:'buy',reason:'trend',note:'私の考え',ai_action:'LONG'};
const reply=content=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content}}]}));

test('strict input is pure, capped and strips controls',()=>{
  const original={...input,note:'a\u0000\n\u202eb'};
  assert.equal(validateDialogueInput(original).note,'ab');
  assert.equal(original.note,'a\u0000\n\u202eb');
  for(const invalid of [null,[],{}, {...input,url:'http://example.com'},
    {...input,model:'other'}, {...input,choice:'LONG'}, {...input,reason:'__proto__'},
    {...input,ai_action:'BUY'}, {...input,note:1}, {...input,note:'a'.repeat(121)}])
    assert.throws(()=>validateDialogueInput(invalid),{status:400});
});

test('transport is fixed loopback, no redirects/credentials, developer model and constrained context',async()=>{
  let calls=0;
  const adapter=createLocalDialogue({model:'developer-model',fetchImpl:async(url,options)=>{
    calls++;
    assert.equal(url,'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(options.headers,{'Content-Type':'application/json'});
    const body=JSON.parse(options.body);
    assert.equal(body.model,'developer-model');assert.equal(body.stream,false);
    assert.equal(body.max_tokens,320);assert.equal(body.tools,undefined);
    assert.match(body.messages[0].content,/Do not invent/);
    assert.match(body.messages[0].content,/Do not recommend real trades/);
    assert.deepEqual(JSON.parse(body.messages[1].content),{...input,disclaimer:DIALOGUE_DISCLAIMER});
    return reply('a\u0000\u202eb <img src=x>');
  }});
  assert.equal(calls,0);
  const result=await adapter(input);
  assert.equal(result.status,'ok');assert.equal(result.commentary,'ab <img src=x>');
  assert.match(result.label,/モデル生成.*真の判断理由ではありません/);
  assert.equal(calls,1);
  await assert.rejects(adapter({...input,endpoint:'http://evil.invalid'}));
  assert.equal(calls,1);
  for(const config of [{model:'m',endpoint:'http://evil.invalid'}, {model:'m',host:'::1'},
    {model:'m',url:'http://127.0.0.1@evil.invalid'}, {model:'m',credentials:'secret'},
    {model:'x\nAuthorization:secret'}, {}]) assert.throws(()=>createLocalDialogue(config));
});

test('offline, invalid, redirected, oversized and tool output never invent commentary',async()=>{
  const responses=[()=>{throw Error('private error');},()=>new Response('bad json'),
    ()=>new Response('',{status:503}),()=>reply(''),()=>reply('a'.repeat(1201)),
    ()=>new Response('x'.repeat(8193)),
    ()=>new Response('{}',{headers:{'content-length':'8193'}}),
    ()=>({ok:true,redirected:true}),
    ()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'x',tool_calls:[{}]}}]})),
    ()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(8193));c.close();}})),
  ];
  for(const response of responses) {
    const run=createLocalDialogue({model:'fake',fetchImpl:async()=>response()});
    assert.deepEqual(await run(input),{status:'unavailable'});
  }
});

test('five second deadline aborts even an uncooperative fake transport',async()=>{
  let signal;
  const run=createLocalDialogue({model:'fake',fetchImpl:async(_,opts)=>{
    signal=opts.signal;return new Promise(()=>{});
  }});
  const start=Date.now();
  assert.deepEqual(await run(input),{status:'unavailable'});
  assert.ok(Date.now()-start>=4900);assert.equal(signal.aborted,true);
});

// Exercise the real HTTP handler/body reader without opening any sockets.
const handlers=new Map();
async function request(url,options={}) {
  const parsed=new URL(url), handler=handlers.get(parsed.origin);
  const body=Buffer.from(options.body || '');
  const headers={host:parsed.host,...Object.fromEntries(Object.entries(options.headers || {}).map(([k,v])=>[k.toLowerCase(),v]))};
  if(body.length && headers['content-length']===undefined)headers['content-length']=String(body.length);
  const req=Readable.from(body.length ? [body] : []);
  req.url=parsed.pathname;req.method=options.method || 'GET';req.headers=headers;
  req.socket={remoteAddress:options.remoteAddress || '127.0.0.1'};
  return new Promise((resolve,reject)=>{
    let status,responseHeaders;
    const res={writeHead(code,values){status=code;responseHeaders=values;},
      end(data){resolve(new Response(data,{status,headers:responseHeaders}));}};
    Promise.resolve(handler(req,res)).catch(reject);
  });
}
async function serve(config,fn) {
  const server=createGameServer(config);
  // No listen(), fetch() or backend traffic in these route tests.
  server.address=()=>({port:54321});
  const url='http://127.0.0.1:54321';
  handlers.set(url,server.listeners('request')[0]);
  try {await fn(url);}
  finally {handlers.delete(url);}
}
const post=(url,body=input,headers={})=>request(url+'/api/local-dialogue',{
  method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),
});

test('default has no dialogue route and disabled UI marker',async()=>{
  await serve({},async url=>{
    assert.equal((await post(url)).status,404);
    assert.equal((await request(url+'/api/local-dialogue')).status,404);
    const html=await (await request(url+'/game')).text();
    assert.match(html,/data-local-dialogue="disabled"/);
  });
});

test('injected route preserves same-origin, JSON/body validation and never accesses gameplay or stores',async()=>{
  let calls=0;
  const forbidden=()=>{throw Error('gameplay/store touched');};
  const store=new Proxy({}, {get:()=>forbidden});
  await serve({localDialogue:async fields=>{calls++;assert.deepEqual(fields,input);return {status:'ok',commentary:'fake'};},
    store,companionStore:store,lookStore:store,artworkStore:store,modelShopStore:store,
    predict:forbidden,loadSnapshot:forbidden},async url=>{
    assert.match(await (await request(url+'/game')).text(),/data-local-dialogue="enabled"/);
    assert.equal(calls,0);
    for(const headers of [{Origin:'https://evil.invalid'},{'Sec-Fetch-Site':'cross-site'},
      {'X-Forwarded-For':'127.0.0.1'},{Host:'evil.invalid'}]) assert.equal((await post(url,input,headers)).status,403);
    assert.equal((await post(url,input,{'Content-Type':'text/plain'})).status,415);
    assert.equal((await post(url,{...input,note:'a'.repeat(1024)})).status,413);
    for(const extra of ['model','endpoint','url','settings','save'])
      assert.equal((await post(url,{...input,[extra]:'bad'})).status,400);
    assert.equal(calls,0);
    const response=await post(url);assert.equal(response.status,200);
    const value=await response.json();assert.equal(value.commentary,'fake');
    assert.equal(value.disclaimer,DIALOGUE_DISCLAIMER);assert.equal(calls,1);
  });
});

test('one concurrent dialogue only; failures release slot and return no raw errors',async()=>{
  let finish,calls=0;
  await serve({localDialogue:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}},async url=>{
    const pending=post(url);
    while(!finish)await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await post(url)).status,429);assert.equal(calls,1);
    finish({status:'unavailable'});assert.equal((await pending).status,503);
    finish=null;
    const next=post(url);
    while(!finish)await new Promise(resolve=>setImmediate(resolve));
    finish({status:'ok',commentary:'\u0000'});
    assert.equal((await next).status,503);
  });
  await serve({localDialogue:async()=>{throw Error('secret');}},async url=>{
    const response=await post(url);assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{status:'unavailable'});
  });
});

test('strict results reject malformed shape and normalize literal commentary with immutable provenance',()=>{
  for(const value of [null,[],{status:'ok',commentary:1},{status:'ok',commentary:'\u0000\u202e'},
    {status:'ok',commentary:'x',tool_calls:[]},{status:'ok',commentary:'x',save:true},
    {status:'other',commentary:'x'},{status:'ok',commentary:'x'.repeat(1201)}])
    assert.deepEqual(validateDialogueResult(value),{status:'unavailable'});
  const result=validateDialogueResult({status:'ok',commentary:' <b>text</b>\u0000\u202e ',label:'forged',disclaimer:'forged'});
  assert.equal(result.commentary,'<b>text</b>');
  assert.equal(result.disclaimer,DIALOGUE_DISCLAIMER);
  assert.match(result.disclaimer,/client-supplied.*not verified by the server/);
  assert.notEqual(result.label,'forged');
});

test('stream failures, invalid UTF-8, truncated responses and multiple choices are unavailable',async()=>{
  const message={role:'assistant',content:'text'};
  for(const response of [
    ()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));c.error(Error('secret'));}})),
    ()=>new Response(new Uint8Array([0xff])),
    ()=>new Response(JSON.stringify({choices:[{message,finish_reason:'length'}]})),
    ()=>new Response(JSON.stringify({choices:[{message},{message}]})),
    ()=>new Response(JSON.stringify({choices:[{message:{...message,function_call:{name:'trade'}}}]})),
    ()=>new Response(JSON.stringify({choices:[{message:{...message,role:'tool'}}]})),
  ]) {
    const run=createLocalDialogue({model:'fake',fetchImpl:async()=>response()});
    assert.deepEqual(await run(input),{status:'unavailable'});
  }
});

test('five second deadline covers a hanging response stream and releases its reader',async()=>{
  let signal,response;
  const run=createLocalDialogue({model:'fake',fetchImpl:async(_,options)=>{
    signal=options.signal;
    response=new Response(new ReadableStream({start(c){
      options.signal.addEventListener('abort',()=>c.error(Error('aborted')));
    }}));
    return response;
  }});
  assert.deepEqual(await run(input),{status:'unavailable'});
  assert.equal(signal.aborted,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(response.body.locked,false);
});

test('route rejects malformed bodies, dishonest lengths, transfer encoding and nonlocal peers before injection',async()=>{
  let calls=0;
  await serve({localDialogue:async()=>{calls++;return {status:'ok',commentary:'x'};}},async url=>{
    const raw=(body,headers={},extra={})=>request(url+'/api/local-dialogue',{
      method:'POST',body,headers:{'Content-Type':'application/json',...headers},...extra});
    for(const body of ['{','null','[]','{}']) assert.equal((await raw(body)).status,400);
    for(const headers of [{'Content-Length':'0'},{'Content-Length':'bad'},
      {'Content-Length':'1'},{'Transfer-Encoding':'chunked'}])
      assert.equal((await raw(JSON.stringify(input),headers)).status,400);
    assert.equal((await raw('x'.repeat(1025),{'Content-Length':'1'})).status,413);
    assert.equal((await raw(JSON.stringify(input),{}, {remoteAddress:'192.0.2.1'})).status,403);
    assert.equal(calls,0);
    assert.equal((await post(url)).status,200);
    assert.equal(calls,1);
  });
});
