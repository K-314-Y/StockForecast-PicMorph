import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,rm} from 'node:fs/promises';
import {createServer,request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {crc32,deflateSync} from 'node:zlib';
import {createImportedCharacterStore} from '../../game_runtime/imported-characters.mjs';
import {extractCharacterZip} from '../../game_runtime/parts-lab/zip-import.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';
import {buildCharacterZip,listMainCharacters,prepareMainCharacterZip} from '../../scripts/export-main-character-zip.mjs';

const transfer='/api/main-character-transfer';
const catalog='/api/character-demos';
const id='cp_'+'a'.repeat(32);
const otherId='cp_'+'b'.repeat(32);
const zipPath=id=>transfer+'/zip/'+id;
const imagePath=part=>catalog+'/'+id+'/'+part+'.png';
const record=Object.freeze({generated_id:id,name:'通常ゲームの相棒',engine:'original-template',
  model:'private-main-model',equipment:Object.freeze(['private-main-equipment'])});

function pngChunk(tag,data) {
  const bytes=Buffer.alloc(12+data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(tag,4,'ascii');
  data.copy(bytes,8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4,-4)),bytes.length-4);
  return bytes;
}

function atlas(color) {
  const width=1152,height=208;
  const header=Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height,4);
  header[8]=8;
  header[9]=6;
  const stride=1+width*4;
  const scanlines=Buffer.alloc(height*stride);
  for(let y=0;y<height;y++) {
    const row=y*stride+1;
    if(color===null)scanlines.fill(Buffer.from([30,80,130,255]),row,row+width*4);
    else if(y<8)scanlines.fill(Buffer.from([...color,255]),row,row+8*4);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),
    pngChunk('IDAT',deflateSync(scanlines)),pngChunk('IEND',Buffer.alloc(0))]);
}
const images={body:atlas(null),ready:atlas([255,0,0]),happy:atlas([0,255,0]),cautious:atlas([0,0,255])};

async function listen(t,server) {
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  t.after(()=>new Promise(resolve=>{
    server.close(resolve);
    server.closeAllConnections();
  }));
  return server.address().port;
}

async function devServer(t,bridge) {
  const root=await mkdtemp(join(tmpdir(),'main-character-transfer-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createImportedCharacterStore({root:join(root,'imported')});
  const port=await listen(t,createGameServer({
    importedCharacterStore:store,mainCharacterTransfer:bridge,
  }));
  return {root,store,port,origin:'http://127.0.0.1:'+port};
}

function send(res,type,body,status=200) {
  res.writeHead(status,{'Content-Type':type});
  res.end(body);
}

async function servers(t) {
  const requests=[];
  const overrides=new Map();
  const upstream=await listen(t,createServer((req,res)=>{
    requests.push([req.method,req.url]);
    if(overrides.has(req.url))return overrides.get(req.url)(res);
    if(req.url===catalog)return send(res,'application/json',JSON.stringify([record]));
    const part=Object.keys(images).find(part=>imagePath(part)===req.url);
    if(part)return send(res,'image/png',images[part]);
    return send(res,'text/plain','missing',404);
  }));
  const dev=await devServer(t,{
    list:()=>listMainCharacters(upstream),
    prepareZip:id=>prepareMainCharacterZip(id,upstream),
  });
  return {...dev,requests,overrides};
}

// Preserve the raw request target and Host header for route and origin tests.
function call(port,path,{method='GET',headers}={}) {
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method,headers},async res=>{
      try {
        const chunks=[];
        for await (const chunk of res)chunks.push(chunk);
        resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)});
      } catch(error) {reject(error);}
    });
    req.once('error',reject);
    req.end();
  });
}

test('DEV lists only source IDs and names and serves a ZIP with four images and a name',async t=>{
  const {root,port,requests}=await servers(t);
  const list=await call(port,transfer,{headers:{Origin:'http://127.0.0.1:'+port}});
  assert.equal(list.status,200);
  assert.equal(list.headers['cache-control'],'no-store');
  assert.deepEqual(JSON.parse(list.body),{characters:[{id,name:record.name}]});

  const zip=await call(port,zipPath(id));
  assert.equal(zip.status,200);
  assert.equal(zip.headers['content-type'],'application/zip');
  assert.equal(zip.headers['content-length'],String(zip.body.length));
  assert.equal(zip.headers['cache-control'],'no-store');
  assert.equal(zip.headers['x-content-type-options'],'nosniff');
  assert.match(zip.headers['content-security-policy'],/default-src 'none'/);
  const draft=await extractCharacterZip(new File([zip.body],'character.zip',{type:'application/zip'}));
  assert.deepEqual(draft.appearance,{name:record.name});
  assert.deepEqual(Object.keys(draft),Object.keys(images));
  for(const [part,png] of Object.entries(images))
    assert.deepEqual(Buffer.from(await draft[part].arrayBuffer()),png);
  for(const privateValue of [id,record.model,...record.equipment])
    assert.equal(zip.body.includes(privateValue),false);
  assert.deepEqual(requests,[catalog,catalog,...Object.keys(images).map(imagePath)].map(path=>['GET',path]));
  assert.deepEqual(await readdir(root),[]);
});

