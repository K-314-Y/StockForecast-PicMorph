import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
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

test('Chrome registers, re-edits and duplicates ZIP characters used in the 12-day game and replay',
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
      const visualReads=[];
      const context=page.context();
      context.on('weberror',event=>pageErrors.push(event.error().message));
      context.on('request',request=>{
        const path=new URL(request.url()).pathname;
        if (request.method()!=='GET') writes.push(path);
        else if (path.startsWith('/api/imported-characters/visual-edit/')) visualReads.push(path);
      });
      await context.route('**/*',route=>{
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
          if (window.holdRestoredOverlay && source.type==='image/webp' && !source.name) {
            names.set(bitmap,'restored-webp');
            await new Promise(resolve=>{window.finishRestoredOverlay=resolve;});
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
        const atlas=(frames,width=64,height=width)=>({
          body:image(width*frames,height,ctx=>{
            for (let i=0;i<frames;i++) {
              ctx.fillStyle=i===0?'#15304b':'#305a72';
              ctx.fillRect(i*width,0,width,height);
            }
          }),
          ready:image(width*frames,height,ctx=>{
            ctx.fillStyle='#eeeeee';ctx.fillRect(14,3,4,4);
            for (let i=1;i<frames;i++) ctx.fillRect(i*width+21,9,4,4);
          }),
          happy:image(width*frames,height,ctx=>{
            ctx.fillStyle='#ffff00';ctx.fillRect(14,3,4,4);
          }),
        });
        const patch=color=>image(96,64,ctx=>{ctx.fillStyle=color;ctx.fillRect(14,3,4,4);});
        return {one:atlas(1,400),six:atlas(6),manual:{
          ...atlas(1,96,64),outfit:patch('#ff00ff'),hair:patch('#00ffff'),cautious:patch('#00ff00'),
        },
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
        hair_color:'#234567',clothing_color:'#c3916a',
        accessories:['star',{name:'手作り眼鏡',method:'rsi_oversold'},
          {name:'<b>手作り</b>',method:'macd_momentum'}]});
      const row=index=>page.locator('#zipEquipped li').nth(index);
      const adjustment=(index,key)=>row(index).locator('[data-overlay='+key+']');
      const position=async index=>Promise.all(['x','y'].map(async key=>
        Number(await adjustment(index,key).inputValue())));
      const preview=page.locator('#previewCanvas');
      const partPicker=page.locator('#movePart');
      const resetPosition=page.locator('#resetLayerPosition');
      const partPosition=async(prefix='layer')=>Promise.all(['X','Y'].map(async axis=>
        Number(await page.locator('#'+prefix+axis).inputValue())));
      const point=async (x,y)=>{
        const box=await preview.boundingBox();
        const [width,height]=await preview.evaluate(node=>[node.width,node.height]);
        const fit=Math.min(box.width/width,box.height/height);
        return [box.x+(box.width-width*fit)/2+x*fit,
          box.y+(box.height-height*fit)/2+y*fit];
      };
      const down=async(x,y)=>{
        await page.mouse.move(...await point(x,y));
        await page.mouse.down();
      };
      const dragging=()=>preview.getAttribute('data-overlay-dragging');
      const partDragging=()=>preview.getAttribute('data-layer-dragging');
      const movePart=async(from,to)=>{
        await down(...from);
        assert.equal(await partDragging(),'');
        await page.mouse.move(...await point(...to),{steps:3});
        await page.mouse.up();
        assert.equal(await partDragging(),null);
      };
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
      const gameLink=page.locator('#zipGameLink a');
      const compareLink=page.locator('#zipCompareLink a');
      const assertGameLinkCleared=async()=>{
        assert.equal(await gameLink.isVisible(),false);
        assert.equal(await gameLink.getAttribute('href'),null);
        assert.equal(await compareLink.isVisible(),false);
        assert.equal(await compareLink.getAttribute('href'),null);
      };
      const registerNow=async()=>{
        const response=saved();
        await register.click();
        const result=await response;
        assert.equal(result.status(),201,await result.text());
        const record=await result.json();
        await gameLink.waitFor();
        assert.equal(await gameLink.getAttribute('href'),'/game?model='+record.id);
        return record;
      };
      const cdp=await page.context().newCDPSession(page);
      const touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{
        type,touchPoints:x===undefined?[]:[{x,y}],
      });

      assert.equal(await partPicker.isDisabled(),true);
      await page.locator('#loadSample').click();
      await partPicker.locator('option[value=face]:enabled').waitFor({state:'attached'});
      assert.equal(await partPicker.inputValue(),'accessory');
      assert.equal(await partPicker.locator('option[value=hair]:disabled').count(),1);
      await partPicker.selectOption('face');
      await page.locator('#faceX').fill('10');
      await page.locator('#frames').selectOption('1');
      for (const [part,id] of Object.entries({
        body:'partBase',ready:'partReady',happy:'partHappy',cautious:'partCautious',
        outfit:'partOutfit',hair:'partHair',
      })) {
        await page.locator('#'+id).setInputFiles({
          name:part+'.png',mimeType:'image/png',buffer:Buffer.from(fixture.manual[part],'base64'),
        });
      }
      await page.locator('#loadOwn').click();
      await partPicker.locator('option[value=hair]:enabled').waitFor({state:'attached'});
      assert.equal(await partPicker.inputValue(),'accessory');
      assert.deepEqual(await partPosition('face'),[0,0]);
      await preview.evaluate(node=>{
        node.style.width='280px';
        node.style.height='230px';
      });

      // Face and outfit can both be grabbed through the hair drawn above them.
      await partPicker.selectOption('face');
      await preview.scrollIntoViewIfNeeded();
      const cyan=[0,255,255,255], magenta=[255,0,255,255], gray=[238,238,238,255];
      assert.deepEqual(await pixel(16,5),cyan);
      await movePart([16,5],[24,15]);
      assert.deepEqual(await partPosition('face'),[8,10]);
      assert.deepEqual(await pixel(16,5),cyan);
      assert.deepEqual(await pixel(24,15),gray);
      for (const [mood,color] of [['happy',[255,255,0,255]],['cautious',[0,255,0,255]]]) {
        await page.locator('#mood').selectOption(mood);
        assert.deepEqual(await pixel(24,15),color);
      }
      await page.locator('#mood').selectOption('ready');
      await page.locator('#faceY').fill('12');
      assert.deepEqual(await pixel(24,18),gray);
      await resetPosition.click();
      assert.deepEqual(await partPosition('face'),[0,0]);

      await partPicker.selectOption('outfit');
      await preview.scrollIntoViewIfNeeded();
      await movePart([16,5],[5,22]);
      assert.deepEqual(await partPosition(),[-11,17]);
      assert.deepEqual(await pixel(5,22),magenta);
      await partPicker.selectOption('hair');
      await preview.scrollIntoViewIfNeeded();
      for (const [x,y] of [[5,22],[40,40],[16,-4]]) {
        await down(x,y);
        assert.equal(await partDragging(),null);
        await page.mouse.move(...await point(26,13));
        await page.mouse.up();
        assert.deepEqual(await partPosition(),[0,0]);
      }
      await movePart([16,5],[26,13]);
      assert.deepEqual(await partPosition(),[10,8]);
      assert.deepEqual(await pixel(26,13),cyan);
      assert.deepEqual(await pixel(16,5),gray);
      await page.locator('#layerX').fill('999');
      await page.locator('#layerY').fill('-999');
      await page.locator('#layerY').blur();
      assert.deepEqual(await partPosition(),[32,-32]);
      assert.deepEqual(await pixel(26,13),bg);
      await partPicker.selectOption('outfit');
      assert.deepEqual(await partPosition(),[-11,17]);

      await partPicker.selectOption('base');
      await preview.scrollIntoViewIfNeeded();
      await page.emulateMedia({reducedMotion:'no-preference'});
      const [bodyX,bodyY]=await point(48,35);
      const scrollBefore=await page.evaluate(()=>window.scrollY);
      await touch('touchStart',bodyX,bodyY);
      assert.equal(await partDragging(),'');
      assert.deepEqual(await preview.evaluate(node=>{
        const style=getComputedStyle(node);
        return [style.cursor,style.touchAction,style.animationPlayState];
      }),['grabbing','none','paused']);
      const fit=(await preview.boundingBox()).width/96;
      await touch('touchMove',bodyX+44*fit,bodyY-12*fit);
      await page.waitForFunction(()=>document.getElementById('layerX').value==='32');
      assert.deepEqual(await partPosition(),[32,-12]);
      assert.deepEqual(await pixel(31,30),[0,0,0,0]);
      assert.deepEqual(await pixel(32,30),bg);
      await touch('touchCancel');
      assert.equal(await partDragging(),null);
      assert.deepEqual(await partPosition(),[32,-12]);
      assert.equal(await page.evaluate(()=>window.scrollY),scrollBefore);
      assert.equal(await preview.evaluate(node=>getComputedStyle(node).animationPlayState),'running');
      await page.emulateMedia({reducedMotion:'reduce'});
      await resetPosition.click();
      assert.deepEqual(await partPosition(),[0,0]);
      assert.deepEqual(await pixel(0,30),bg);
      await page.locator('#clear').click();
      assert.equal(await partPicker.isDisabled(),true);
      assert.equal(await partPicker.inputValue(),'accessory');
      assert.equal(await page.locator('#layerX').isDisabled(),true);
      await preview.evaluate(node=>{node.style.width='';node.style.height='';});

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
      const legacyFile=join(importedRoot,legacy.id+'.json');
      const legacyRecord=JSON.parse(await readFile(legacyFile,'utf8'));
      assert.equal(legacyRecord.visual.schema,1);
      delete legacyRecord.visual; // Simulate a character registered before drafts were saved.
      await writeFile(legacyFile,JSON.stringify(legacyRecord));
      const legacyPortrait=await page.request.get(origin+legacy.image_url);
      const legacyBytes=await legacyPortrait.body();

      await page.locator('#zipFrames').selectOption('6');
      await zipInput.setInputFiles(multiZip);
      await waitEnabled();
      await assertGameLinkCleared();
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
      await upload(2,'overlay-final-custom.png','red');
      await waitEnabled();
      await adjustment(2,'x').fill('-100');
      await adjustment(2,'y').fill('100');
      await partPicker.selectOption('face');
      await page.emulateMedia({reducedMotion:'no-preference'});
      await page.waitForFunction(()=>{
        if (!document.getElementById('frameInfo').textContent.startsWith('2 / 6')) return false;
        document.getElementById('pause').click();
        return true;
      });
      await preview.scrollIntoViewIfNeeded();
      await down(15,4);
      assert.equal(await partDragging(),null);
      await page.mouse.up();
      assert.deepEqual(await pixel(22,10),gray);
      await movePart([22,10],[30,14]);
      assert.deepEqual(await partPosition('face'),[8,4]);
      assert.deepEqual(await pixel(22,10),[48,90,114,255]);
      assert.deepEqual(await pixel(30,14),gray);
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.waitForFunction(()=>document.getElementById('frameInfo').textContent.startsWith('1 / 6'));
      await page.locator('#mood').selectOption('happy');
      await partPicker.selectOption('base');
      await movePart([39,38],[42,41]);
      assert.deepEqual(await partPosition(),[3,3]);
      const expectedPortrait=await pixels('#previewCanvas',0,0,64,64);
      assert.deepEqual(await pixel(52,12),red);
      assert.deepEqual(await pixel(32,32),green);
      assert.deepEqual(await pixel(15,4),bg);
      assert.deepEqual(await pixel(23,8),[255,255,0,255]);
      assert.deepEqual(await pixel(0,20),[0,0,0,0]);
      assert.deepEqual(await pixel(6,58),red);
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
          '#movePart','#layerX','#layerY','#resetLayerPosition','#faceX','#faceY',
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
      await gameLink.waitFor();
      assert.equal(await gameLink.getAttribute('href'),'/game?model='+created.id);
      assert.equal(await compareLink.isVisible(),false);
      assert.equal(await compareLink.getAttribute('href'),null);
      assert.equal(created.accessory_analysis.equipped.length,3);
      const stored=JSON.parse(await readFile(join(importedRoot,created.id+'.json'),'utf8'));
      assert.equal(stored.visual.mood,'happy');
      assert.deepEqual(stored.visual.offsets.body,{x:3,y:3});
      assert.deepEqual(stored.visual.offsets.face,{x:8,y:4});
      assert.deepEqual(stored.visual.overlays.map(item=>item.id),stored.equipped.map(item=>item.id));
      assert.deepEqual(stored.visual.overlays.map(item=>item.image.base64),
        [fixture.red,fixture.green,fixture.red]);
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
      const editPath='/api/imported-characters/visual-edit/'+created.id;
      const legacyPath='/api/imported-characters/visual-edit/'+legacy.id;
      const postResponse=path=>page.waitForResponse(response=>
        response.url()===origin+path && response.request().method()==='POST');
      const replacePortrait=()=>page.locator('#confirmPortraitSave').click();
      const restoreButton=page.locator('#restoreVisualEdit');
      const restoreDialog=page.locator('#confirmVisualRestore');
      const restore=async(path,message)=>{
        const response=postResponse(path+'/restore');
        await restoreButton.click();
        await page.locator('#confirmPortraitRestore').click();
        const result=await response;
        assert.equal(result.status(),200,await result.text());
        await page.waitForFunction(text=>document.getElementById('editStatus').textContent.includes(text),message);
        await waitEditReady();
      };
      await page.evaluate(()=>{window.holdRestoredOverlay=true;});
      await chooser.selectOption(created.id);
      await page.locator('#openVisualEdit').click();
      await page.waitForFunction(()=>window.finishRestoredOverlay);
      await assertGameLinkCleared();
      await page.locator('#clear').click();
      await assertGameLinkCleared();
      assert.match(await page.locator('#editStatus').textContent(),/中止/);
      await page.evaluate(()=>{
        window.holdRestoredOverlay=false;
        window.finishRestoredOverlay();
      });
      await page.waitForFunction(()=>window.closedOverlays.includes('restored-webp'));
      assert.equal(await page.locator('#visualEdit').isVisible(),false);
      assert.equal(await page.locator('#zipEquipped li').count(),0);
      await openEdit(legacy.id);
      assert.equal(await restoreButton.isVisible(),false);
      assert.equal(await restoreButton.isDisabled(),true);
      const legacyModel=await importedCharacterStore.model(legacy.id);
      assert.match(await page.locator('#legacyVisualWarning').textContent(),/復元できません/);
      assert.equal(await page.locator('#legacyVisualWarning').isVisible(),true);
      assert.match(await page.locator('#frameInfo').textContent(),/1 \/ 1.*400 × 400/);
      assert.equal(await page.locator('#zipEquipped li').count(),1);
      assert.equal(await partPicker.inputValue(),'accessory');
      assert.deepEqual(await partPosition('face'),[0,0]);
      assert.equal(await partPicker.locator('option[value=outfit]:disabled').count(),1);
      await partPicker.selectOption('base');
      assert.equal(await page.locator('#layerX').getAttribute('max'),'128');
      await page.locator('#layerX').fill('14');
      assert.deepEqual(await pixel(0,200),[0,0,0,0]);
      await partPicker.selectOption('accessory');
      await upload(0,'overlay-legacy-edit.png','largeRed');
      await waitEditReady();
      assert.deepEqual(await pixel(200,200),red);
      await saveEdit();
      await page.locator('#confirmVisualEdit').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('#confirmVisualEdit').waitFor({state:'hidden'});
      assert.equal(writes.length,2);
      const legacySave=postResponse(legacyPath);
      await saveEdit();
      await replacePortrait();
      assert.equal((await legacySave).status(),200);
      await waitEditReady();
      assert.equal(await page.locator('#legacyVisualWarning').isVisible(),false);
      await restore(legacyPath,'1つ前の保存画像に戻しました');
      assert.equal(await page.locator('#legacyVisualWarning').isVisible(),true);
      await partPicker.selectOption('base');
      assert.deepEqual(await partPosition(),[0,0]);
      assert.equal(await row(0).locator('input[type=file]').inputValue(),'');
      assert.deepEqual((await importedCharacterStore.image(legacy.id)).bytes,legacyBytes);
      assert.deepEqual(await importedCharacterStore.model(legacy.id),legacyModel);
      await closeEdit();
      await openEdit(legacy.id);
      assert.equal(await page.locator('#legacyVisualWarning').isVisible(),true);
      await closeEdit();
      assert.equal(await partPicker.isDisabled(),true);
      assert.deepEqual(await partPosition(),[0,0]);
      assert.deepEqual((await importedCharacterStore.image(legacy.id)).bytes,legacyBytes);
      assert.equal(writes.length,4);

      const getModel=()=>importedCharacterStore.model(created.id);
      const originalModel=await getModel();
      const predictSameScenario=async(id=created.id)=>{
        const response=await page.request.post(origin+'/api/quick-practice',{
          data:{model_id:id,amount:1000,scenario_token:'v1_0000000000000001'},
        });
        assert.equal(response.status(),200,await response.text());
        return response.json();
      };
      const baseline=await predictSameScenario();
      const portraitResponse=()=>postResponse(editPath);
      await openEdit(created.id);
      assert.equal(await restoreButton.isVisible(),false);
      assert.match(await page.locator('#frameInfo').textContent(),/1 \/ 6.*64 × 64/);
      assert.match(await page.locator('#editModel').textContent(),new RegExp(created.model_version));
      assert.match(await page.locator('#editTraits').textContent(),/慎重/);
      assert.equal(await page.locator('#legacyVisualWarning').isVisible(),false);
      assert.equal(await page.locator('#zipAccessory').isVisible(),false);
      assert.equal(await row(0).locator('[data-action=unequip]').isVisible(),false);
      assert.equal(await page.locator('#registerZip').isVisible(),false);
      for (const selector of ['#frames','#faceX','#faceY','#zipHairColor','#zipExpression'])
        assert.equal(await page.locator(selector).isDisabled(),true,selector);
      assert.equal(await page.locator('#mood').inputValue(),'happy');
      assert.equal(await page.locator('#mood').isEnabled(),true);
      assert.equal(await page.locator('#mood option[value=cautious]').evaluate(option=>option.disabled),true);
      assert.deepEqual(await pixels('#editSavedPortrait',0,0,64,64),expectedPortrait);
      assert.deepEqual(await pixels('#previewCanvas',0,0,64,64),expectedPortrait);
      assert.deepEqual(await position(0),[100,-100]);
      assert.deepEqual(await position(1),[0,0]);
      assert.deepEqual(await position(2),[-100,100]);
      await partPicker.selectOption('base');
      assert.deepEqual(await partPosition(),[3,3]);
      await partPicker.selectOption('face');
      assert.deepEqual(await partPosition(),[8,4]);
      await page.locator('#mood').selectOption('ready');
      await page.locator('#layerX').fill('-6');
      await page.locator('#layerY').fill('6');
      assert.deepEqual(await partPosition('face'),[-6,6]);
      assert.deepEqual(await pixel(9,10),gray);
      await partPicker.selectOption('accessory');
      await saveEdit();
      assert.match(await page.locator('#confirmOverlayCount').textContent(),/3 \/ 3/);
      await page.locator('#abortPortraitSave').click();
      assert.equal(writes.length,4);
      await preview.scrollIntoViewIfNeeded();
      await down(6,58);
      await page.mouse.move(...await point(50,22),{steps:4});
      await page.mouse.up();
      assert.notDeepEqual(await position(2),[0,0]);
      await adjustment(2,'scale').fill('150');
      const editedPortrait=await pixels('#previewCanvas',0,0,64,64);
      assert.deepEqual(await pixel(50,22),red);
      assert.deepEqual(await pixel(32,32),green);
      assert.deepEqual(await pixel(15,4),bg);
      assert.deepEqual(await pixel(9,10),gray);
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
      const {previous_visual,...editedRecord}=JSON.parse(await readFile(portraitFile,'utf8'));
      assert.deepEqual(previous_visual,{portrait:stored.images.portrait,visual:stored.visual});
      assert.deepEqual({...editedRecord,visual:stored.visual,
        images:{...editedRecord.images,portrait:stored.images.portrait}},stored);
      assert.equal(editedRecord.visual.mood,'ready');
      assert.deepEqual(editedRecord.visual.offsets.face,{x:-6,y:6});
      assert.equal(editedRecord.visual.overlays[2].scale,150);
      assert.deepEqual(editedRecord.visual.overlays.map(item=>item.image),
        stored.visual.overlays.map(item=>item.image));
      await closeEdit();
      await openEdit(created.id);
      assert.deepEqual(await pixels('#previewCanvas',0,0,64,64),editedPortrait);
      assert.deepEqual(await getModel(),originalModel);
      await restoreButton.click();
      await restoreDialog.waitFor();
      assert.equal(await page.locator('#abortPortraitRestore').evaluate(node=>node===document.activeElement),true);
      await page.locator('#abortPortraitRestore').click();
      await restoreDialog.waitFor({state:'hidden'});
      await restoreButton.click();
      await page.keyboard.press('Escape');
      await restoreDialog.waitFor({state:'hidden'});
      assert.equal(writes.length,5);
      assert.deepEqual(await pixels('#previewCanvas',0,0,64,64),editedPortrait);
      await restore(editPath,'1つ前の見た目に戻しました');
      assert.deepEqual(await pixels('#editSavedPortrait',0,0,64,64),expectedPortrait);
      assert.deepEqual(await pixels('#previewCanvas',0,0,64,64),expectedPortrait);
      await closeEdit();
      await openEdit(created.id);
      assert.deepEqual(await pixels('#previewCanvas',0,0,64,64),expectedPortrait);
      assert.equal(await page.locator('#mood').inputValue(),'happy');
      assert.deepEqual(await partPosition('face'),[8,4]);
      assert.deepEqual(await position(0),[100,-100]);
      assert.deepEqual(await position(1),[0,0]);
      assert.deepEqual(await position(2),[-100,100]);
      assert.equal(await row(0).locator('[data-action=unequip]').isVisible(),false);
      assert.deepEqual(await getModel(),originalModel);
      const after=await predictSameScenario();
      assert.deepEqual(after.daily_ai_signals,baseline.daily_ai_signals);
      assert.deepEqual(after.daily_synthetic_prices,baseline.daily_synthetic_prices);
      assert.equal(after.model_effective_sha256,baseline.model_effective_sha256);
      assert.equal(after.engine_source_sha256,baseline.engine_source_sha256);
      assert.deepEqual(after.daily_balances,baseline.daily_balances);
      await restore(editPath,'1つ前の見た目に戻しました');
      assert.deepEqual(await pixels('#previewCanvas',0,0,64,64),editedPortrait);

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
      await stale.locator('#zipEquipped li').nth(0).locator('[data-overlay=x]').fill('0');
      await stale.locator('#zipEquipped li').nth(0).locator('[data-overlay=y]').fill('0');
      const stalePixels=()=>stale.locator('#previewCanvas').evaluate(node=>
        Array.from(node.getContext('2d').getImageData(0,0,64,64).data));
      const staleDraft=await stalePixels();
      assert.notDeepEqual(staleDraft,secondPortrait);
      const conflictResponse=stale.waitForResponse(res=>res.url()===origin+editPath && res.request().method()==='POST');
      await stale.locator('#saveVisualEdit').click();
      await stale.locator('#confirmPortraitSave').click();
      assert.equal((await conflictResponse).status(),409);
      await stale.waitForFunction(()=>document.getElementById('editStatus').textContent.includes('未保存の編集'));
      assert.deepEqual(await stalePixels(),staleDraft);
      const conflictRestore=stale.waitForResponse(res=>res.url()===origin+editPath+'/restore' &&
        res.request().method()==='POST');
      await stale.locator('#restoreVisualEdit').click();
      await stale.locator('#confirmPortraitRestore').click();
      assert.equal((await conflictRestore).status(),409);
      await stale.waitForFunction(()=>document.getElementById('editStatus').textContent.includes('未保存の編集'));
      assert.deepEqual(await stalePixels(),staleDraft);
      await stale.locator('#cancelVisualEdit').click();
      assert.deepEqual(await readFile(portraitFile),committed);
      await stale.close();

      await page.goto(origin+'/game');
      const editLink=page.locator('#quickZipEditLink');
      assert.equal(await editLink.isVisible(),false);
      await page.locator('#quickModel').selectOption(created.id);
      const gamePortrait='#quickZipPortrait';
      await page.locator(gamePortrait).waitFor();
      assert.deepEqual(await pixels(gamePortrait,0,0,64,64),secondPortrait);

      await page.locator('#quickAmount').fill('2750');
      await page.locator('#quickLeverage').selectOption('3');
      await page.locator('#quickConfirm').click();
      const practiced=page.waitForResponse(res=>res.url()===origin+'/api/quick-practice');
      await page.locator('#quickRun').click();
      const practice=await practiced;
      assert.equal(practice.status(),200,await practice.text());
      const beforeEdit=await practice.json();
      assert.equal(beforeEdit.daily_ai_signals.length,12);
      await page.locator('#quickMiniPortrait').waitFor();
      assert.deepEqual(await pixels('#quickMiniPortrait',0,0,64,64),secondPortrait);
      await page.locator('#quickFollowing').click();
      const replayDay=await page.locator('#quickReplayDay').textContent();
      const gameImage=page.locator(gamePortrait);
      const beforeSrc=await gameImage.getAttribute('src');
      const getState=async path=>{
        const response=await page.request.get(origin+path);
        assert.equal(response.status(),200,path);
        return response.json();
      };
      const readTrainingState=()=>Promise.all(['/api/growth','/api/trained/versions'].map(getState));
      const trainingBefore=await readTrainingState();

      assert.equal(await editLink.textContent(),'このキャラの見た目を編集');
      assert.equal(await editLink.getAttribute('target'),'_blank');
      assert.equal(await editLink.getAttribute('rel'),'noopener noreferrer');
      const editorUrl=origin+'/parts-lab/preview.html?edit='+created.id;
      assert.equal(await editLink.getAttribute('href'),editorUrl);
      const writesBeforeOpen=writes.length;
      const readsBeforeOpen=visualReads.length;
      const [editor]=await Promise.all([context.waitForEvent('page'),editLink.click()]);
      editor.setDefaultTimeout(5000);
      assert.equal(editor.url(),editorUrl);
      await editor.locator('#visualEdit').waitFor();
      await editor.waitForFunction(()=>!document.getElementById('saveVisualEdit').disabled);
      assert.equal(await editor.evaluate(()=>window.opener),null);
      assert.equal(await editor.locator('#editCharacter').inputValue(),created.id);
      assert.deepEqual(visualReads.slice(readsBeforeOpen),[editPath]);
      assert.equal(writes.length,writesBeforeOpen);
      assert.deepEqual(await readFile(portraitFile),committed);

      const moveLinkedLayer=async(part,prior,next)=>{
        await editor.locator('#movePart').selectOption(part);
        const input=editor.locator('#layerX');
        assert.equal(await input.inputValue(),prior);
        await input.fill(next);
      };
      await moveLinkedLayer('face','-6','-11');
      await moveLinkedLayer('base','3','9');
      await editor.locator('#saveVisualEdit').click();
      assert.equal(writes.length,writesBeforeOpen);
      const [linkedSave]=await Promise.all([
        editor.waitForResponse(res=>res.url()===origin+editPath && res.request().method()==='POST'),
        editor.locator('#confirmPortraitSave').click(),
      ]);
      assert.equal(linkedSave.status(),200,await linkedSave.text());
      const latest=await linkedSave.json();
      assert.equal(latest.id,created.id);
      assert.notEqual(latest.image_sha256,new URL(beforeSrc,origin).searchParams.get('v'));
      const expectedSrc=new URL(beforeSrc,origin);
      expectedSrc.searchParams.set('v',latest.image_sha256);
      const refreshed=page.waitForResponse(res=>res.url()===origin+'/api/model-shop');
      await page.bringToFront();
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      assert.equal((await refreshed).status(),200);
      await page.waitForFunction(src=>document.getElementById('quickZipPortrait').src===src,expectedSrc.href);
      assert.notDeepEqual(await pixels(gamePortrait,0,0,64,64),secondPortrait);
      assert.equal(await page.locator('#quickModel').inputValue(),created.id);
      assert.equal(await page.locator('#quickAmount').inputValue(),'2750');
      assert.equal(await page.locator('#quickLeverage').inputValue(),'3');
      assert.equal(await page.locator('#quickReplay').isVisible(),true);
      assert.equal(await page.locator('#quickReplayDay').textContent(),replayDay);
      assert.deepEqual(await readTrainingState(),trainingBefore);
      assert.deepEqual(await getModel(),originalModel);
      const afterLinkedSave=await predictSameScenario();
      for (const key of ['model_id','model_effective_sha256','engine_source_sha256'])
        assert.equal(afterLinkedSave[key],beforeEdit[key],key);
      assert.deepEqual(afterLinkedSave.daily_ai_signals,baseline.daily_ai_signals);
      assert.deepEqual(afterLinkedSave.daily_balances,baseline.daily_balances);

      const readsBeforeInvalid=visualReads.length;
      const unknown='zip_'+(created.id.endsWith('0')?'1':'0').repeat(32);
      const previewUrl=origin+'/parts-lab/preview.html';
      for (const query of [
        'edit=../'+created.id,'edit='+created.id+'%0A','edit='+created.id+'&edit='+legacy.id,
        'edit='+unknown,
      ]) {
        await editor.goto(previewUrl+'?'+query);
        await editor.locator('#editCharacter:enabled').waitFor();
        assert.equal(await editor.locator('#editCharacter').inputValue(),'');
        assert.equal(await editor.locator('#visualEdit').isVisible(),false);
        assert.equal(await editor.locator('#openVisualEdit').isDisabled(),true);
      }
      assert.match(await editor.locator('#editStatus').textContent(),/リンク先のZIPキャラが見つかりません/);
      assert.deepEqual(visualReads.slice(readsBeforeInvalid),[]);
      await editor.locator('#editCharacter').selectOption(legacy.id);
      await editor.locator('#openVisualEdit').click();
      await editor.locator('#legacyVisualWarning').waitFor();
      await editor.goto(previewUrl+'?edit='+legacy.id);
      await editor.locator('#legacyVisualWarning').waitFor();
      assert.equal(await editor.locator('#editCharacter').inputValue(),legacy.id);
      assert.deepEqual(visualReads.slice(readsBeforeInvalid),[legacyPath,legacyPath]);

      // A slow initial list cannot replace a newer local draft.
      let holdList;
      const heldList=new Promise(resolve=>{holdList=resolve;});
      await editor.route(origin+'/api/imported-characters',holdList,{times:1});
      await editor.goto(editorUrl);
      const listRoute=await heldList;
      await editor.locator('#loadSample').click();
      await editor.locator('#movePart').selectOption('face');
      await editor.locator('#faceX').fill('10');
      await listRoute.continue();
      await editor.locator('#editCharacter:enabled').waitFor();
      assert.equal(await editor.locator('#editCharacter').inputValue(),created.id);
      assert.equal(await editor.locator('#visualEdit').isVisible(),false);
      assert.equal(await editor.locator('#faceX').inputValue(),'10');
      assert.deepEqual(visualReads.slice(readsBeforeInvalid),[legacyPath,legacyPath]);
      await editor.close();

      assert.deepEqual(writes,[
        '/api/imported-characters/register','/api/imported-characters/register',
        legacyPath,legacyPath+'/restore',editPath,editPath+'/restore',editPath+'/restore',
        editPath,'/api/quick-practice',editPath,
      ]);

      const originalPortrait=await pixels(gamePortrait,0,0,64,64);
      const originalBytes=await readFile(portraitFile);
      const original=JSON.parse(originalBytes);
      const legacyImages=Object.fromEntries(Object.entries(legacyRecord.images).map(
        ([part,{mime,base64}])=>[part,{mime,base64}]));
      const singleton=await importedCharacterStore.register({name:'🐱'.repeat(16),
        look:{...legacy.appearance.look,accessory:'none'},colors:legacy.appearance.colors,
        accessories:['star'],images:legacyImages});
      const manual=await importedCharacterStore.register({name:'外見情報なし',
        approach:'trend',risk_percent:35,images:legacyImages});
      const alternate=await importedCharacterStore.addAccessory({name:'移動平均のお守り',method:'moving_average_trend'});
      const singletonFile=join(importedRoot,singleton.id+'.json');
      const singletonBytes=await readFile(singletonFile);
      const duplicate=page.locator('#duplicateCharacter');
      const notice=page.locator('#duplicateNotice');
      const confirmDraft=async id=>{
        await chooser.selectOption(id);
        await duplicate.click();
        await notice.waitFor();
        await assertGameLinkCleared();
      };
      const clearDraft=()=>page.locator('#clear').click();
      const writesBeforeDuplicate=writes.length;
      await page.goto(previewUrl);
      await chooser.locator('option[value="'+created.id+'"]').waitFor({state:'attached'});
      assert.equal(await duplicate.isDisabled(),true);
      await confirmDraft(manual.id);
      assert.match(await notice.textContent(),/以前の見た目を再現できない/);
      assert.equal(await page.locator('#zipHairStyle').inputValue(),'');
      assert.equal(await page.locator('#zipExpression').inputValue(),'');
      assert.equal(await register.isDisabled(),true);
      await page.locator('#zipHairStyle').selectOption('long');
      await page.locator('#zipExpression').selectOption('calm');
      await waitEnabled();
      await clearDraft();
      assert.equal(await notice.isVisible(),false);
      await confirmDraft(legacy.id);
      await waitEnabled();
      assert.match(await row(0).textContent(),/星（ボリンジャーバンド）/);
      assert.equal(await page.locator('#frames').inputValue(),'1');
      await clearDraft();

      await confirmDraft(singleton.id);
      assert.equal(await page.locator('#zipName').inputValue(),'🐱'.repeat(14)+'別版');
      assert.equal(writes.length,writesBeforeDuplicate);
      const same=await registerNow();
      assert.notEqual(same.id,singleton.id);
      assert.deepEqual(same.accessory_analysis,singleton.accessory_analysis);
      assert.equal(same.model_version,singleton.model_version);
      assert.deepEqual(same.model,singleton.model);
      const [samePlan,singletonPlan]=await Promise.all([
        predictSameScenario(same.id),predictSameScenario(singleton.id),
      ]);
      for(const key of ['model_effective_sha256','daily_ai_signals','daily_balances'])
        assert.deepEqual(samePlan[key],singletonPlan[key],key);
      assert.deepEqual(await readFile(singletonFile),singletonBytes);

      await page.route(origin+editPath,route=>route.fulfill({status:503,json:{error:'読み込めません'}}),{times:1});
      await chooser.selectOption(created.id);
      await duplicate.click();
      await page.getByText('複製の下書きを開けませんでした。元のキャラは変更されていません。').waitFor();
      await assertGameLinkCleared();
      assert.equal(await notice.isVisible(),false);
      assert.equal(await register.isDisabled(),true);
      await page.evaluate(()=>{window.holdRestoredOverlay=true;});
      await duplicate.click();
      await page.waitForFunction(()=>window.finishRestoredOverlay);
      await clearDraft();
      await page.evaluate(()=>{
        window.holdRestoredOverlay=false;
        window.finishRestoredOverlay();
      });
      await page.waitForFunction(()=>window.closedOverlays.includes('restored-webp'));
      assert.match(await page.locator('#editStatus').textContent(),/中止/);
      assert.equal(await notice.isVisible(),false);
      assert.equal(await register.isDisabled(),true);
      assert.equal(await row(0).count(),0);
      assert.equal(writes.length,writesBeforeDuplicate+1);

      await confirmDraft(created.id);
      await waitEnabled();
      assert.match(await notice.textContent(),/元のキャラは変更されません/);
      assert.equal(await page.locator('#visualEdit').isVisible(),false);
      assert.equal(await page.locator('#zipAccessoryCreator').isVisible(),false);
      assert.equal(await page.locator('#zipName').inputValue(),created.name+'別版');
      for(const [id,value] of Object.entries({zipHairStyle:created.appearance.look.hair_style,
        zipExpression:created.appearance.look.expression,zipHairColor:created.appearance.colors.hair_color,
        zipClothingColor:created.appearance.colors.clothing_color,mood:original.visual.mood,frames:'6'}))
        assert.equal(await page.locator('#'+id).inputValue(),value,id);
      assert.deepEqual(await pixels('#previewCanvas',0,0,64,64),originalPortrait);
      for(const [index,overlay] of original.visual.overlays.entries()) {
        assert.deepEqual(await position(index),[overlay.x,overlay.y]);
        assert.equal(Number(await adjustment(index,'scale').inputValue()),overlay.scale);
      }
      await row(0).getByRole('button',{name:'分析装備を外す'}).click();
      await page.locator('#zipAccessory').selectOption(alternate.id);
      await page.locator('#zipEquip').click();
      await adjustment(0,'x').fill('25');
      await page.locator('#zipName').fill('分析を変えた相棒');
      assert.equal(writes.length,writesBeforeDuplicate+1);
      const copied=await registerNow();
      assert.notEqual(copied.id,created.id);
      assert.equal(copied.ai_id,copied.id);
      assert.equal(copied.name,'分析を変えた相棒');
      assert.deepEqual(copied.accessory_analysis.equipped,[...original.equipped.slice(1),alternate]);
      const copiedRecord=JSON.parse(await readFile(join(importedRoot,copied.id+'.json')));
      const [,firstOverlay,secondOverlay]=original.visual.overlays;
      assert.deepEqual(copiedRecord.visual,{...original.visual,overlays:[{...firstOverlay,x:25},secondOverlay]});
      for(const part of ['body','ready','happy'])assert.deepEqual(copiedRecord.images[part],original.images[part]);
      const copiedPlan=await predictSameScenario(copied.id);
      assert.equal(copiedPlan.model_id,copied.id);
      assert.deepEqual(copiedPlan.daily_synthetic_prices,baseline.daily_synthetic_prices);
      assert.notEqual(copiedPlan.model_effective_sha256,baseline.model_effective_sha256);
      assert.notDeepEqual(copiedPlan.daily_ai_signals,baseline.daily_ai_signals);
      await compareLink.waitFor();
      assert.equal(await compareLink.getAttribute('href'),'/game?model='+copied.id+'&compare='+created.id);
      const beforeLinkWrites=writes.length;
      await compareLink.click();
      await page.waitForFunction(id=>document.getElementById('quickModel')?.value===id,copied.id);
      assert.equal(new URL(page.url()).searchParams.get('model'),copied.id);
      assert.equal(new URL(page.url()).searchParams.get('compare'),created.id);
      await page.locator('#quickLinkedCompareHint').waitFor();
      assert.match(await page.locator('#quickLinkedCompareHint').textContent(),/比較相手/);
      assert.equal(writes.length,beforeLinkWrites);
      assert.equal(await page.locator('#quickZipPortrait').isVisible(),true);
      assert.equal(await page.locator('#quickReplay').isVisible(),false);
      await page.locator('#quickAmount').fill('2750');
      await page.locator('#quickLeverage').selectOption('3');
      await page.locator('#quickConfirm').click();
      const firstReply=postResponse('/api/quick-practice');
      await page.locator('#quickRun').click();
      const first=await firstReply;
      assert.equal(first.status(),200,await first.text());
      const firstResult=await first.json();
      await page.locator('#quickCompare').waitFor();
      assert.equal(await page.locator('#quickCompareModel').inputValue(),created.id);
      assert.equal(await page.locator('#quickCompareRun').isEnabled(),true);
      assert.equal(writes.length,beforeLinkWrites+1);
      const secondReply=postResponse('/api/quick-practice');
      await page.locator('#quickCompareRun').click();
      const second=await secondReply;
      assert.equal(second.status(),200,await second.text());
      const secondResult=await second.json();
      assert.equal(firstResult.model_id,copied.id);
      assert.equal(secondResult.model_id,created.id);
      assert.deepEqual(second.request().postDataJSON(),{model_id:created.id,amount:2750,leverage:3,scenario_token:firstResult.scenario_token});
      assert.deepEqual(secondResult.daily_synthetic_prices,firstResult.daily_synthetic_prices);
      await page.locator('#quickCompareDecisionDiff').waitFor();
      assert.equal(await page.locator('#quickCompareDecisionRows tr').count(),12);
      assert.equal(firstResult.mine_decision_trace.length,12);
      assert.equal(secondResult.mine_decision_trace.length,12);
      const details=page.locator('#quickCompareTrace');
      assert.equal(await details.evaluate(node=>node.open),false);
      await details.locator('summary').click();
      const days=page.locator('#quickCompareTraceDays > div');
      const different=firstResult.daily_ai_signals.flatMap((signal,i)=>signal!==secondResult.daily_ai_signals[i]?[i]:[]);
      assert.equal(await days.count(),different.length);
      const names={bollinger_breakout:'ボリンジャーバンド',rsi_oversold:'RSI',macd_momentum:'MACD',moving_average_trend:'移動平均'};
      for (const [i,day] of different.entries()) {
        const entry=days.nth(i);
        assert.equal(await entry.locator('strong').textContent(),'第'+(day+1)+'日');
        for (const [side,result] of [firstResult,secondResult].entries()) {
          const row=result.mine_decision_trace[day];
          const text=await entry.locator('div').nth(side).textContent();
          assert.equal(text[0],side===0?'A':'B');
          for (const [key,value] of Object.entries(row.method_supports))
            assert.ok(text.includes(names[key]+' '+value.toFixed(3)));
          assert.ok(text.includes('基礎モデルUP '+row.baseline_up.toFixed(3)));
          const rounded=row.combined_support.toFixed(3);
          assert.ok(text.includes('合成 '+(Number(rounded)===row.threshold?row.combined_support:rounded)));
          assert.ok(text.includes((row.signal==='LONG'?'＞':'≦')+' 基準 0.54'));
        }
      }
      assert.deepEqual(await readFile(portraitFile),originalBytes);
      assert.deepEqual(await getModel(),originalModel);
      assert.deepEqual(writes.slice(writesBeforeDuplicate),[
        '/api/imported-characters/register','/api/imported-characters/register',
        '/api/quick-practice','/api/quick-practice',
      ]);
      assert.deepEqual(external,[]);
      assert.deepEqual(pageErrors,[]);
    } finally {
      await browser?.close();
      await new Promise(resolve=>server.close(resolve));
      await rm(root,{recursive:true,force:true});
    }
  });
