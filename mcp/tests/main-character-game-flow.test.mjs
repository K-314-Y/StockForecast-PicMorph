import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createArtworkExpressionStore} from '../../game_runtime/artwork-expressions.mjs';
import {createArtworkStore} from '../../game_runtime/artwork.mjs';
import {createCompanionStore} from '../../game_runtime/companion.mjs';
import {createGrowthStore} from '../../game_runtime/growth.mjs';
import {createImportedCharacterStore} from '../../game_runtime/imported-characters.mjs';
import {createLookStore} from '../../game_runtime/looks.mjs';
import {createModelShopStore} from '../../game_runtime/model-shop.mjs';
import {createPracticeEngineSourceGuard} from '../../game_runtime/practice-engine-fingerprint.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';
import {listMainCharacters,prepareMainCharacterZip} from '../../scripts/export-main-character-zip.mjs';
import {roundingPlan} from './audit74-fixture.mjs';

const catalogPath='/api/character-demos';
const transferPath='/api/main-character-transfer';
const registerPath='/api/imported-characters/register';
const practicePath='/api/quick-practice';
const parts=['body','ready','happy','cautious'];
const sha256=value=>createHash('sha256').update(value).digest('hex');

async function listen(t,server) {
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  t.after(()=>closeServer(server));
  return server.address().port;
}

function closeServer(server) {
  if(!server.listening)return;
  return new Promise((resolve,reject)=>{
    server.close(error=>error?reject(error):resolve());
    server.closeAllConnections();
  });
}

async function mockMain(t,page) {
  const record={generated_id:'cp_'+'a'.repeat(32),name:'通常ゲームの相棒',
    engine:'original-template',model:'private-main-model',equipment:['private-main-equipment']};
  const atlases=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');
    canvas.width=1152;
    canvas.height=208;
    const ctx=canvas.getContext('2d');
    return ['#1e5082','#ff0000','#00ff00','#0000ff'].map((color,index)=>{
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle=color;
      for(let x=0;x<canvas.width;x+=192) {
        if(index===0)ctx.fillRect(x,0,192,208);
        else ctx.fillRect(x+24,36,8,8);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    });
  });
  const imagePath=part=>`${catalogPath}/${record.generated_id}/${part}.png`;
  const replies=new Map([[catalogPath,['application/json',JSON.stringify([record])]],
    ...parts.map((part,index)=>[imagePath(part),['image/png',Buffer.from(atlases[index],'base64')]])]);
  const requests=[];
  const port=await listen(t,createServer((req,res)=>{
    requests.push([req.method,req.url]);
    const reply=req.method==='GET' && replies.get(req.url);
    if(!reply) {res.writeHead(404).end();return;}
    const [type,body]=reply;
    res.writeHead(200,{'Content-Type':type}).end(body);
  }));
  return {port,requests,record,imagePath};
}

async function isolatedDev(t,root,sourcePort) {
  const file=name=>join(root,name+'.json');
  const importedRoot=join(root,'imported');
  const importedCharacterStore=createImportedCharacterStore({root:importedRoot});
  const store=createGrowthStore({file:file('growth'),legacyFile:file('legacy')});
  const modelShopStore=createModelShopStore({file:file('shop')});
  const model={fast_window:3,slow_window:9,risk_fraction:.35,
    plugin_weights:{trend:100,momentum:0,volatility:0,reversion:0},
    plugin_strengths:{trend:100,momentum:100,volatility:100,reversion:100}};
  // Fingerprint the synthetic predictor fixture used by this isolated server.
  const practiceEngineSourceGuard=createPracticeEngineSourceGuard({sources:[
    ['audit74-fixture.mjs',fileURLToPath(new URL('./audit74-fixture.mjs',import.meta.url))],
  ]});
  const predictions=[];
  const server=createGameServer({
    store,modelShopStore,importedCharacterStore,practiceEngineSourceGuard,
    companionStore:createCompanionStore({file:file('companion')}),
    lookStore:createLookStore({file:file('look')}),
    artworkStore:createArtworkStore({file:file('artwork')}),
    artworkExpressionStore:createArtworkExpressionStore({file:file('expressions')}),
    forwardLedgerFile:file('wallet'),
    appearanceCatalog:async()=>({drafts:[]}),
    trainedVersions:async()=>({versions:[]}),
    loadSnapshot:async()=>({
      state:{model},lineup:{slots:['owl','turtle'].map(slot=>({slot,model}))},
      source_revision:1,lineup_revision:1,growth_revision:1,
    }),
    mainCharacterTransfer:{
      list:()=>listMainCharacters(sourcePort),
      prepareZip:id=>prepareMainCharacterZip(id,sourcePort),
    },
    historicalPredict:()=>assert.fail('Unexpected historical market prediction'),
    predict:async input=>{
      predictions.push(structuredClone(input));
      const models=Object.fromEntries(Object.entries(input.models).map(([slot,value])=>[
        slot,{...value,effective_sha256:sha256(JSON.stringify(value))},
      ]));
      return {...roundingPlan(),models,model_sha256:sha256(JSON.stringify(input.base_model))};
    },
  });
  const port=await listen(t,server);
  return {store,modelShopStore,importedCharacterStore,importedRoot,predictions,
    origin:`http://127.0.0.1:${port}`,close:()=>closeServer(server)};
}