test('DEV rejects methods, raw path aliases and forged origin headers before any MAIN request',async t=>{
  const {root,port,requests}=await servers(t);
  for(const path of [transfer,zipPath(id)]) {
    for(const method of ['POST','PUT','HEAD']) {
      const response=await call(port,path,{method});
      assert.equal(response.status,405);
      assert.equal(response.headers.allow,'GET');
    }
    for(const headers of [
      {Host:'attacker.example:'+port},{Origin:'https://attacker.example'},
      {Origin:'http://localhost:'+port},{Origin:'http://127.0.0.1:8890'},
      {'Sec-Fetch-Site':'same-site'},{'X-Forwarded-Host':'localhost:'+port},
    ]) {
      assert.equal((await call(port,path,{headers})).status,403);
    }
  }
  for(const path of [
    transfer+'?port=8890',zipPath(id)+'?url=http://example.test',transfer+'?',
    transfer+'/',transfer+'/zip/invalid',zipPath(id.toUpperCase()),zipPath(id)+'%0A',
    zipPath(id).replace('cp_','%63p_'),zipPath(id).replace('/zip/','/%7aip/'),
    transfer.replace('main','%6dain'),'/api/else/%2e%2e/main-character-transfer',
    zipPath(id)+'/body.png',
  ]) assert.equal((await call(port,path)).status,404,path);
  assert.deepEqual(requests,[]);
  assert.equal((await call(port,zipPath(otherId))).status,404);
  assert.deepEqual(requests,[['GET',catalog]]);
  assert.deepEqual(await readdir(root),[]);
});

test('DEV handles missing, oversized and stalled MAIN sources and releases its concurrency guard',
  {timeout:15_000},async t=>{
    const {root,port,requests,overrides}=await servers(t);
    overrides.set(imagePath('body'),res=>send(res,'text/plain','missing',404));
    assert.equal((await call(port,zipPath(id))).status,503);
    assert.deepEqual(requests.splice(0),[['GET',catalog],['GET',imagePath('body')]]);

    overrides.set(catalog,res=>send(res,'application/json',Buffer.alloc(64*1024+1)));
    assert.equal((await call(port,transfer)).status,503);
    assert.deepEqual(requests.splice(0),[['GET',catalog]]);

    const started=Promise.withResolvers();
    let count=0;
    overrides.set(catalog,res=>{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.write('[');
      if(++count===2)started.resolve();
    });
    const stalled=Promise.all([call(port,transfer),call(port,transfer)]);
    await Promise.race([started.promise,stalled.then(()=>assert.fail('MAIN requests did not overlap'))]);
    assert.equal((await call(port,transfer)).status,429);
    assert.deepEqual((await stalled).map(response=>response.status),[503,503]);
    assert.equal(count,2);
    overrides.delete(catalog);
    assert.equal((await call(port,transfer)).status,200);
    assert.deepEqual(await readdir(root),[]);
  });

