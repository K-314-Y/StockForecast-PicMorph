export const OVERLAY_MAX_SIDE=1024;
export const OVERLAY_POSITION={min:-100,max:100,initial:0};
export const OVERLAY_SCALE={min:25,max:200,initial:100};

const INVALID_IMAGE='静止PNGまたは静止WebPの画像を選んでください。';
const INVALID_SIZE='重ね絵の縦横は1〜1024pxにしてください。';

// Read dimensions before browser decode so a small compressed file cannot
// allocate a huge pixel buffer. The browser still validates the pixel data.
export function checkOverlayHeader(buffer,mime) {
  const view=new DataView(buffer);
  const tag=(at,name)=>[...name].every((char,index)=>
    at+index<view.byteLength && view.getUint8(at+index)===char.charCodeAt(0));
  const dimensions=(width,height)=>{
    if (width<1 || height<1 || width>OVERLAY_MAX_SIDE || height>OVERLAY_MAX_SIDE)
      throw Error(INVALID_SIZE);
  };
  if (mime==='image/png' && view.byteLength>=33 &&
      tag(0,'\x89PNG\r\n\x1a\n') && view.getUint32(8)===13 && tag(12,'IHDR')) {
    dimensions(view.getUint32(16),view.getUint32(20));
    for (let at=33;at+12<=view.byteLength;) {
      const size=view.getUint32(at);
      const next=at+12+size;
      if (next>view.byteLength || ['acTL','fcTL','fdAT','IHDR'].some(name=>tag(at+4,name))) break;
      if (tag(at+4,'IEND') && size===0 && next===view.byteLength) return;
      at=next;
    }
  } else if (mime==='image/webp' && view.byteLength>=20 && tag(0,'RIFF') &&
      tag(8,'WEBP') && view.getUint32(4,true)===view.byteLength-8) {
    let imageFound=false;
    let at=12;
    for (;at+8<=view.byteLength;) {
      const size=view.getUint32(at+4,true);
      const data=at+8;
      const next=data+size+(size%2);
      if (next>view.byteLength || tag(at,'ANIM') || tag(at,'ANMF')) throw Error(INVALID_IMAGE);
      if (tag(at,'VP8X')) {
        if (at!==12 || size!==10 || view.getUint8(data)&2) throw Error(INVALID_IMAGE);
        const u24=offset=>view.getUint16(offset,true)+view.getUint8(offset+2)*65536;
        dimensions(1+u24(data+4),1+u24(data+7));
      } else if (tag(at,'VP8L') || tag(at,'VP8 ')) {
        if (imageFound) throw Error(INVALID_IMAGE);
        if (tag(at,'VP8L') && size>=5 && view.getUint8(data)===0x2f) {
          const bits=view.getUint32(data+1,true);
          dimensions(1+(bits&0x3fff),1+((bits>>>14)&0x3fff));
        } else if (tag(at,'VP8 ') && size>=10 && tag(data+3,'\x9d\x01\x2a')) {
          dimensions(view.getUint16(data+6,true)&0x3fff,view.getUint16(data+8,true)&0x3fff);
        } else throw Error(INVALID_IMAGE);
        imageFound=true;
      }
      at=next;
    }
    if (imageFound && at===view.byteLength) return;
  }
  throw Error(INVALID_IMAGE);
}

export function hasOverlayAlpha(pixels) {
  let transparent=0, visible=false;
  for (let i=3;i<pixels.length;i+=4) {
    if (pixels[i]<=32) transparent++;
    if (pixels[i]>32) visible=true;
  }
  return visible && transparent>=pixels.length/40;
}

export function overlayValue(value,{min,max,initial}) {
  return Number.isFinite(value)?Math.round(Math.max(min,Math.min(max,value))):initial;
}

export function overlayRect(frameWidth,frameHeight,{bitmap,x,y,scale}) {
  const factor=Math.min(1,frameWidth/bitmap.width,frameHeight/bitmap.height);
  const fit=Math.min(factor*overlayValue(scale,OVERLAY_SCALE)/100,
    frameWidth/bitmap.width,frameHeight/bitmap.height);
  const width=Math.max(1,Math.round(bitmap.width*fit));
  const height=Math.max(1,Math.round(bitmap.height*fit));
  const left=Math.round((frameWidth-width)*(100+overlayValue(x,OVERLAY_POSITION))/200);
  const top=Math.round((frameHeight-height)*(100+overlayValue(y,OVERLAY_POSITION))/200);
  return [left,top,width,height];
}

export function canvasPoint({clientX,clientY},rect,width,height) {
  // The canvas has no padding or border and uses object-fit: contain.
  const fit=Math.min(rect.width/width,rect.height/height);
  return [
    (clientX-rect.left-(rect.width-width*fit)/2)/fit,
    (clientY-rect.top-(rect.height-height*fit)/2)/fit,
  ];
}

export function overlayPosition(offset,travel,startOffset,startValue) {
  if (travel<=0 || Math.round(offset)===startOffset) return startValue;
  return overlayValue(200*offset/travel-100,OVERLAY_POSITION);
}
