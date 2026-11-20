function crc32(data) {
  let c=0xffffffff;
  for(const b of data) {
    c^=b;
    for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);
  }
  return (c^0xffffffff)>>>0;
}
export function archive(items) {
  const local=[],central=[];
  let offset=0;
  for(const [name,content] of items) {
    const label=Buffer.from(name,'utf8'),data=Buffer.from(content);
    const crc=crc32(data);
    const lh=Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(0,8);
    lh.writeUInt32LE(crc,14);lh.writeUInt32LE(data.length,18);
    lh.writeUInt32LE(data.length,22);lh.writeUInt16LE(label.length,26);
    local.push(lh,label,data);
    const ch=Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(0,10);
    ch.writeUInt32LE(crc,16);ch.writeUInt32LE(data.length,20);
    ch.writeUInt32LE(data.length,24);ch.writeUInt16LE(label.length,28);
    ch.writeUInt32LE(offset,42);
    central.push(ch,label);
    offset+=lh.length+label.length+data.length;
  }
  const centralBytes=Buffer.concat(central);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);
  end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
  return new File([Buffer.concat([...local,centralBytes,end])],'test.zip',{type:'application/zip'});
}
