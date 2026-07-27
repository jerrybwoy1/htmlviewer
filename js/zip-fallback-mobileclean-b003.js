/* debooger2000 ZIP fallback — used only when the CDN copy of JSZip is unavailable. */
(function(){
  if(window.JSZip)return;
  const u16=(v,o)=>v.getUint16(o,true),u32=(v,o)=>v.getUint32(o,true);
  const decode=(bytes)=>new TextDecoder('utf-8').decode(bytes);
  async function inflateRaw(bytes){
    if(typeof DecompressionStream!=='function')throw new Error('This browser cannot unpack compressed ZIP files without the ZIP helper. Try Safari/Chrome or turn off content blocking for this page.');
    const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function loadAsync(input){
    const buffer=input instanceof ArrayBuffer?input:await input.arrayBuffer();
    const bytes=new Uint8Array(buffer),view=new DataView(buffer);
    let eocd=-1;
    for(let i=Math.max(0,bytes.length-65557);i<=bytes.length-22;i++){
      const p=bytes.length-22-(i-Math.max(0,bytes.length-65557));
      if(p>=0&&u32(view,p)===0x06054b50){eocd=p;break}
    }
    if(eocd<0)throw new Error('This does not look like a valid ZIP file.');
    const count=u16(view,eocd+10),centralOffset=u32(view,eocd+16),files={};
    let pos=centralOffset;
    for(let n=0;n<count;n++){
      if(pos+46>bytes.length||u32(view,pos)!==0x02014b50)throw new Error('The ZIP file directory is damaged or unsupported.');
      const flags=u16(view,pos+8),method=u16(view,pos+10),compressedSize=u32(view,pos+20),nameLen=u16(view,pos+28),extraLen=u16(view,pos+30),commentLen=u16(view,pos+32),localOffset=u32(view,pos+42);
      const name=decode(bytes.slice(pos+46,pos+46+nameLen));
      const dir=name.endsWith('/');
      files[name]={name,dir,async:async(type)=>{
        if(dir)return type==='blob'?new Blob([]):new Uint8Array();
        if(flags&1)throw new Error('Password-protected ZIP files are not supported.');
        if(localOffset+30>bytes.length||u32(view,localOffset)!==0x04034b50)throw new Error('A file inside this ZIP has a damaged header.');
        const localNameLen=u16(view,localOffset+26),localExtraLen=u16(view,localOffset+28),start=localOffset+30+localNameLen+localExtraLen,end=start+compressedSize;
        if(end>bytes.length)throw new Error('A file inside this ZIP is incomplete.');
        const packed=bytes.slice(start,end);
        let unpacked;
        if(method===0)unpacked=packed;
        else if(method===8)unpacked=await inflateRaw(packed);
        else throw new Error('This ZIP uses a compression method this browser cannot unpack.');
        if(type==='blob')return new Blob([unpacked]);
        if(type==='uint8array')return unpacked;
        if(type==='arraybuffer')return unpacked.buffer.slice(unpacked.byteOffset,unpacked.byteOffset+unpacked.byteLength);
        if(type==='text'||type==='string')return decode(unpacked);
        return new Blob([unpacked]);
      }};
      pos+=46+nameLen+extraLen+commentLen;
    }
    return{files};
  }
  window.JSZip={loadAsync};
})();
