/**
 * Local-only tutorial XP and gear storage owned by the Node game.
 * Compatible with growth.py schema 1, but NEVER writes to the Python file.
 * One process is the sole writer. No online auth/multi-user support yet.
 */
import {readFile, mkdir, open, rename, unlink, lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateAllocations} from './practice.mjs';

export const GROWTH_FILE = fileURLToPath(new URL('../local_state/node_game/growth.json', import.meta.url));
export const LEGACY_FILE = fileURLToPath(new URL('../local_state/growth.json', import.meta.url));

const SLOTS = ['mine', 'owl', 'turtle'];
const CHALLENGES = Object.freeze({
  first_practice: {name:'はじめての練習', xp:20},
  diversify_slots: {name:'2体以上に配分', xp:10},
  full_allocation: {name:'合計100%を配分', xp:10},
});
const GEAR = Object.freeze([
  {id:'none', name:'装備なし', icon:'·', unlock_xp:0, plugin:null, bonus:0},
  {id:'focus_lens', name:'集中レンズ', icon:'🔎', unlock_xp:20, plugin:'trend', bonus:10},
  {id:'spark_charm', name:'ひらめきの飾り', icon:'⚡', unlock_xp:30, plugin:'momentum', bonus:15},
  {id:'calm_halo', name:'静寂の輪', icon:'🛡️', unlock_xp:40, plugin:'volatility', bonus:15},
]);
const GEARS = new Map(GEAR.map(x => [x.id, x]));

export class GrowthError extends Error {
  constructor(message, status = 400) {super(message);this.status = status;}
}

function empty() {
  return {schema:1, revision:0, slots:Object.fromEntries(SLOTS.map(k=>[k,{
    achievements:[],gear:'none',
  }]))};
}

function numericInteger(n) {return Number.isSafeInteger(n) && n >= 0;}

function xpOf(slot) {
  return slot.achievements.reduce((total, id) => total + CHALLENGES[id].xp, 0);
}

function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== 'revision|schema|slots' ||
      value.schema !== 1 || !numericInteger(value.revision) ||
      !value.slots || typeof value.slots !== 'object' ||
      Object.keys(value.slots).sort().join('|') !== [...SLOTS].sort().join('|')) {
    throw new GrowthError('育成記録の形式が不正です', 503);
  }
  for (const k of SLOTS) {
    const slot = value.slots[k];
    if (!slot || typeof slot !== 'object' || Array.isArray(slot) ||
        Object.keys(slot).sort().join('|') !== 'achievements|gear' ||
        !Array.isArray(slot.achievements) ||
        slot.achievements.some(a => typeof a !== 'string' || !Object.hasOwn(CHALLENGES, a)) ||
        new Set(slot.achievements).size !== slot.achievements.length ||
        typeof slot.gear !== 'string' || !GEARS.has(slot.gear) ||
        xpOf(slot) < GEARS.get(slot.gear).unlock_xp) {
      throw new GrowthError('育成記録の内容が不正です', 503);
    }
  }
  return value;
}

export function publicGrowth(record) {
  validateRecord(record);
  return {
    revision: record.revision,
    slots:SLOTS.map(slot => {
      const state=record.slots[slot], xp=xpOf(state);
      return {slot, xp, level:1+Number(xp>=20)+Number(xp>=40),
        achievements:[...state.achievements], gear:state.gear,
        gear_options:GEAR.map(g => ({...g,unlocked:xp>=g.unlock_xp}))};
    }),
    challenges:Object.entries(CHALLENGES).map(([id,value])=>({id,...value})),
    notice:'XPは各練習課題につき一度だけ。利益・予測精度では増えません。',
  };
}

async function readSafe(file) {
  try {
    const info=await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size>65536) {
      throw new GrowthError('保存先が通常のJSONファイルではありません', 503);
    }
    const contents=await readFile(file,'utf8');
    return validateRecord(JSON.parse(contents));
  } catch(e) {
    if (e.code==='ENOENT') return null;
    if (e instanceof GrowthError) throw e;
    throw new GrowthError('育成記録を読み取れません',503);
  }
}

async function durableWrite(file,value) {
  const dir=dirname(file);
  await mkdir(dir,{recursive:true,mode:0o700});
  const tmp=join(dir,'.growth-'+randomUUID());
  let handle;
  try {
    handle=await open(tmp,'wx',0o600);
    await handle.writeFile(JSON.stringify(value,null,2)+'\n','utf8');
    await handle.sync();
    await handle.close();handle=null;
    await rename(tmp,file);
    const dirHandle=await open(dir,'r');
    try {await dirHandle.sync();} finally {await dirHandle.close();}
  } finally {
    if(handle) await handle.close();
    await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
}

function expectRevision(value,expected) {
  if (!numericInteger(expected) || value.revision!==expected) {
    throw new GrowthError('育成状態が更新されています。読み直してください',409);
  }
}

export function createGrowthStore({file=GROWTH_FILE,legacyFile=LEGACY_FILE}={}) {
  let sequence=Promise.resolve();
  // The old Python file is always read-only, including during one-time import.
  const read = async()=>validateRecord(
    await readSafe(file) ?? await readSafe(legacyFile) ?? empty()
  );
  const serialized = task => {
    const result=sequence.then(task);
    sequence=result.catch(()=>{});
    return result;
  };
  return {
    read,
    async public() {return publicGrowth(await read());},
    complete(allocations,expectedRevision) {
      return serialized(async()=>{
        const a=validateAllocations(allocations);
        if (Object.values(a).every(v=>v===0)) throw new GrowthError('コインを配分してください');
        const old=await read(); expectRevision(old,expectedRevision);
        const next=structuredClone(old);
        const active=SLOTS.filter(k=>a[k]>0);
        const achievements=['first_practice'];
        if(active.length>=2)achievements.push('diversify_slots');
        if(Object.values(a).reduce((x,y)=>x+y,0)===100)achievements.push('full_allocation');
        const earned_xp={};
        let changed=false;
        for(const slot of active) {
          let earned=0;
          for(const id of achievements) {
            if(!next.slots[slot].achievements.includes(id)) {
              next.slots[slot].achievements.push(id);
              earned+=CHALLENGES[id].xp;
            }
          }
          earned_xp[slot]=earned;
          if(earned>0)changed=true;
        }
        if(changed) {next.revision++;await durableWrite(file,next);}
        return {earned_xp,growth:publicGrowth(next)};
      });
    },
    equip(slot,gearId,expectedRevision) {
      return serialized(async()=>{
        if(!SLOTS.includes(slot) || typeof slot!=='string' ||
            typeof gearId!=='string' || !GEARS.has(gearId)) {
          throw new GrowthError('キャラまたは装備が不正です');
        }
        const old=await read();expectRevision(old,expectedRevision);
        const next=structuredClone(old);
        if(xpOf(next.slots[slot])<GEARS.get(gearId).unlock_xp) {
          throw new GrowthError('装備はまだ解放されていません');
        }
        if(next.slots[slot].gear!==gearId) {
          next.slots[slot].gear=gearId;
          next.revision++;
          await durableWrite(file,next);
        }
        return publicGrowth(next);
      });
    },
  };
}
