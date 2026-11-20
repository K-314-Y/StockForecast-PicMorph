/** Explicit, local-only procedural demo registration. Never edits saved avatars or game state. */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HELPER=fileURLToPath(new URL('../mcp/character_parts.py',import.meta.url));
const ID=/^cp_[0-9a-f]{32}$/;
const COLORS=/^#[0-9a-fA-F]{6}$/;
const ACCESSORIES=new Set(['none','ribbon','glasses','star']);
const MAX_OUTPUT=8192;
const error=(message,status=503)=>Object.assign(Error(message),{status});

export function validateRegistration(input) {
  if(!input || typeof input!=='object' || Array.isArray(input) ||
     Object.keys(input).sort().join('|')!=='accessory|clothing_color|hair_color|name') {
    throw error('名前・髪色・服色・飾りを指定してください',400);
  }
  const name=input.name;
  if(typeof name!=='string' || name!==name.trim() ||
     [...name].length<1 || [...name].length>16 ||
     /[\p{Cc}\p{Cf}]/u.test(name) ||
     !COLORS.test(input.hair_color) || !COLORS.test(input.clothing_color) ||
     !ACCESSORIES.has(input.accessory)) {
    throw error('名前は1～16文字、色は6桁のカラーコードで指定してください',400);
  }
  return {name,hair_color:input.hair_color.toLowerCase(),
    clothing_color:input.clothing_color.toLowerCase(),accessory:input.accessory,seed:314};
}

function callHelper(script,operation,payload) {
  return new Promise((resolve,reject)=>{
    // Fixed executable, fixed operation and private script path; no shell or JSON argv.
    const child=spawn('python3',['-B','-E',script,operation],{
      stdio:['pipe','pipe','ignore'],
      env:{HOME:process.env.HOME??'', PATH:process.env.PATH??'/usr/bin:/bin',
        LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'},
    });
    let output='',done=false,cutoff=false;
    const timeout=setTimeout(()=>{cutoff=true;child.kill('SIGKILL');},16000);
    const finish=(err,result)=>{
      if(done)return;
      done=true;clearTimeout(timeout);
      if(err)reject(err);else resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      output+=chunk;
      if(output.length>MAX_OUTPUT){cutoff=true;child.kill('SIGKILL');}
    });
    child.on('error',()=>finish(error('キャラ生成エンジンを起動できません')));
    child.on('close',code=>{
      if(cutoff || code!==0) return finish(error('キャラ生成エンジンが応答できません'));
      try {
        const parsed=JSON.parse(output);
        if(parsed?.error) return finish(error('キャラを登録できません。入力や保存容量を確認してください'));
        if(!parsed || typeof parsed.result!=='object' || Array.isArray(parsed.result))
          throw Error('invalid response');
        finish(null,parsed.result);
      } catch {finish(error('キャラ生成の結果を確認できません'));}
    });
    child.stdin.on('error',()=>{}); // EPIPE is handled by the process close event.
    child.stdin.end(JSON.stringify(payload)+'\n');
  });
}

export function createLocalCharacterCreator({script=HELPER}={}) {
  return async function createDemo(payload) {
    if(process.platform!=='linux') throw error('キャラ生成はLinux側のゲームで行ってください',501);
    const appearance=validateRegistration(payload);
    const generated=await callHelper(script,'generate',appearance);
    if(!ID.test(generated?.generated_id) || generated.name!==appearance.name ||
       generated.engine!=='original-template') {
      throw error('生成したキャラの記録を確認できません');
    }
    const registered=await callHelper(script,'register',{generated_id:generated.generated_id});
    if(registered.generated_id!==generated.generated_id || registered.name!==appearance.name ||
       registered.visibility!=='local_only' || registered.engine!=='original-template') {
      throw error('キャラの登録結果を確認できません');
    }
    return {generated_id:registered.generated_id,name:registered.name,engine:'original-template'};
  };
}
