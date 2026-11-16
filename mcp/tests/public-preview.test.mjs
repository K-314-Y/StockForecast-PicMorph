import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createPublicPreviewServer, startPublicPreviewServer } from '../../game_runtime/public_preview.mjs';

const preview = {status:'SYNTHETIC_PREVIEW_ONLY', preview_only:true,
  public_export_allowed:false, license_verified:false,
  actual_public_deployment_enabled:false, energy:[100,104,101,108]};
const status = {status:'SYNTHETIC_PREVIEW_ONLY', preview_only:true,
  actual_public_deployment_enabled:false};

function send(port, path, {method = 'GET', headers = {}, body, unfinished = false} = {}) {
  return new Promise((resolve, reject) => {
    const req = request({hostname:'127.0.0.1', port, path, method, agent:false, setHost:false,
      headers:{Host:`127.0.0.1:${port}`, ...headers}}, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({code:res.statusCode, headers:res.headers, text}));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (unfinished) { req.flushHeaders(); if (body) req.write(body); }
    else req.end(body);
  });
}

test('factory and start validate literal loopback and ports without starting on import', async () => {
  const idle = createPublicPreviewServer();
  assert.equal(idle.listening, false);
  for (const host of ['localhost','0.0.0.0','::1','127.0.0.2','example.com','']) {
    assert.throws(() => createPublicPreviewServer({host}));
    await assert.rejects(startPublicPreviewServer({host,port:0}));
    assert.throws(() => idle.listen(0, host));
  }
  for (const port of [-1,65536,1.2,'0',null,NaN,Infinity]) {
    assert.throws(() => createPublicPreviewServer({port}));
    await assert.rejects(startPublicPreviewServer({port}));
  }
});

test('isolated fixed routes, strict raw paths, foreign headers and unread bodies', async t => {
  const server = await startPublicPreviewServer({host:'127.0.0.1',port:0});
  t.after(() => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  const port = server.address().port;
  assert.equal(server.address().address, '127.0.0.1');
  for (const [path, expected] of [['/api/public/preview',preview],['/api/public/status',status]]) {
    const first = await send(port,path);
    assert.deepEqual(JSON.parse(first.text),expected);
    assert.equal(first.code,200);
    assert.equal(first.headers['x-content-type-options'],'nosniff');
    assert.equal(first.headers['cache-control'],'no-store');
    assert.match(first.headers['content-security-policy'],/default-src 'none'/);
    assert.equal(first.headers['access-control-allow-origin'],undefined);
    assert.equal((await send(port,path)).text,first.text);
    assert.equal((await send(port,path,{headers:{Host:`localhost:${port}`}})).text,first.text);
  }
  const html = await send(port,'/');
  assert.equal(html.code,200);
  assert.match(html.text,/Fictional preview/);
  assert.doesNotMatch(html.text,/<script|<img|https?:|src=|href=/i);
  for (const path of ['/api/public/preview?synthetic=true&license_verified=true',
    '/api/public/status?', '/?x=1','/%61pi/public/preview','/api/public/%70review',
    '/api/public/../public/preview','/api/public/preview/','//api/public/preview',
    '/api/market/prices','/api/state','/api/blueprints','/game','/.env',
    '/../../app.py','http://localhost/api/public/preview']) {
    const r = await send(port,path);
    assert.equal(r.code,404,path);
    assert.equal(r.text,'Not found\n');
  }
  for (const headers of [{Host:'evil.example'}, {Host:'127.0.0.1:1'},
    {Host:`127.0.0.1:${port}.evil`}, {Host:''}, {Origin:'https://evil.example'},
    {Origin:`http://127.0.0.1:${port}`}, {Forwarded:'for=127.0.0.1'},
    {'X-Forwarded-Host':`localhost:${port}`}, {'X-Forwarded-For':'127.0.0.1'},
    {'X-Forwarded-Proto':'http'}]) {
    const r = await send(port,'/api/public/preview',{headers});
    assert.equal(r.code,403,JSON.stringify(headers));
    assert.equal(r.text,'Forbidden\n');
  }
  for (const method of ['POST','PUT','PATCH','DELETE','OPTIONS','HEAD']) {
    for (const path of ['/api/public/preview','/api/public/preview?license_verified=true','/api/state']) {
      const r = await send(port,path,{method,headers:{'Content-Length':'1000000'},
        body:'{"license_verified":true,"synthetic":true,"secret":"PRIVATE_SENTINEL"}',unfinished:true});
      assert.equal(r.code,403);
      assert.equal(r.headers.connection,'close');
      assert.equal(r.text,method === 'HEAD' ? '' : 'Forbidden\n');
    }
  }
  const r = await send(port,'/api/public/preview',{headers:{'Content-Length':'1000000'},body:'PRIVATE_SENTINEL',unfinished:true});
  assert.deepEqual(JSON.parse(r.text),preview);
});