test('Chrome previews a MAIN draft and creates a separate DEV AI only on explicit registration',
  {timeout:45_000},async t=>{
    let playwright;
    try {
      playwright=await import(process.env.FRIEND_UI_PLAYWRIGHT ?? 'playwright');
    } catch(error) {
      if(!process.env.FRIEND_UI_PLAYWRIGHT && error.code==='ERR_MODULE_NOT_FOUND')
        return t.skip('Set FRIEND_UI_PLAYWRIGHT to run this test with Playwright.');
      throw error;
    }
    const secondName='もう一匹の相棒';
    const characters=[{id,name:record.name},{id:otherId,name:secondName}];
    const original=structuredClone(record);
    let catalogResult='offline';
    let zipUnavailable=false;
    let listCalls=0;
    const zipIds=[];
    const held=Promise.withResolvers();
    const started=Promise.withResolvers();
    const {root,store,origin}=await devServer(t,{
      list:async()=>{
        listCalls++;
        if(catalogResult==='offline')throw Error('connection refused');
        if(catalogResult==='empty')return [];
        if(catalogResult==='invalid')return [{id:'../invalid',name:record.name}];
        return characters;
      },
      prepareZip:async selected=>{
        zipIds.push(selected);
        if(zipUnavailable)throw Error('connection refused');
        if(selected===otherId) {
          started.resolve();
          await held.promise;
        }
        const {name}=characters.find(item=>item.id===selected);
        return {name,zip:buildCharacterZip(name,images)};
      },
    });
    // The existing ZIP and accessory pickers initialize this directory on first read.
    const importedRoot=join(root,'imported');
    await mkdir(importedRoot,{mode:0o700});
    const browser=await playwright.chromium.launch({executablePath:process.env.FRIEND_UI_CHROME});
    try {
      const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
      page.setDefaultTimeout(5000);
      const writes=[], external=[], pageErrors=[], downloads=[];
      page.on('request',req=>{if(req.method()!=='GET')writes.push(new URL(req.url()).pathname);});
      page.on('pageerror',error=>pageErrors.push(error.message));
      page.on('download',download=>downloads.push(download.suggestedFilename()));
      await page.route('**/*',route=>{
        if(route.request().url().startsWith(origin+'/'))return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      await page.goto(origin+'/parts-lab/preview.html');
      const refresh=page.getByRole('button',{name:'一覧更新'});
      const load=page.getByRole('button',{name:'プレビューに読み込む'});
      const picker=page.getByLabel('通常ゲームのキャラ',{exact:true});
      const register=page.locator('#registerZip');
      const feedback=message=>page.locator('#mainTransferStatus').filter({hasText:message}).waitFor();
      assert.equal(await picker.isDisabled(),true);
      assert.equal(await load.isDisabled(),true);
      assert.equal(listCalls,0);
      assert.deepEqual(zipIds,[]);

      for(const [result,message] of [
        ['offline','起動状態を確認'],['empty','読み込めるキャラがありません'],['invalid','形式が不正'],
      ]) {
        catalogResult=result;
        await refresh.click();
        await feedback(message);
        assert.equal(await picker.isDisabled(),true);
        assert.equal(await load.isDisabled(),true);
        assert.equal(await register.isDisabled(),true);
      }
      assert.deepEqual(writes,[]);
      assert.deepEqual(await readdir(importedRoot),[]);

      catalogResult='ok';
      await refresh.evaluate(button=>{button.click();button.click();});
      await feedback('通常ゲームのキャラを選んでください');
      assert.equal(listCalls,4);
      await picker.selectOption(otherId);
      assert.deepEqual(zipIds,[]);
      await load.evaluate(button=>{button.click();button.click();});
      await started.promise;
      assert.deepEqual(zipIds,[otherId]);
      assert.equal(await load.isDisabled(),true);
      assert.equal(await refresh.isDisabled(),true);
      await Promise.all([
        page.waitForEvent('requestfailed',req=>req.url()===origin+zipPath(otherId)),
        page.locator('#clear').click(),
      ]);
      await feedback('読み込みを中止しました');
      await picker.selectOption(id);
      await page.locator('#zipFrames').selectOption('1');
      await load.click();
      await page.locator('#stage[data-has-preview=true]').waitFor();
      held.resolve();
      await page.locator('#zipName:enabled').waitFor();
      assert.equal(await page.locator('#zipName').inputValue(),record.name);
      assert.equal(await page.locator('#zipFrames').inputValue(),'6');
      assert.equal(await page.locator('#zipEquipped li').count(),0);
      const pixel=await page.locator('#previewCanvas').evaluate(canvas=>({
        width:canvas.width,height:canvas.height,
        rgba:[...canvas.getContext('2d').getImageData(10,10,1,1).data],
      }));
      assert.deepEqual(pixel,{width:192,height:208,rgba:[30,80,130,255]});
      assert.deepEqual(zipIds,[otherId,id]);
      zipUnavailable=true;
      await load.click();
      await feedback('キャラ画像を取得できません');
      assert.equal(await page.locator('#stage[data-has-preview=true]').count(),1);
      assert.equal(await page.locator('#zipName').inputValue(),record.name);
      assert.deepEqual(writes,[]);
      assert.deepEqual(await readdir(importedRoot),[]);
      assert.equal(await register.isDisabled(),true);

      await page.locator('#zipHairStyle').selectOption('bob');
      await page.locator('#zipExpression').selectOption('calm');
      const [response]=await Promise.all([
        page.waitForResponse(res=>res.url()===origin+'/api/imported-characters/register'),
        register.click(),
      ]);
      assert.equal(response.status(),201,await response.text());
      const created=await response.json();
      assert.match(created.id,/^zip_[0-9a-f]{32}$/);
      assert.equal(created.ai_id,created.id);
      assert.equal(created.name,record.name);
      assert.equal(created.model_origin,'appearance_features');
      assert.ok(created.model.plugin_weights);
      assert.equal(JSON.stringify(created).includes(id),false);
      assert.equal(JSON.stringify(created).includes(record.model),false);
      assert.deepEqual((await store.list()).characters.map(character=>character.id),[created.id]);
      assert.deepEqual(record,original);
      assert.deepEqual(writes,['/api/imported-characters/register']);
      assert.deepEqual(external,[]);
      assert.deepEqual(downloads,[]);
      assert.deepEqual(pageErrors,[]);
    } finally {
      held.resolve();
      await browser.close();
    }
  });
