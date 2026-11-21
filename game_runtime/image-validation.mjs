/**
 * Bounded structural validation; PNG also verifies CRCs and inflated scanline sizes.
 * This is not a full pixel decoder. JPEG supports Huffman SOF0/1/2; animated WebP
 * is rejected because validating its nested frames needs a separate parser.
 */
import {inflateSync} from 'node:zlib';
const MAX_PIXELS=16*1024*1024, MAX_INFLATED=64*1024*1024;
function check(ok) {if(!ok) throw new Error('Invalid image structure');}
function dimensions(w,h) {check(w>0 && h>0 && w<=16384 && h<=16384 && w*h<=MAX_PIXELS);}
const crcTable=Array.from({length:256},(_,n)=>{
  for(let i=0;i<8;i++) n=(n>>>1)^((n&1)?0xedb88320:0);
  return n>>>0;
});
function crc(bytes) {
  let n=0xffffffff;
  for(const b of bytes) n=(n>>>8)^crcTable[(n^b)&255];
  return (n^0xffffffff)>>>0;
}
function png(b) {
  check(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  let p=8,header, palette=false,ended=false,idatEnded=false;
  const parts=[];
  while(p<b.length) {
    check(p+12<=b.length && !ended);
    const n=b.readUInt32BE(p),type=b.toString('ascii',p+4,p+8),end=p+12+n;
    check(end<=b.length && /^[A-Za-z]{4}$/.test(type) && (b[p+6]&32)===0);
    check(crc(b.subarray(p+4,p+8+n))===b.readUInt32BE(p+8+n));
    const data=b.subarray(p+8,p+8+n);
    if(!header) {check(type==='IHDR' && n===13);header=data;}
    else if(type==='IHDR') check(false);
    if(type==='PLTE') {
      check(!palette && !parts.length && n>0 && n%3===0 && n<=768 && ![0,4].includes(header[9]));
      if(header[9]===3) check(n/3<=2**header[8]);
      palette=true;
    } else if(type==='IDAT') {
      check(!idatEnded && (header[9]!==3 || palette));parts.push(data);
    } else {
      if(parts.length) idatEnded=true;
      if(type==='IEND') {check(n===0 && parts.length>0 && end===b.length);ended=true;}
      else check(type==='IHDR' || type==='PLTE' || (b[p+4]&32)!==0);
    }
    p=end;
  }
  check(header && ended);
  const w=header.readUInt32BE(0),h=header.readUInt32BE(4),depth=header[8],color=header[9];
  dimensions(w,h);
  const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
  check(depths[color]?.includes(depth) && header[10]===0 && header[11]===0 && header[12]<=1);
  const channels={0:1,2:3,3:1,4:2,6:4}[color];
  const passes=header[12]?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  const rows=passes.map(([x,y,dx,dy])=>{
    const pw=Math.max(0,Math.ceil((w-x)/dx)),ph=Math.max(0,Math.ceil((h-y)/dy));
    return [Math.ceil(pw*depth*channels/8)+1,pw?ph:0];
  });
  const size=rows.reduce((sum,[stride,count])=>sum+stride*count,0);
  check(size>0 && size<=MAX_INFLATED);
  const compressed=Buffer.concat(parts);
  const out=inflateSync(compressed,{maxOutputLength:size,info:true});
  check(out.buffer.length===size && out.engine.bytesWritten===compressed.length);
  let offset=0;
  for(const [stride,count] of rows) for(let y=0;y<count;y++,offset+=stride) check(out.buffer[offset]<=4);
  return {width:w,height:h};
}
function jpeg(b) {
  check(b.length>=4 && b[0]===255 && b[1]===216);
  let p=2,frame=null,scans=0,entropy=0;
  const quantizers=new Set(),huffman=new Set(),requiredQuantizers=new Set();
  while(p<b.length) {
    check(b[p++]===255);
    while(b[p]===255) p++;
    const marker=b[p++];
    if(marker===0xd9) {check(frame && scans && entropy && p===b.length);return;}
    check(marker!==undefined && marker!==0 && marker!==0xd8 && !(marker>=0xd0 && marker<=0xd7));
    check(p+2<=b.length);
    const n=b.readUInt16BE(p);check(n>=2 && p+n<=b.length);
    const data=b.subarray(p+2,p+n);p+=n;
    if([0xc0,0xc1,0xc2].includes(marker)) {
      check(!frame && data.length>=6 && [8,12].includes(data[0]));
      dimensions(data.readUInt16BE(3),data.readUInt16BE(1));
      const count=data[5];check(count>=1 && count<=4 && data.length===6+3*count);
      frame=new Set();
      for(let i=6;i<data.length;i+=3) {
        check(!frame.has(data[i]) && (data[i+1]>>4)>=1 && (data[i+1]>>4)<=4 &&
          (data[i+1]&15)>=1 && (data[i+1]&15)<=4 && data[i+2]<=3);frame.add(data[i]);requiredQuantizers.add(data[i+2]);
      }
    } else if(marker===0xda) {
      check(frame && data.length>=6 && [...requiredQuantizers].every(id=>quantizers.has(id)) && huffman.size>0);
      const count=data[0];check(count>=1 && count<=frame.size && data.length===4+2*count);
      const ids=new Set();
      for(let i=1;i<=2*count;i+=2) {
        check(frame.has(data[i]) && !ids.has(data[i]) && (data[i+1]>>4)<=3 && (data[i+1]&15)<=3);ids.add(data[i]);
      }
      check(data.at(-3)<=63 && data.at(-2)<=63 && (data.at(-1)>>4)<=13 && (data.at(-1)&15)<=13);
      scans++;let scanBytes=0;
      while(p<b.length) {
        if(b[p]!==255) {p++;scanBytes++;continue;}
        if(b[p+1]===0) {p+=2;scanBytes++;continue;}
        if(b[p+1]>=0xd0 && b[p+1]<=0xd7) {p+=2;continue;}
        break;
      }
      check(scanBytes>0);entropy+=scanBytes;
    } else if(marker===0xdb) {
      let q=0;
      while(q<data.length) {const info=data[q++];check((info>>4)<=1 && (info&15)<=3);quantizers.add(info&15);q+=64*((info>>4)+1);check(q<=data.length);}
      check(q>0);
    } else if(marker===0xc4) {
      let q=0;
      while(q<data.length) {
        check(q+17<=data.length && (data[q]>>4)<=1 && (data[q]&15)<=3);huffman.add(data[q++]);
        let count=0,space=1;
        for(let i=0;i<16;i++) {const n=data[q++];count+=n;space=space*2-n;check(space>=0);}
        check(count>0 && count<=256 && q+count<=data.length);q+=count;
      }
      check(q>0);
    } else if(marker===0xdd) check(data.length===2);
    else check((marker>=0xe0 && marker<=0xef) || marker===0xfe);
  }
  check(false);
}
function webp(b) {
  check(b.length>=20 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP' && b.readUInt32LE(4)===b.length-8);
  let p=12,images=0,canvas=null,size;
  while(p<b.length) {
    check(p+8<=b.length);
    const type=b.toString('ascii',p,p+4),n=b.readUInt32LE(p+4),end=p+8+n;
    check(end+(n&1)<=b.length && (!(n&1) || b[end]===0));
    const d=b.subarray(p+8,end);
    if(type==='VP8X') {
      check(p===12 && n===10 && (d[0]&0xc1)===0 && d[1]===0 && d[2]===0 && d[3]===0);
      // Animation requires frame validation; reject rather than accept opaque frames.
      check(!(d[0]&2));canvas=[1+d.readUIntLE(4,3),1+d.readUIntLE(7,3)];dimensions(...canvas);
    } else if(type==='VP8 ' || type==='VP8L') {
      check(images++===0);
      let w,h;
      if(type==='VP8 ') {
        check(n>10 && !(d[0]&1) && ((d[0]>>1)&7)<=3 && (d[0]&16) && d.subarray(3,6).equals(Buffer.from([157,1,42])));
        const partition=d.readUIntLE(0,3)>>>5;check(partition>0 && 10+partition<n);
        w=d.readUInt16LE(6)&0x3fff;h=d.readUInt16LE(8)&0x3fff;
      } else {
        check(n>5 && d[0]===0x2f && (d[4]>>5)===0);
        const bits=d.readUInt32LE(1);w=1+(bits&0x3fff);h=1+((bits>>>14)&0x3fff);
      }
      dimensions(w,h);if(canvas) check(w===canvas[0] && h===canvas[1]);
      size={width:w,height:h};
    } else check(canvas && ['ALPH','ICCP','EXIF','XMP '].includes(type) && n>0);
    p=end+(n&1);
  }
  check(images===1);
  return size;
}
export function validatedImageDimensions(bytes,mime) {
  try {return ({'image/png':png,'image/webp':webp}[mime])(bytes);}
  catch {return null;}
}
export function validateImageStructure(bytes,mime) {
  if(mime!=='image/jpeg')return Boolean(validatedImageDimensions(bytes,mime));
  try {jpeg(bytes);return true;}
  catch {return false;}
}
