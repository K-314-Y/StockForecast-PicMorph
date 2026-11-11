import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rectangleFromCorners,validatedCropRectangle,imagePointFromPointer,
  MAX_CROP_BYTES,MAX_CROP_PIXELS} from '../../game_runtime/crop-editor.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

test('dragging in any direction clamps to source image without shifting the selection',()=>{
 assert.deepEqual(rectangleFromCorners(90,70,10,20,100,80),
   {x:10,y:20,width:80,height:50});
 assert.deepEqual(rectangleFromCorners(-50,-30,200,200,100,80),
   {x:0,y:0,width:100,height:80});
 assert.deepEqual(rectangleFromCorners(2.3,3.6,4.5,6.2,100,100),
   {x:2,y:4,width:3,height:2});
 assert.throws(()=>rectangleFromCorners(NaN,4,6,8,100,100),/不正/);
 assert.throws(()=>rectangleFromCorners(2,4,6,8,0,100),/不正/);
});

test('coordinate transformation supports CSS scaling, zoom and rectangular images',()=>{
 const bounds={left:17,top:25,width:200,height:100};
 assert.deepEqual(imagePointFromPointer(17,25,bounds,1000,500),{x:0,y:0});
 assert.deepEqual(imagePointFromPointer(117,75,bounds,1000,500),{x:500,y:250});
 assert.deepEqual(imagePointFromPointer(317,225,bounds,1000,500),{x:1000,y:500});
 assert.deepEqual(imagePointFromPointer(-30,-30,bounds,1000,500),{x:0,y:0});
 assert.throws(()=>imagePointFromPointer(10,10,{...bounds,width:0},100,100),/表示されていません/);
});

test('invalid empty, outside and fractional crop rectangles cannot be exported',()=>{
 assert.deepEqual(validatedCropRectangle({x:12,y:8,width:23,height:11},100,60),
   {x:12,y:8,width:23,height:11});
 for (const r of [
   {x:0,y:0,width:0,height:10},{x:0,y:0,width:10,height:0},
   {x:-1,y:0,width:10,height:10},{x:95,y:0,width:10,height:10},
   {x:0,y:58,width:2,height:3},{x:.5,y:0,width:2,height:2},
   {x:0,y:0,width:Infinity,height:2}
 ]) assert.throws(()=>validatedCropRectangle(r,100,60),/外/);
 assert.equal(MAX_CROP_BYTES,450*1024);
 assert.equal(MAX_CROP_PIXELS,4*1024*1024);
});

test('game serves editor as own module without expanding any model or XP mutation APIs',async t=>{
 const game=createGameServer();
 await new Promise(ok=>game.listen(0,'127.0.0.1',ok));
 t.after(()=>new Promise(ok=>game.close(ok)));
 const root='http://127.0.0.1:'+game.address().port;
 const [htmlResponse,jsResponse]=await Promise.all([
   fetch(root+'/game'),fetch(root+'/crop-editor.mjs'),
 ]);
 assert.equal(htmlResponse.status,200);
 assert.equal(jsResponse.status,200);
 assert.match(jsResponse.headers.get('content-type'),/javascript/);
 const html=await htmlResponse.text();
 assert.match(html,/src="\/crop-editor\.mjs"/);
 assert.match(html,/id="cropCanvas"/);
 assert.match(html,/id="cropTarget"/);
 assert.match(html,/id="cropCreate"/);
 assert.match(html,/role="status"/);
 for (const id of ['cropX','cropY','cropWidth','cropHeight']){
   assert.match(html,new RegExp('for="'+id+'"'));
 }
 const editor=await jsResponse.text();
 assert.match(editor,/toBlob/);
 assert.match(editor,/image\/png/);
 assert.match(editor,/DataTransfer/);
 assert.match(editor,/pointerdown/);
 assert.match(editor,/getBoundingClientRect/);
 assert.doesNotMatch(editor,/innerHTML|eval\(/);
 const before=await fetch(root+'/api/artwork').then(r=>r.json());
 assert.equal(before.created,false);
 assert.equal(before.revision,0);
});
