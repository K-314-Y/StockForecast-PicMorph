/** Read-only subprocess bridge to the private Linux catalog. */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const INDEPENDENT_PARTS_API='/api/independent-parts';
const HELPER=fileURLToPath(new URL('../mcp/independent_parts_catalog.py',import.meta.url));
const MAX_PNG=1024*1024;
const PART_ID=/^pt_[0-9a-f]{32}$/;
const SHA=/^[0-9a-f]{64}$/;
const KIND=/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);

function callHelper(script,operation,input,signal) {
  return new Promise((resolve,reject)=>{
    let outcome;
    const child=execFile('python3',['-B','-E',script,operation],{
      env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'},
      signal,timeout:8000,killSignal:'SIGKILL',
      maxBuffer:operation==='image'?4*Math.ceil(MAX_PNG/3)+4096:16384,
    },(error,stdout)=>{outcome={error,stdout};});
    child.once('close',()=>{
      if(!outcome || outcome.error)return reject(Error('Catalog helper failed'));
      try {
        const response=JSON.parse(outcome.stdout);
        if(response.code==='not_found' && operation==='image')return resolve(null);
        if(response.error || !response.result)throw Error('Invalid catalog response');
        resolve(response.result);
      }catch(error){reject(error);}
    });
    child.stdin.on('error',()=>child.kill('SIGKILL'));
    child.stdin.end(JSON.stringify(input)+'\n');
  });
}

function matches(regex,value,length) {
  return typeof value==='string' && value.length===length && regex.test(value);
}

export function createIndependentPartReader({script=HELPER}={}) {
  return {
    async list(signal) {
      const {parts}=await callHelper(script,'list',{},signal);
      if(!Array.isArray(parts) || parts.length>32)throw Error('Invalid catalog list');
      const seen=new Set();
      return {parts:parts.map(({part_id,kind_id,layer_anchor,source_id,candidate_id,image_sha256})=>{
        if(!matches(PART_ID,part_id,35) || seen.has(part_id) ||
           typeof kind_id!=='string' || kind_id.length>64 || kind_id!==kind_id.trim() || !KIND.test(kind_id) ||
           !['base','outfit','face','hair'].includes(layer_anchor) ||
           !matches(/^cp_[0-9a-f]{32}$/,source_id,35) ||
           !matches(/^sg_[0-9a-f]{32}$/,candidate_id,35) || !matches(SHA,image_sha256,64))
          throw Error('Invalid part metadata');
        seen.add(part_id);
        return {part_id,kind_id,layer_anchor,source_id,candidate_id,image_sha256};
      })};
    },
    async image(part_id,signal) {
      if(!matches(PART_ID,part_id,35))throw Error('Invalid part ID');
      const result=await callHelper(script,'image',{part_id},signal);
      if(result===null)return null;
      const {png_base64:encoded,image_sha256:sha256}=result;
      if(result.part_id!==part_id || !matches(SHA,sha256,64) || typeof encoded!=='string' ||
         encoded.length>4*Math.ceil(MAX_PNG/3))throw Error('Invalid part image');
      const bytes=Buffer.from(encoded,'base64');
      if(bytes.length<33 || bytes.length>MAX_PNG || bytes.toString('base64')!==encoded ||
         !bytes.subarray(0,8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(16)!==1152 ||
         bytes.readUInt32BE(20)!==208 || bytes[24]!==8 || bytes[25]!==6 ||
         createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('Invalid part image');
      return {bytes,sha256};
    },
  };
}
