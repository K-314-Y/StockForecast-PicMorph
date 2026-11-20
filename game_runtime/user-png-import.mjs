/** Private Linux-only import of user-supplied, already normalized PNG sheets. */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HELPER=fileURLToPath(new URL('../mcp/import_png_character.py',import.meta.url));
const MAX_PART=720000,MAX_OUT=8192;
const PARTS=['body','ready','happy','cautious'];
const validId=value=>typeof value==='string' && /^cp_[a-f0-9]{32}$/.test(value);
const failure=(message,status=400)=>Object.assign(Error(message),{status});

export function validateUserPngPayload(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) ||
     Object.keys(value).sort().join(',')!=='name,parts') throw failure('名前とPNG4枚を選んでください');
  const name=value.name;
  if(typeof name!=='string' || name!==name.trim() || [...name].length<1 ||
    [...name].length>16 || /[\p{Cc}\p{Cf}]/u.test(name) ||
    !value.parts || typeof value.parts!=='object' || Array.isArray(value.parts) ||
    Object.keys(value.parts).sort().join(',')!==PARTS.slice().sort().join(',')) {
    throw failure('名前は1～16文字、PNGは体と表情の計4枚を指定してください');
  }
  for(const part of PARTS) {
    const image=value.parts[part];
    if(typeof image!=='string' || image.length>MAX_PART ||
       !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) throw failure('PNG画像が不正または大きすぎます');
  }
  return value;
}

export function createUserPngImporter({script=HELPER}={}) {
  return async function importUserPng(input) {
    if(process.platform!=='linux') throw failure('PNGの登録はLinux側で行ってください',501);
    const payload=validateUserPngPayload(input);
    return new Promise((resolve,reject)=>{
      const child=spawn('python3',['-B','-E',script,'register_upload'],{
        stdio:['pipe','pipe','ignore'],
        env:{HOME:process.env.HOME??'',PATH:process.env.PATH??'/usr/bin:/bin',
          LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'},
      });
      let output='',settled=false,aborted=false;
      const timer=setTimeout(()=>{aborted=true;child.kill('SIGKILL');},20000);
      function finish(error,result) {
        if(settled) return;
        settled=true;clearTimeout(timer);
        if(error)reject(error);else resolve(result);
      }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        output+=chunk;
        if(output.length>MAX_OUT){aborted=true;child.kill('SIGKILL');}
      });
      child.on('error',()=>finish(failure('PNGの登録を開始できません',503)));
      child.on('close',code=>{
        if(aborted || code!==0) return finish(failure('PNG登録を完了できません',503));
        try {
          const result=JSON.parse(output);
          if(typeof result?.error==='string') return finish(failure('PNGを登録できません。4枚の透明PNGのサイズを確認してください',422));
          if(!validId(result?.result?.generated_id) || result.result.engine!=='user-png' ||
             result.result.name!==payload.name || result.result.registered!==true)
            throw Error('Invalid result');
          finish(null,result.result);
        } catch {finish(failure('PNG登録の結果を確認できません',503));}
      });
      child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify(payload)+'\n');
    });
  };
}
