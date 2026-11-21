import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createImportedCharacterStore} from '../../game_runtime/imported-characters.mjs';
import {createModelShopStore} from '../../game_runtime/model-shop.mjs';
import {createCompanionStore} from '../../game_runtime/companion.mjs';
import {createGrowthStore} from '../../game_runtime/growth.mjs';
import {createLookStore} from '../../game_runtime/looks.mjs';
import {createArtworkStore} from '../../game_runtime/artwork.mjs';
import {createArtworkExpressionStore} from '../../game_runtime/artwork-expressions.mjs';
import {canvasPoint,overlayPosition,overlayRect} from '../../game_runtime/parts-lab/accessory-overlay.mjs';
import {archive} from './zip-fixture.mjs';

test('drag geometry projects a letterboxed frame and preserves fixed axes',()=>{
  const box={left:10,top:20,width:300,height:200};
  assert.deepEqual(canvasPoint({clientX:60,clientY:20},box,400,400),[0,0]);
  assert.deepEqual(canvasPoint({clientX:59,clientY:220},box,400,400),[-2,400]);
  const overlay={bitmap:{width:400,height:80},x:37,y:0,scale:100};
  assert.deepEqual(overlayRect(400,400,overlay),[0,160,400,80]);
  assert.equal(overlayPosition(175,0,0,overlay.x),37);
  assert.equal(overlayPosition(240,320,160,0),50);
  assert.equal(overlayPosition(-20,320,160,0),-100);
  assert.equal(overlayPosition(400,320,160,0),100);
});

