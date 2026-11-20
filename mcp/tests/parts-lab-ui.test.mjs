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
import {archive} from './zip-fixture.mjs';

test('Chrome previews ZIP accessory pixels and bakes them into the 12-day character portrait',
  {timeout:45_000},async t=>{
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
    const model={fast_window:3,slow_window:9,risk_fraction:.35,
      plugin_weights:{trend:100,momentum:0,volatility:0,reversion:0},
      plugin_strengths:{trend:100,momentum:100,volatility:100,reversion:100}};
    const server=createGameServer({
      importedCharacterStore:createImportedCharacterStore({root:importedRoot}),
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
      const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
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
        const atlas=frames=>({
          body:image(64*frames,64,ctx=>{
            for (let i=0;i<frames;i++) {
              ctx.fillStyle=i===0?'#15304b':'#305a72';
              ctx.fillRect(i*64,0,64,64);
            }
          }),
          ready:image(64*frames,64,ctx=>{
            ctx.fillStyle='#eeeeee';ctx.fillRect(14,3,4,4);
          }),
          happy:image(64*frames,64,ctx=>{
            ctx.fillStyle='#ffff00';ctx.fillRect(14,3,4,4);
          }),
        });
        return {one:atlas(1),six:atlas(6),
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
      assert.deepEqual(await pixel(32,32),bg);
      await upload(0,'overlay-one.png','red');
      await waitEnabled();
      assert.deepEqual(await pixel(32,32),red);
      await row(0).getByRole('button',{name:'重ね絵だけ外す'}).click();
      assert.deepEqual(await pixel(32,32),bg);
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
      await zipInput.setInputFiles(multiZip);
      await waitEnabled();
      await page.evaluate(()=>window.finishOverlay());
      await page.waitForFunction(()=>window.closedOverlays.includes('overlay-stale.png'));
      assert.deepEqual(await pixel(32,32),bg);
      assert.deepEqual(await page.evaluate(()=>[...window.closedOverlays].sort()),[
        'overlay-glasses.webp','overlay-one.png','overlay-rejected.png','overlay-stale.png','overlay-star.png',
      ]);

      await upload(0,'overlay-final.png','red');
      await waitEnabled();
      await row(0).locator('[data-overlay=x]').fill('100');
      await row(0).locator('[data-overlay=y]').fill('-100');
      await row(0).locator('[data-overlay=scale]').fill('200');
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

      await page.locator('#zipGameLink a').click();
      await page.locator('#quickModel').selectOption(created.id);
      const gamePortrait='#quickZipPortrait';
      await page.locator(gamePortrait).waitFor();
      assert.deepEqual(await pixels(gamePortrait,0,0,64,64),expectedPortrait);

      await page.locator('#quickConfirm').click();
      const practiced=page.waitForResponse(res=>res.url()===origin+'/api/quick-practice');
      await page.locator('#quickRun').click();
      const practice=await practiced;
      assert.equal(practice.status(),200,await practice.text());
      assert.equal((await practice.json()).daily_ai_signals.length,12);
      await page.locator('#quickMiniPortrait').waitFor();
      assert.deepEqual(await pixels('#quickMiniPortrait',0,0,64,64),expectedPortrait);
      assert.deepEqual(writes,[
        '/api/imported-characters/register','/api/imported-characters/register','/api/quick-practice',
      ]);
      assert.deepEqual(external,[]);
      assert.deepEqual(pageErrors,[]);
    } finally {
      await browser?.close();
      await new Promise(resolve=>server.close(resolve));
      await rm(root,{recursive:true,force:true});
    }
  });
