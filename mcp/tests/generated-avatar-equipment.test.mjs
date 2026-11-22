import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {composeAvatarAtlas,loadAvatarEquipment} from '../../game_runtime/generated-avatar.mjs';

const id='cp_'+'a'.repeat(32);
const metadataPath='/api/character-equipment/v1/'+id;
const originals=new Map(['body','ready','happy','cautious'].map(name=>[name,new Blob([name],{type:'image/png'})]));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

function png(tag=1) {
  // The browser tests use a real PNG decoder. This fixture isolates the header
  // and digest checks from the injected bitmap decoder.
  const bytes=Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47,0);bytes.writeUInt32BE(0x0d0a1a0a,4);
  bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);
  bytes.writeUInt32BE(1152,16);bytes.writeUInt32BE(208,20);
  bytes[24]=8;bytes[25]=6;bytes[32]=tag;
  return bytes;
}

const accessory=(tag=1,extra={})=>({part_id:'pt_'+tag.toString(16).padStart(32,'0'),
  image_sha256:sha(png(tag)),layer_anchor:'base',x:0,y:0,visible:true,...extra});

function response(bytes,mime,headers={}) {
  return new Response(bytes,{headers:{'Content-Type':mime,'Content-Length':String(bytes.length),...headers}});
}

function contextStub() {
  const events=[];
  return {events,
    clearRect(...args){events.push(['clear',...args]);},save(){events.push(['save']);},
    beginPath(){events.push(['begin']);},rect(...args){events.push(['rect',...args]);},
    clip(){events.push(['clip']);},drawImage(...args){events.push(['draw',...args]);},
    restore(){events.push(['restore']);},
  };
}

function harness(t,entries,{images=new Map(),metadata={},opaque=false}={}) {
  const calls=[],bitmaps=[],canvases=[];
  const mock={
    fetch:async(path,options)=>{
      calls.push({path,options});
      if(path===metadataPath) {
        return response(Buffer.from(JSON.stringify({schema:1,character_id:id,revision:1,parts:entries,...metadata})),
          'application/json; charset=utf-8');
      }
      const entry=entries.find(part=>path==='/api/independent-parts/'+part.part_id+'/part.png');
      if(!entry)throw Error('Unexpected image request');
      return images.get(path)?.()??response(png(Number.parseInt(entry.part_id.slice(3),16)),'image/png',
        {'x-creature-part-sha256':entry.image_sha256});
    },
    createImageBitmap:async blob=>{
      let name='overlay';
      for(const [role,source] of originals)if(source===blob)name=role;
      const bitmap={name,width:1152,height:208,closed:0,close(){this.closed++;}};
      bitmaps.push(bitmap);
      return bitmap;
    },
    document:{createElement(name){
      assert.equal(name,'canvas');
      const ctx=contextStub();
      ctx.getImageData=()=>({data:[0,0,0,opaque?255:0,255,0,0,255]});
      const canvas={ctx,getContext:()=>ctx,toBlob(done,mime){done(new Blob(['composite'],{type:mime}));}};
      canvases.push(canvas);
      return canvas;
    }},
  };
  for(const [key,value] of Object.entries(mock)) {
    const previous=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else delete globalThis[key];});
  }
  return {calls,bitmaps,canvases};
}

test('each of six frames is clipped and uses the saved order within its anchor',()=>{
  const ctx=contextStub();
  composeAvatarAtlas(ctx,'body','happy',[
    {bitmap:'hair',visible:true,layer_anchor:'hair',x:12,y:-3},
    {bitmap:'base1',visible:true,layer_anchor:'base',x:-24,y:24},
    {bitmap:'invisible',visible:false,layer_anchor:'base',x:0,y:0},
    {bitmap:'outfit',visible:true,layer_anchor:'outfit',x:24,y:0},
    {bitmap:'face',visible:true,layer_anchor:'face',x:15,y:4},
    {bitmap:'base2',visible:true,layer_anchor:'base',x:0,y:0},
  ]);
  const draws=ctx.events.filter(([type])=>type==='draw');
  assert.deepEqual(ctx.events.filter(([type])=>type==='rect'),Array.from({length:6},(_,index)=>['rect',index*192,0,192,208]));
  assert.equal(ctx.events.filter(([type])=>type==='clip').length,6);
  assert.equal(ctx.events.filter(([type])=>type==='restore').length,6);
  for(let i=0;i<6;i++) {
    const left=i*192;
    const list=draws.slice(i*7,(i+1)*7);
    assert.deepEqual(list.map(([,name])=>name),['body','base1','base2','outfit','happy','face','hair']);
    assert(list.every(draw=>draw[2]===left));
    assert.deepEqual(list[1],['draw','base1',left,0,192,208,left-24,24,192,208]);
    assert.deepEqual(list[6],['draw','hair',left,0,192,208,left+12,-3,192,208]);
  }
});