test('Chrome registers and re-edits ZIP portraits used in the 12-day game and replay',
  {timeout:60_000},async t=>{
    let playwright;
    try {
      playwright=await import(process.env.FRIEND_UI_PLAYWRIGHT ?? 'playwright');
    } catch (error) {
      if (!process.env.FRIEND_UI_PLAYWRIGHT && error.code==='ERR_MODULE_NOT_FOUND')
        return t.skip('Set FRIEND_UI_PLAYWRIGHT to run this test with Playwright.');
      throw error;
    }
    const root=await mkdtemp(join(tmpdir(),'parts-lab-chrome-'));
    const file=name=>join(root,name+'.json');
    const importedRoot=join(root,'imported');
    const importedCharacterStore=createImportedCharacterStore({root:importedRoot});
    const model={fast_window:3,slow_window:9,risk_fraction:.35,
      plugin_weights:{trend:100,momentum:0,volatility:0,reversion:0},
      plugin_strengths:{trend:100,momentum:100,volatility:100,reversion:100}};
    const server=createGameServer({
      importedCharacterStore,
      store:createGrowthStore({file:file('growth'),legacyFile:file('legacy')}),
      modelShopStore:createModelShopStore({file:file('shop')}),
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
    });
    let browser;
    try {
      await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,'127.0.0.1',resolve);
      });
      const origin='http://127.0.0.1:'+server.address().port;
      browser=await playwright.chromium.launch({executablePath:process.env.FRIEND_UI_CHROME});
      const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce',
        deviceScaleFactor:2,hasTouch:true});
      page.setDefaultTimeout(5000);
      const pageErrors=[];
      const external=[];
      const writes=[];
      page.on('pageerror',error=>pageErrors.push(error.message));
      page.on('request',request=>{
        if (request.method()==='POST') writes.push(new URL(request.url()).pathname);
      });
      await page.route('**/*',route=>{
        if (route.request().url().startsWith(origin+'/')) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      await page.addInitScript(()=>{
        const decode=window.createImageBitmap;
        const close=ImageBitmap.prototype.close;
        const names=new WeakMap();
        window.closedOverlays=[];
        window.createImageBitmap=async source=>{
          const bitmap=await decode(source);
          if (source.name?.startsWith('overlay-')) names.set(bitmap,source.name);
          if (window.holdOverlay && source.name===window.holdOverlay) {
            await new Promise(resolve=>{window.finishOverlay=resolve;});
          }
          return bitmap;
        };
        ImageBitmap.prototype.close=function(){
          if (names.has(this)) window.closedOverlays.push(names.get(this));
          close.call(this);
        };
      });
      await page.goto(origin+'/parts-lab/preview.html');

      const fixture=await page.evaluate(()=>{
        const image=(width,height,draw,mime='image/png')=>{
          const canvas=document.createElement('canvas');
          canvas.width=width;
          canvas.height=height;
          draw(canvas.getContext('2d'));
          return canvas.toDataURL(mime).split(',')[1];
        };
        const atlas=(frames,side=64)=>({
          body:image(side*frames,side,ctx=>{
            for (let i=0;i<frames;i++) {
              ctx.fillStyle=i===0?'#15304b':'#305a72';
              ctx.fillRect(i*side,0,side,side);
            }
          }),
          ready:image(side*frames,side,ctx=>{
            ctx.fillStyle='#eeeeee';ctx.fillRect(14,3,4,4);
          }),
          happy:image(side*frames,side,ctx=>{
            ctx.fillStyle='#ffff00';ctx.fillRect(14,3,4,4);
          }),
        });
        return {one:atlas(1,400),six:atlas(6),
          largeRed:image(80,80,ctx=>{ctx.fillStyle='#ff0000';ctx.fillRect(16,16,48,48);}),
          red:image(12,12,ctx=>{ctx.fillStyle='#ff0000';ctx.fillRect(2,2,8,8);}),
          green:image(12,12,ctx=>{ctx.fillStyle='#00ff00';ctx.fillRect(2,2,8,8);},'image/webp'),
          opaque:image(12,12,ctx=>ctx.fillRect(0,0,12,12)),
        };
      });
      const bytes=key=>Buffer.from(fixture[key],'base64');
      const zip=async(frames,images,appearance)=>{
        const entries=Object.entries(images).map(([part,data])=>[
          part+(frames===6?'_6frames':'')+'.png',Buffer.from(data,'base64'),
        ]);
        entries.push(['manifest.json',JSON.stringify({appearance})]);
        return {name:'character.zip',mimeType:'application/zip',
          buffer:Buffer.from(await archive(entries).arrayBuffer())};
      };
      const zipInput=page.locator('#zipFile');
      const register=page.locator('#registerZip');
      const traits={hair_style:'bob',expression:'calm'};
      const legacyZip=await zip(1,fixture.one,{...traits,name:'従来キャラ',accessory:'star'});
      const multiZip=await zip(6,fixture.six,{...traits,name:'重ね絵テスト',
        accessories:['star','glasses',{name:'<b>手作り</b>',method:'macd_momentum'}]});
      const row=index=>page.locator('#zipEquipped li').nth(index);
      const adjustment=(index,key)=>row(index).locator('[data-overlay='+key+']');
      const position=async index=>Promise.all(['x','y'].map(async key=>
        Number(await adjustment(index,key).inputValue())));
      const preview=page.locator('#previewCanvas');
      const point=async (x,y)=>{
        const box=await preview.boundingBox();
        const side=await preview.evaluate(node=>node.width);
        const size=Math.min(box.width,box.height);
        return [box.x+(box.width-size)/2+x*size/side,
          box.y+(box.height-size)/2+y*size/side];
      };
      const down=async(x,y)=>{
        await page.mouse.move(...await point(x,y));
        await page.mouse.down();
      };
      const dragging=()=>preview.getAttribute('data-overlay-dragging');
      const upload=(index,name,data,mimeType='image/png')=>row(index).locator('input[type=file]')
        .setInputFiles({name,mimeType,buffer:bytes(data)});
      const pixels=(selector,x=0,y=0,width=1,height=1)=>page.locator(selector)
        .evaluate(async(node,{x,y,width,height})=>{
          if (node instanceof HTMLImageElement) {
            await node.decode();
            const canvas=document.createElement('canvas');
            canvas.width=node.naturalWidth;
            canvas.height=node.naturalHeight;
            canvas.getContext('2d').drawImage(node,0,0);
            node=canvas;
          }
          return Array.from(node.getContext('2d').getImageData(x,y,width,height).data);
        },{x,y,width,height});
      const pixel=(x,y,selector='#previewCanvas')=>pixels(selector,x,y);
      const bg=[21,48,75,255];
      const red=[255,0,0,255];
      const saved=()=>page.waitForResponse(response=>response.url()===origin+'/api/imported-characters/register');
      const waitEnabled=()=>page.waitForFunction(()=>!document.getElementById('registerZip').disabled);
      const registerNow=async()=>{
        const response=saved();
        await register.click();
        const result=await response;
        assert.equal(result.status(),201,await result.text());
        await page.locator('#zipGameLink').waitFor();
        return result.json();
      };

      await page.locator('#zipFrames').selectOption('1');
      await zipInput.setInputFiles(legacyZip);
      await waitEnabled();
      assert.match(await page.locator('#frameInfo').textContent(),/1 \/ 1/);
      assert.deepEqual(await pixel(200,200),bg);
      await upload(0,'overlay-one.png','largeRed');
      await waitEnabled();
      assert.deepEqual(await pixel(200,200),red);
      await preview.evaluate(node=>{
        node.style.width='280px';
        node.style.height='210px';
      });
      await preview.scrollIntoViewIfNeeded();
      const box=await preview.boundingBox();
      assert.ok(box.width>box.height && box.width<400);
      assert.equal(await page.evaluate(()=>window.devicePixelRatio),2);
      for (const [x,y] of [[-20,200],[162,162],[100,100]]) {
        await down(x,y);
        assert.equal(await dragging(),null);
        await page.mouse.move(...await point(250,250),{steps:3});
        await page.mouse.up();
        assert.deepEqual(await position(0),[0,0]);
      }

      // Use Chrome touch input on the running single-frame animation.
      await page.emulateMedia({reducedMotion:'no-preference'});
      const cdp=await page.context().newCDPSession(page);
      const touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{
        type,touchPoints:x===undefined?[]:[{x,y}],
      });
      const [touchX,touchY]=await point(195,195);
      await touch('touchStart',touchX,touchY);
      assert.equal(await dragging(),'');
      assert.deepEqual(await preview.evaluate(node=>{
        const style=getComputedStyle(node);
        return [style.cursor,style.touchAction,style.animationPlayState];
      }),['grabbing','none','paused']);
      const frozen=await preview.boundingBox();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.deepEqual(await preview.boundingBox(),frozen);
      assert.deepEqual(await position(0),[0,0]);
      await touch('touchMove',touchX+42,touchY-42);
      await page.waitForFunction(()=>Number(document.querySelector('[data-overlay=x]').value)>45);
      const [touchPositionX,touchPositionY]=await position(0);
      assert.ok(Math.abs(touchPositionX-50)<=2 && Math.abs(touchPositionY+50)<=2);
      assert.deepEqual(await pixel(200,200),bg);
      assert.deepEqual(await pixel(280,120),red);
      await touch('touchCancel');
      assert.equal(await dragging(),null);
      assert.deepEqual(await position(0),[touchPositionX,touchPositionY]);
      assert.equal(await preview.evaluate(node=>getComputedStyle(node).animationPlayState),'running');
      await cdp.detach();
      await page.emulateMedia({reducedMotion:'reduce'});
      await preview.evaluate(node=>{node.style.width='';node.style.height='';});
      await row(0).getByRole('button',{name:'重ね絵だけ外す'}).click();
      assert.deepEqual(await pixel(200,200),bg);
      assert.equal(await preview.evaluate(node=>getComputedStyle(node).touchAction),'auto');
      assert.equal(await row(0).count(),1);
      assert.deepEqual(writes,[]);
      const legacy=await registerNow();
      assert.equal(legacy.accessory_analysis.accessory,'star');
      const legacyPortrait=await page.request.get(origin+legacy.image_url);
      const legacyBytes=await legacyPortrait.body();

      await page.locator('#zipFrames').selectOption('6');
      await zipInput.setInputFiles(multiZip);
      await waitEnabled();
      assert.match(await page.locator('#frameInfo').textContent(),/1 \/ 6/);
      await row(2).getByText('<b>手作り</b>',{exact:false}).waitFor();
      assert.equal(await row(2).locator('b').count(),0);
      assert.deepEqual(await pixel(32,32),bg);
      await upload(0,'overlay-star.png','red');
      await waitEnabled();
      assert.deepEqual(await pixel(32,32),red);
      await upload(0,'overlay-rejected.png','opaque');
      await row(0).locator('[data-error=true]').waitFor();
      assert.deepEqual(await pixel(32,32),red);
      await upload(1,'overlay-spoof.png','green');
      await row(1).locator('[data-error=true]').waitFor();
      await upload(1,'overlay-glasses.webp','green','image/webp');
      await waitEnabled();
      const green=await pixel(32,32);
      assert.ok(green[0]<10 && green[1]>245 && green[2]<10 && green[3]===255);

      // Both overlays have a visible pixel here. Only the front one moves.
      await preview.scrollIntoViewIfNeeded();
      await preview.evaluate(node=>node.addEventListener('pointerdown',event=>{
        node.dataset.testPointerId=event.pointerId;
      },{once:true}));
      await down(32,32);
      assert.equal(await dragging(),'');
      await page.mouse.move(...await point(45,19),{steps:3});
      assert.deepEqual(await position(0),[0,0]);
      assert.deepEqual(await position(1),[50,-50]);
      assert.deepEqual(await pixel(32,32),red);
      assert.deepEqual(await pixel(45,19),green);
      await preview.evaluate(node=>node.releasePointerCapture(Number(node.dataset.testPointerId)));
      await page.mouse.move(...await point(50,15));
      assert.equal(await dragging(),null);
      await page.mouse.up();
      assert.deepEqual(await position(1),[50,-50]);
      await adjustment(1,'x').fill('0');
      await adjustment(1,'y').fill('0');
      await adjustment(1,'y').press('ArrowUp');
      assert.deepEqual(await position(1),[0,1]);
      await adjustment(1,'y').fill('0');

      await row(0).locator('[data-overlay=x]').fill('100');
      await row(0).locator('[data-overlay=y]').fill('-100');
      await row(0).locator('[data-overlay=scale]').fill('200');
      assert.deepEqual(await pixel(52,12),red);
      assert.deepEqual(await pixel(32,32),green);
      await page.emulateMedia({reducedMotion:'no-preference'});
      await page.waitForFunction(()=>{
        const canvas=document.getElementById('previewCanvas');
        return canvas.getContext('2d').getImageData(0,0,1,1).data[0]===48;
      });
      assert.deepEqual(await pixel(52,12),red);
      assert.deepEqual(await pixel(32,32),green);
      await page.emulateMedia({reducedMotion:'reduce'});

      // Switch ZIPs during decode, even though the replacement has the same ids.
      await page.evaluate(()=>{window.holdOverlay='overlay-stale.png';});
      await upload(2,'overlay-stale.png','red');
      await page.waitForFunction(()=>window.finishOverlay);
      assert.equal(await register.isDisabled(),true);
      await preview.scrollIntoViewIfNeeded();
      await down(52,12);
      assert.equal(await dragging(),'');
      await zipInput.setInputFiles(multiZip);
      await waitEnabled();
      assert.equal(await dragging(),null);
      await page.mouse.up();
      assert.deepEqual(await position(0),[0,0]);
      await page.evaluate(()=>window.finishOverlay());
      await page.waitForFunction(()=>window.closedOverlays.includes('overlay-stale.png'));
      assert.deepEqual(await pixel(32,32),bg);
      assert.deepEqual(await page.evaluate(()=>[...window.closedOverlays].sort()),[
        'overlay-glasses.webp','overlay-one.png','overlay-rejected.png','overlay-stale.png','overlay-star.png',
      ]);

      await upload(0,'overlay-final.png','red');
      await waitEnabled();
      await row(0).locator('[data-overlay=scale]').fill('200');
      await preview.scrollIntoViewIfNeeded();
      await down(32,32);
      await page.mouse.move(...await point(80,-10),{steps:4});
      assert.deepEqual(await position(0),[100,-100]);
      assert.deepEqual(await pixel(52,12),red);
      await page.mouse.up();
      assert.equal(await dragging(),null);
      await upload(1,'overlay-final.webp','green','image/webp');
      await waitEnabled();
      await page.locator('#mood').selectOption('happy');
      const expectedPortrait=await pixels('#previewCanvas',0,0,64,64);
      assert.deepEqual(await pixel(52,12),red);
      assert.deepEqual(await pixel(32,32),green);
      assert.deepEqual(await pixel(15,4),[255,255,0,255]);
      let releaseRegistration;
      let notifyRegistration;
      const registrationStarted=new Promise(resolve=>{notifyRegistration=resolve;});
      const gate=new Promise(resolve=>{releaseRegistration=resolve;});
      await page.route('**/api/imported-characters/register',async route=>{
        notifyRegistration();
        await gate;
        await route.continue();
      });
      const response=saved();
      await register.click();
      try {
        await registrationStarted;
        for (const selector of [
          '#zipFile','#clear','#mood','#frames','#fps','#zipAccessory','#zipAddAccessory',
          '#zipEquipped input[type=file]','#zipEquipped [data-overlay]',
          '#zipEquipped button',
        ]) {
          for (const control of await page.locator(selector).all())
            assert.equal(await control.isDisabled(),true,selector);
        }
      } finally {releaseRegistration();}
      const result=await response;
      assert.equal(result.status(),201,await result.text());
      const created=await result.json();
      await page.locator('#zipGameLink').waitFor();
      assert.equal(created.accessory_analysis.equipped.length,3);
      const stored=JSON.parse(await readFile(join(importedRoot,created.id+'.json'),'utf8'));
      assert.deepEqual(Object.keys(stored.images).sort(),['body','happy','portrait','ready']);
      for (const part of ['body','ready','happy'])
        assert.equal(stored.images[part].base64,fixture.six[part]);
      assert.deepEqual(await (await page.request.get(origin+created.image_url)).body(),
        Buffer.from(stored.images.portrait.base64,'base64'));
      assert.deepEqual(await (await page.request.get(origin+legacy.image_url)).body(),legacyBytes);

      const chooser=page.locator('#editCharacter');
      const openEdit=async id=>{
        await chooser.locator('option[value="'+id+'"]').waitFor({state:'attached'});
        await chooser.selectOption(id);
        await page.locator('#openVisualEdit').click();
        await page.locator('#visualEdit').waitFor();
        await page.waitForFunction(()=>!document.getElementById('saveVisualEdit').disabled);
      };
      const saveEdit=()=>page.locator('#saveVisualEdit').click();
      const closeEdit=()=>page.locator('#cancelVisualEdit').click();
      const waitEditReady=()=>page.waitForFunction(()=>!document.getElementById('saveVisualEdit').disabled);
      await openEdit(legacy.id);
      assert.match(await page.locator('#frameInfo').textContent(),/1 \/ 1.*400 × 400/);
      assert.equal(await page.locator('#zipEquipped li').count(),1);
      await upload(0,'overlay-legacy-edit.png','largeRed');
      await waitEditReady();
      assert.deepEqual(await pixel(200,200),red);
      await saveEdit();
      await page.locator('#confirmVisualEdit').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('#confirmVisualEdit').waitFor({state:'hidden'});
      await closeEdit();
      assert.deepEqual((await importedCharacterStore.image(legacy.id)).bytes,legacyBytes);
      assert.equal(writes.length,2);

      const getModel=()=>importedCharacterStore.model(created.id);
      const originalModel=await getModel();
      const predictSameScenario=async()=>{
        const response=await page.request.post(origin+'/api/quick-practice',{
          data:{model_id:created.id,amount:1000,scenario_token:'v1_0123456789abcdef'},
        });
        assert.equal(response.status(),200,await response.text());
        return response.json();
      };
      const baseline=await predictSameScenario();
      const editPath='/api/imported-characters/visual-edit/'+created.id;
      const portraitResponse=()=>page.waitForResponse(response=>
        response.url()===origin+editPath && response.request().method()==='POST');
      const replacePortrait=()=>page.locator('#confirmPortraitSave').click();
      await openEdit(created.id);
      assert.match(await page.locator('#frameInfo').textContent(),/1 \/ 6.*64 × 64/);
      assert.match(await page.locator('#editModel').textContent(),new RegExp(created.model_version));
      assert.match(await page.locator('#editTraits').textContent(),/慎重/);
      assert.match(await page.locator('#visualEdit .caution').textContent(),/再アップロード/);
      assert.equal(await page.locator('#zipAccessory').isVisible(),false);
      assert.equal(await row(0).locator('[data-action=unequip]').isVisible(),false);
      assert.equal(await page.locator('#registerZip').isVisible(),false);
      for (const selector of ['#frames','#mood','#faceX','#faceY','#zipHairColor','#zipExpression'])
        assert.equal(await page.locator(selector).isDisabled(),true,selector);
      assert.deepEqual(await pixels('#editSavedPortrait',0,0,64,64),expectedPortrait);
      assert.deepEqual(await pixel(32,32),bg);
      await saveEdit();
      assert.match(await page.locator('#confirmOverlayCount').textContent(),/0 \/ 3/);
      await page.locator('#abortPortraitSave').click();
      assert.equal(writes.length,2);
      await upload(2,'overlay-custom-edit.png','red');
      await waitEditReady();
      await preview.scrollIntoViewIfNeeded();
      await down(32,32);
      await page.mouse.move(...await point(50,22),{steps:4});
      await page.mouse.up();
      assert.notDeepEqual(await position(2),[0,0]);
      await adjustment(2,'scale').fill('150');
      const editedPortrait=await pixels('#previewCanvas',0,0,64,64);
      assert.deepEqual(await pixel(50,22),red);
      assert.deepEqual(await pixel(32,32),bg);
      const portraitFile=join(importedRoot,created.id+'.json');
      assert.deepEqual(JSON.parse(await readFile(portraitFile,'utf8')),stored);
      const updatedResponse=portraitResponse();
      await saveEdit();
      await replacePortrait();
      const updated=await updatedResponse;
      assert.equal(updated.status(),200,await updated.text());
      const savedVersion=await updated.json();
      assert.equal(savedVersion.id,created.id);
      await page.waitForFunction(()=>document.getElementById('editStatus').textContent.includes('更新しました'));
      assert.deepEqual(await pixels('#editSavedPortrait',0,0,64,64),editedPortrait);
      const editedRecord=JSON.parse(await readFile(portraitFile,'utf8'));
      assert.deepEqual({...editedRecord,images:{...editedRecord.images,portrait:stored.images.portrait}},stored);
      assert.deepEqual(await getModel(),originalModel);
      const after=await predictSameScenario();
      assert.deepEqual(after.daily_ai_signals,baseline.daily_ai_signals);
      assert.deepEqual(after.daily_synthetic_prices,baseline.daily_synthetic_prices);

      // Open another editor before the next write, so it holds the older SHA.
      const stale=await browser.newPage({reducedMotion:'reduce'});
      stale.setDefaultTimeout(5000);
      await stale.goto(origin+'/parts-lab/preview.html');
      await stale.locator('#editCharacter').selectOption(created.id);
      await stale.locator('#openVisualEdit').click();
      await stale.locator('#visualEdit').waitFor();
      await adjustment(2,'x').fill('75');
      const secondPortrait=await pixels('#previewCanvas',0,0,64,64);
      const secondResponse=portraitResponse();
      await saveEdit();
      await replacePortrait();
      assert.equal((await secondResponse).status(),200);
      await waitEditReady();
      const committed=await readFile(portraitFile);
      await stale.locator('#zipEquipped li').nth(0).locator('input[type=file]').setInputFiles({
        name:'overlay-stale.png',mimeType:'image/png',buffer:bytes('red'),
      });
      await stale.waitForFunction(()=>!document.getElementById('saveVisualEdit').disabled);
      const conflictResponse=stale.waitForResponse(res=>res.url()===origin+editPath && res.request().method()==='POST');
      await stale.locator('#saveVisualEdit').click();
      await stale.locator('#confirmPortraitSave').click();
      assert.equal((await conflictResponse).status(),409);
      await stale.waitForFunction(()=>document.getElementById('editStatus').textContent.includes('未保存の編集'));
      assert.equal(await stale.locator('#previewCanvas').evaluate(node=>
        node.getContext('2d').getImageData(32,32,1,1).data[0]),255);
      await stale.locator('#cancelVisualEdit').click();
      assert.deepEqual(await readFile(portraitFile),committed);
      await stale.close();

      await page.goto(origin+'/game');
      await page.locator('#quickModel').selectOption(created.id);
      const gamePortrait='#quickZipPortrait';
      await page.locator(gamePortrait).waitFor();
      assert.deepEqual(await pixels(gamePortrait,0,0,64,64),secondPortrait);

      await page.locator('#quickConfirm').click();
      const practiced=page.waitForResponse(res=>res.url()===origin+'/api/quick-practice');
      await page.locator('#quickRun').click();
      const practice=await practiced;
      assert.equal(practice.status(),200,await practice.text());
      assert.equal((await practice.json()).daily_ai_signals.length,12);
      await page.locator('#quickMiniPortrait').waitFor();
      assert.deepEqual(await pixels('#quickMiniPortrait',0,0,64,64),secondPortrait);
      assert.deepEqual(writes,[
        '/api/imported-characters/register','/api/imported-characters/register',
        editPath,editPath,'/api/quick-practice',
      ]);
      assert.deepEqual(external,[]);
      assert.deepEqual(pageErrors,[]);
    } finally {
      await browser?.close();
      await new Promise(resolve=>server.close(resolve));
      await rm(root,{recursive:true,force:true});
    }
  });