async function checkFlow(t,{liveMain=false}={}) {
  let playwright;
  try {
    playwright=await import(process.env.FRIEND_UI_PLAYWRIGHT ?? 'playwright');
  }catch(error){
    if(!liveMain && !process.env.FRIEND_UI_PLAYWRIGHT && error.code==='ERR_MODULE_NOT_FOUND')
      return t.skip('Set FRIEND_UI_PLAYWRIGHT to run with Chromium.');
    throw error;
  }
  const root=await mkdtemp('/tmp/main-character-game-flow-');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const state=join(root,'state');
  await mkdir(state);
  const browser=await playwright.chromium.launch({executablePath:process.env.FRIEND_UI_CHROME,
    args:['--no-proxy-server']});
  t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  context.setDefaultTimeout(5000);
  const page=await context.newPage();
  const mock=liveMain?null:await mockMain(t,page);
  const sourcePort=mock?.port??8890;
  const {origin,store,modelShopStore,importedCharacterStore,importedRoot,predictions,close}=
    await isolatedDev(t,state,sourcePort);
  const sourceCatalog=async()=>{
    const response=await fetch(`http://127.0.0.1:${sourcePort}${catalogPath}`,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),
    });
    assert.equal(response.status,200);
    return response.json();
  };
  // Keep the live smoke opt-in. Select the first source offered by the audited bridge.
  const source=mock?{id:mock.record.generated_id,name:mock.record.name}:
    (await listMainCharacters(sourcePort))[0];
  assert.ok(source,'MAIN needs a saved cp_ character');
  const sourceRecord=async()=>(await sourceCatalog()).find(item=>item.generated_id===source.id);
  const originalSource=await sourceRecord();
  assert.ok(originalSource);
  if(mock)mock.requests.length=0;

  const external=[],pageErrors=[],posts=[];
  const allowedOrigins=new Set([origin]);
  context.on('weberror',event=>pageErrors.push(event.error().message));
  await context.route('**/*',route=>{
    const request=route.request();
    const url=new URL(request.url());
    if(!allowedOrigins.has(url.origin)) {external.push(url.href);return route.abort();}
    if(request.method()!=='GET')posts.push([request.method(),url.pathname]);
    return route.continue();
  });
  const respond=(tab,path,method='GET')=>tab.waitForResponse(response=>
    response.url()===origin+path && response.request().method()===method);
  const gamePath=(...ids)=>'/game?'+new URLSearchParams(ids.map(id=>['model',id]));
  const loadedStatus=(tab,message)=>tab.locator('#quickStatus').filter({hasText:message}).waitFor();
  const checkHtml=response=>{
    assert.equal(response.status(),200);
    assert.match(response.headers()['content-type'],/^text\/html/);
  };
  const missingZip='リンク先のZIPキャラが見つかりません。';
  const selectedZip='リンク先のZIPキャラのAIを選びました。';
  const model=page.locator('#quickModel');
  const details=page.locator('#quickZipDetails');

  const unknownId='zip_'+'0'.repeat(32);
  checkHtml(await page.goto(origin+gamePath(unknownId)));
  await loadedStatus(page,missingZip);
  assert.equal(await model.inputValue(),'self');
  assert.deepEqual(await readdir(state),[]);
  assert.deepEqual(posts,[]);

  await page.goto(origin+'/parts-lab/preview.html');
  const gameLink=page.locator('#zipGameLink a');
  assert.equal(await gameLink.getAttribute('href'),null);
  const picker=page.getByLabel('通常ゲームのキャラ',{exact:true});
  assert.equal(await picker.isDisabled(),true);
  assert.equal(await page.locator('#registerZip').isDisabled(),true);
  if(mock)assert.deepEqual(mock.requests,[]);
  const [catalog]=await Promise.all([respond(page,transferPath),
    page.getByRole('button',{name:'一覧更新'}).click()]);
  assert.equal(catalog.status(),200,await catalog.text());
  assert.ok((await catalog.json()).characters.some(item=>item.id===source.id));
  await picker.selectOption(source.id);
  if(mock)assert.deepEqual(mock.requests,[['GET',catalogPath]]);
  const [zip]=await Promise.all([respond(page,`${transferPath}/zip/${source.id}`),
    page.getByRole('button',{name:'プレビューに読み込む'}).click()]);
  assert.equal(zip.status(),200);
  const sourceZipSha=sha256(await zip.body());
  await page.locator('#stage[data-has-preview=true]').waitFor();
  await page.locator('#zipName:enabled').waitFor();
  assert.equal(await page.locator('#registerZip').isDisabled(),true);
  assert.equal(await page.locator('#zipName').inputValue(),source.name);
  assert.equal(await page.locator('#zipFrames').inputValue(),'6');
  assert.equal(await page.locator('#zipEquipped li').count(),0);
  assert.deepEqual(await readdir(importedRoot),[]);
  assert.deepEqual(posts,[]);
  assert.deepEqual(predictions,[]);
  if(mock)assert.deepEqual(mock.requests,
    [catalogPath,catalogPath,...parts.map(mock.imagePath)].map(path=>['GET',path]));

  // Choose two DEV analysis accessories so the saved equipment hash is exercised.
  await page.locator('#zipHairStyle').selectOption('bob');
  await page.locator('#zipExpression').selectOption('calm');
  for(const accessory of ['star','glasses']) {
    await page.locator('#zipAccessory').selectOption(accessory);
    await page.locator('#zipEquip').click();
  }
  await page.route(origin+registerPath,route=>route.fulfill({
    status:503,json:{error:'登録できませんでした。'},
  }),{times:1});
  await page.locator('#registerZip').click();
  await page.locator('#zipRegisterStatus').filter({hasText:'登録に失敗しました'}).waitFor();
  assert.equal(await gameLink.isVisible(),false);
  assert.equal(await gameLink.getAttribute('href'),null);
  assert.deepEqual(await readdir(importedRoot),[]);
  const [registration]=await Promise.all([respond(page,registerPath,'POST'),
    page.locator('#registerZip').click()]);
  assert.equal(registration.status(),201,await registration.text());
  const created=await registration.json();
  assert.match(created.id,/^zip_[a-f0-9]{32}$/);
  assert.notEqual(created.id,source.id);
  assert.equal(created.ai_id,created.id);
  assert.equal(created.name,source.name);
  assert.equal(created.trained,false);
  assert.equal(created.model_origin,'appearance_features');
  if(mock) {
    const saved=JSON.stringify(created);
    for(const sourceOnly of [source.id,mock.record.model,...mock.record.equipment])
      assert.equal(saved.includes(sourceOnly),false);
  }
  const originalModel=await importedCharacterStore.model(created.id);
  assert.match(originalModel.equipment_hash,/^[a-f0-9]{64}$/);
  assert.deepEqual(originalModel.accessory_methods,['bollinger_breakout','rsi_oversold']);
  const storeState=()=>Promise.all([store.public(),modelShopStore.public()]);
  const beforePractice=await storeState();
  const originalSha=sha256((await importedCharacterStore.image(created.id)).bytes);
  assert.equal(new URL(created.image_url,origin).searchParams.get('v'),originalSha);

  const deepLink=gamePath(created.id);
  await gameLink.waitFor();
  assert.equal(await gameLink.getAttribute('href'),deepLink);
  const [gameResponse,initialModels]=await Promise.all([respond(page,deepLink),
    respond(page,'/api/model-shop'),gameLink.click()]);
  checkHtml(gameResponse);
  await page.waitForURL(origin+deepLink);
  assert.equal(initialModels.status(),200,await initialModels.text());
  assert.deepEqual((await initialModels.json()).imported_characters.find(({id})=>id===created.id),created);
  await loadedStatus(page,selectedZip);
  assert.equal(await model.inputValue(),created.id);
  assert.equal(await model.locator(`option[value="${source.id}"]`).count(),0);
  const gamePortrait=page.locator('#quickZipPortrait');
  const replayPortrait=page.locator('#quickMiniPortrait');
  const loadedPortrait=async(locator,url,base=origin)=>{
    await locator.waitFor();
    await page.waitForFunction(({id,url})=>{
      const img=document.getElementById(id);
      return img?.src===url && img.complete && img.naturalWidth>0;
    },{id:await locator.getAttribute('id'),url:new URL(url,base).href});
  };
  await loadedPortrait(gamePortrait,created.image_url);
  const expectedDetails=await details.textContent();
  assert.ok(expectedDetails.includes(created.name));
  assert.match(expectedDetails,/星（ボリンジャーバンド.*眼鏡（RSI/);
  assert.ok(expectedDetails.includes('資金使用率'+Math.round(created.model.risk_fraction*100)+'%'));
  assert.deepEqual(posts,[['POST',registerPath]]);
  assert.deepEqual(predictions,[]);
  await page.locator('#quickAmount').fill('2750');
  await page.locator('#quickLeverage').selectOption('3');
  await page.locator('#quickConfirm').click();
  assert.deepEqual(posts,[['POST',registerPath]]);
  const [practice]=await Promise.all([respond(page,practicePath,'POST'),
    page.locator('#quickRun').click()]);
  assert.equal(practice.status(),200,await practice.text());
  assert.deepEqual(practice.request().postDataJSON(),{model_id:created.id,amount:2750,leverage:3});
  const result=await practice.json();
  assert.equal(result.mode,'SIMPLE_SYNTHETIC_PRACTICE_ONLY');
  assert.equal(result.model_id,created.id);
  assert.match(result.scenario_token,/^v1_[0-9a-f]{16}$/);
  assert.equal(result.steps,12);
  assert.deepEqual(result.daily_synthetic_prices,[109,...roundingPlan().future_prices]);
  assert.deepEqual(result.daily_ai_signals,roundingPlan().signals.map(({mine})=>mine));
  assert.equal(result.daily_balances.length,13);
  assert.equal(result.liquidated_at_step,null);
  for(const key of ['real_market','persisted','order_placed','xp_awarded'])assert.equal(result[key],false,key);
  assert.equal(predictions.length,1);
  assert.deepEqual(predictions[0].models.mine,originalModel.model);
  assert.deepEqual(predictions[0].accessory_methods,originalModel.accessory_methods);
  assert.equal(result.model_effective_sha256,sha256(JSON.stringify(originalModel.model)));
  await page.getByRole('heading',{name:'12日間の試算結果'}).waitFor();
  const stats=page.locator('#quickResult');
  const beforeStats=await stats.innerText();
  assert.ok(beforeStats.includes(source.name));
  assert.match(beforeStats,/2,750 C.*×3の損益.*残高/s);
  assert.match(beforeStats,/最大下落率/);
  await loadedPortrait(replayPortrait,created.image_url);
  const nextDay=page.locator('#quickFollowing');
  for(let day=1;day<=12;day++)await nextDay.click();
  assert.equal(await nextDay.isDisabled(),true);
  const replayDay=page.locator('#quickReplayDay');
  const replayContext=page.locator('#quickReplayContext');
  const beforeReplay=await Promise.all([replayDay.innerText(),replayContext.innerText()]);
  assert.match(beforeReplay[0],/^第12日/);
  assert.match(beforeReplay[1],/架空の終値：117/);

  const editPath=`/api/imported-characters/visual-edit/${created.id}`;
  const [editor]=await Promise.all([context.waitForEvent('page'),page.locator('#quickZipEditLink').click()]);
  assert.equal(editor.url(),`${origin}/parts-lab/preview.html?edit=${created.id}`);
  await editor.locator('#saveVisualEdit:enabled').waitFor();
  assert.equal(await editor.locator('#editCharacter').inputValue(),created.id);
  await editor.locator('#mood').selectOption('happy');
  await editor.locator('#movePart').selectOption('base');
  await editor.locator('#layerX').fill('17');
  await editor.locator('#saveVisualEdit').click();
  assert.deepEqual(posts,[['POST',registerPath],['POST',practicePath]]);
  const [save]=await Promise.all([respond(editor,editPath,'POST'),
    editor.locator('#confirmPortraitSave').click()]);
  assert.equal(save.status(),200,await save.text());
  const edited=await save.json();
  assert.equal(edited.id,created.id);
  assert.notEqual(edited.image_sha256,originalSha);
  await editor.locator('#editStatus').filter({hasText:'同じキャラIDで保存画像を更新しました'}).waitFor();

  const {characters:[updated]}=await importedCharacterStore.list();
  assert.deepEqual(updated,{...created,image_url:updated.image_url});
  assert.deepEqual(await importedCharacterStore.model(created.id),originalModel);
  const editedImage=await importedCharacterStore.image(created.id);
  assert.equal(sha256(editedImage.bytes),edited.image_sha256);
  assert.equal(new URL(updated.image_url,origin).searchParams.get('v'),edited.image_sha256);

  // Return to the same game tab, as the edit link opens a separate tab.
  const refreshedModels=respond(page,'/api/model-shop');
  await page.bringToFront();
  // Headless Chromium keeps both pages focused under Playwright.
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  assert.equal((await refreshedModels).status(),200);
  await loadedPortrait(gamePortrait,updated.image_url);
  await loadedPortrait(replayPortrait,updated.image_url);
  assert.equal(await model.inputValue(),created.id);
  assert.equal(await page.locator('#quickAmount').inputValue(),'2750');
  assert.equal(await page.locator('#quickLeverage').inputValue(),'3');
  assert.equal(await stats.innerText(),beforeStats);
  assert.deepEqual(await Promise.all([replayDay.innerText(),replayContext.innerText()]),beforeReplay);
  await page.locator('#quickPrevious').click();
  assert.match(await replayDay.innerText(),/^第11日/);
  await page.locator('#quickConfirm').click();
  await page.locator('#quickSameScenario').check();
  assert.match(await page.locator('#quickScenarioNote').innerText(),/同じ架空相場での再挑戦/);

  await model.selectOption('self');
  const [manualRefresh]=await Promise.all([respond(page,'/api/model-shop'),
    page.evaluate(()=>window.dispatchEvent(new Event('focus')))]);
  assert.equal(manualRefresh.status(),200);
  await loadedStatus(page,'登録済み・解放済みのAIから選べます。');
  assert.equal(await model.inputValue(),'self');
  assert.equal(await gamePortrait.getAttribute('src'),null);
  await editor.close();

  checkHtml(await page.goto(origin+gamePath(unknownId)));
  await loadedStatus(page,missingZip);
  assert.equal(await model.inputValue(),'self');
  for(const ids of [['<b>無効</b>'],[created.id+'\n'],[created.id.toUpperCase()],
    ['demo_trend'],['self'],[created.id,'self']]) {
    checkHtml(await page.goto(origin+gamePath(...ids)));
    await loadedStatus(page,'登録済み・解放済みのAIから選べます。');
    assert.equal(await model.inputValue(),'self');
    assert.equal(await gamePortrait.getAttribute('src'),null);
  }
  const modelShopUrl=origin+'/api/model-shop';
  await page.route(modelShopUrl,route=>route.fulfill({
    status:503,json:{error:'一覧を読み込めませんでした。'},
  }));
  checkHtml(await page.goto(origin+deepLink));
  await loadedStatus(page,'モデル一覧を読み込めません。');
  assert.equal(await model.inputValue(),'self');
  await page.unroute(modelShopUrl);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await loadedStatus(page,selectedZip);
  assert.equal(await model.inputValue(),created.id);
  await loadedPortrait(gamePortrait,updated.image_url);

  assert.deepEqual(await storeState(),beforePractice);
  assert.deepEqual(await readdir(state),['imported']);
  assert.deepEqual(await readdir(importedRoot),[created.id+'.json']);
  const savedFile=join(importedRoot,created.id+'.json');
  const savedBytes=await readFile(savedFile);
  await close();
  const restarted=await isolatedDev(t,state,sourcePort);
  allowedOrigins.add(restarted.origin);
  checkHtml(await page.goto(restarted.origin+deepLink));
  await loadedStatus(page,selectedZip);
  assert.equal(await model.inputValue(),created.id);
  await loadedPortrait(gamePortrait,updated.image_url,restarted.origin);
  assert.equal(await details.textContent(),expectedDetails);
  assert.deepEqual(await restarted.importedCharacterStore.list(),{characters:[updated]});
  assert.deepEqual(await restarted.importedCharacterStore.model(created.id,{readOnly:true}),originalModel);
  assert.deepEqual(await readFile(savedFile),savedBytes);
  assert.deepEqual(await readdir(state),['imported']);
  assert.deepEqual(restarted.predictions,[]);
  assert.equal(sha256((await prepareMainCharacterZip(source.id,sourcePort)).zip),sourceZipSha);
  assert.deepEqual(await sourceRecord(),originalSource);
  assert.deepEqual(posts,[['POST',registerPath],['POST',practicePath],['POST',editPath]]);
  assert.equal(predictions.length,1);
  assert.deepEqual(external,[]);
  assert.deepEqual(pageErrors,[]);
}

test('Chromium deep-links to a new ZIP AI and preserves its model and equipment through visual edits and restart',
  {timeout:45_000},t=>checkFlow(t));

test('Chromium smoke from the read-only MAIN bridge on 8890 into temporary DEV',
  {timeout:45_000,skip:process.env.CREATURE_MAIN_READONLY_SMOKE!=='1'},t=>checkFlow(t,{liveMain:true}));