test('equipment reads only visible entries and builds three strips with no extra frame step',async t=>{
  const visible=accessory();
  const {calls,bitmaps,canvases}=harness(t,[visible,accessory(2,{visible:false})]);
  const {strips,count}=await loadAvatarEquipment(id,originals,new AbortController().signal);
  assert.deepEqual([...strips.keys()],['ready','happy','cautious']);
  assert.equal(count,1);
  assert.deepEqual(calls.map(call=>call.path),[metadataPath,'/api/independent-parts/'+visible.part_id+'/part.png']);
  assert(calls.every(({options})=>options.method==='GET' && options.mode==='same-origin' && options.cache==='no-store'));
  assert.equal(calls[1].options.headers['X-Creature-Part-Preview'],'1');
  assert.deepEqual(bitmaps.map(bitmap=>bitmap.closed),[1,1,1,1,1]);
  assert.deepEqual(canvases[1].ctx.events.filter(draw=>draw[0]==='draw' && ['ready','happy','cautious'].includes(draw[1].name))
    .map(draw=>[draw[1].name,draw[2]]),['ready','happy','cautious'].flatMap(name=>Array.from({length:6},(_,frame)=>[name,frame*192])));
  assert(canvases.every(canvas=>canvas.width===0));
});

test('empty and hidden-only equipment preserve originals and invalid IDs issue no image requests',async t=>{
  const entries=[];
  const {calls,bitmaps}=harness(t,entries);
  const signal=new AbortController().signal;
  await assert.rejects(loadAvatarEquipment(null,originals,signal),/registered character ID/);
  assert.deepEqual(calls,[]);
  assert.deepEqual(await loadAvatarEquipment(id,originals,signal),{strips:null,count:0});
  entries.push(accessory(1,{visible:false}));
  assert.deepEqual(await loadAvatarEquipment(id,originals,signal),{strips:null,count:0});
  assert.deepEqual(calls.map(call=>call.path),[metadataPath,metadataPath]);
  assert.equal(bitmaps.length,0);
  entries.push(accessory(1));
  await assert.rejects(loadAvatarEquipment(id,originals,signal),/Invalid equipment entry/);
  entries.splice(0,entries.length,...Array.from({length:9},(_,index)=>accessory(index+1)));
  await assert.rejects(loadAvatarEquipment(id,originals,signal),/Invalid equipment record/);
  assert.deepEqual(calls.map(call=>call.path),Array(4).fill(metadataPath));
});

test('bad digests, size, MIME and alpha reject the whole equipment result',async t=>{
  const first=accessory();
  const second=accessory(2);
  const path='/api/independent-parts/'+second.part_id+'/part.png';
  const images=new Map();
  const entries=[first,second];
  const {bitmaps}=harness(t,entries,{images,opaque:false});
  const signal=new AbortController().signal;
  for(const [bytes,mime,headers,expected] of [
    [png(3),'image/png',{},/digest mismatch/],
    [png(2),'image/png',{'x-creature-part-sha256':'f'.repeat(64)},/Invalid equipment response/],
    [png(2),'image/png',{'Content-Length':String(1024*1024+1)},/Invalid equipment response/],
    [png(2),'image/webp',{},/Invalid equipment response/],
  ]) {
    images.set(path,()=>response(bytes,mime,{'x-creature-part-sha256':second.image_sha256,...headers}));
    await assert.rejects(loadAvatarEquipment(id,originals,signal),expected);
    assert(bitmaps.every(bitmap=>bitmap.closed===1));
  }
  entries.length=1;
  globalThis.document.createElement=()=>({getContext:()=>({clearRect(){},drawImage(){},getImageData:()=>({data:[1,2,3,255]})})});
  await assert.rejects(loadAvatarEquipment(id,originals,signal),/no transparent background/);
  assert(bitmaps.every(bitmap=>bitmap.closed===1));
});

test('aborting a late accessory decode closes its bitmap before any composite is published',async t=>{
  harness(t,[accessory()]);
  let started,release,closed=0;
  const decoding=new Promise(resolve=>{started=resolve;});
  globalThis.createImageBitmap=()=>{started();return new Promise(resolve=>{release=resolve;});};
  const controller=new AbortController();
  const pending=loadAvatarEquipment(id,originals,controller.signal);
  await decoding;
  controller.abort();
  release({width:1152,height:208,close(){closed++;}});
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(closed,1);
});

test('game keeps the existing animation and links the active registered avatar to Parts Lab',async()=>{
  const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
  const js=await readFile(new URL('../../game_runtime/generated-avatar.mjs',import.meta.url),'utf8');
  assert.match(html,/background-image:var\(--avatar-face,var\(--avatar-ready\)\),var\(--avatar-body,none\)/);
  assert.match(html,/animation:generated-avatar-frames 1\.2s steps\(6,jump-none\) infinite/);
  assert.match(html,/id="generatedAvatarEquipment"[^>]*hidden[^\n]+id="generatedAvatarEquipmentStatus" role="status"[^\n]+href="\/parts-lab\/preview\.html"/);
  assert.doesNotMatch(js,/requestAnimationFrame|\/api\/growth|\/api\/practice/);
});
