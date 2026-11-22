/** Explicit kind-to-indicator rules for the fixed synthetic comparison. */
import {INDICATORS,validateLabModel} from './model-lab.mjs';
import {validateEquipmentParts} from './character-equipment.mjs';

const KIND=/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const validKind=id=>typeof id==='string' && id.length<=64 && id===id.trim() && KIND.test(id);
const keys=value=>value && typeof value==='object' && !Array.isArray(value)?Object.keys(value).sort().join('|'):'';
const fail=(message,status)=>Object.assign(Error(message),{status});
const compareKind=(a,b)=>a.kind_id<b.kind_id?-1:a.kind_id>b.kind_id?1:0;

export function validateAnalysisPolicies(value) {
  if(!Array.isArray(value) || value.length>32)throw fail('分析設定は32種類までです',400);
  const seen=new Set();
  return value.map(row=>{
    if(!['focus|kind_id','focus|intensity|kind_id'].includes(keys(row)) ||
       !validKind(row.kind_id) || !INDICATORS.includes(row.focus) || seen.has(row.kind_id)) {
      throw fail('装飾品の種類や分析の指定が不正です',400);
    }
    const intensity=Object.hasOwn(row,'intensity')?row.intensity:1;
    if(!Number.isInteger(intensity) || intensity<1 || intensity>3)throw fail('強度は1〜3の整数で指定してください',400);
    seen.add(row.kind_id);
    return {kind_id:row.kind_id,focus:row.focus,intensity};
  }).sort(compareKind);
}

export function analysisCatalog(parts) {
  if(!Array.isArray(parts) || parts.length>32)throw fail('装飾品カタログを検証できません',503);
  const byId=new Map(),counts=new Map();
  for(const part of parts) {
    if(typeof part?.part_id!=='string' || part.part_id.length!==35 || !/^pt_[a-f0-9]{32}$/.test(part.part_id) ||
       typeof part.image_sha256!=='string' || part.image_sha256.length!==64 || !/^[a-f0-9]{64}$/.test(part.image_sha256) ||
       !validKind(part.kind_id) || byId.has(part.part_id))throw fail('装飾品カタログを検証できません',503);
    byId.set(part.part_id,{kind_id:part.kind_id,image_sha256:part.image_sha256});
    counts.set(part.kind_id,(counts.get(part.kind_id)??0)+1);
  }
  return {byId,kinds:[...counts].map(([kind_id,part_count])=>({kind_id,part_count})).sort(compareKind)};
}

export function stalePolicyKinds(policies,catalog) {
  const known=new Set(catalog.kinds.map(row=>row.kind_id));
  return policies.filter(row=>!known.has(row.kind_id)).map(row=>row.kind_id);
}

export function equippedAnalysisKinds(equipment,catalog) {
  if(!Array.isArray(equipment) || equipment.length>8)throw fail('装備設定を検証できません',422);
  const seen=new Map(),visibleKinds=new Set();
  for(const part of equipment) {
    try {validateEquipmentParts([part]);}
    catch {throw fail('装備設定を検証できません',422);}
    const registered=catalog.byId.get(part.part_id);
    if(!registered || registered.image_sha256!==part.image_sha256) {
      throw fail('装備のパーツが削除されたか、画像SHA-256が変わっています。Parts Labで装備を確認してください',422);
    }
    const prior=seen.get(part.part_id);
    if(prior) {
      if(!Object.keys(part).every(key=>part[key]===prior[key]))throw fail('重複した装備の設定が一致しません',422);
      continue;
    }
    seen.set(part.part_id,part);
    if(part.visible)visibleKinds.add(registered.kind_id);
  }
  return [...visibleKinds].sort();
}

export function deriveAccessoryAnalysis(baseline,policies,equipment,catalog) {
  const model=validateLabModel(baseline);
  const rules=validateAnalysisPolicies(policies);
  const stale=stalePolicyKinds(rules,catalog);
  if(stale.length)throw fail('カタログに存在しない種類の分析設定があります。設定を保存し直してください',422);
  const visibleKinds=equippedAnalysisKinds(equipment,catalog);
  const applied=rules.filter(rule=>visibleKinds.includes(rule.kind_id));
  if(!applied.length)return {candidate:baseline,applied,visibleKinds};
  const points={...model.plugin_weights};
  for(const {focus,intensity} of applied)points[focus]+=10*intensity;
  const total=Object.values(points).reduce((sum,n)=>sum+n,0);
  // Integer largest-remainder allocation; ties keep the declared indicator order.
  const ranked=INDICATORS.map((focus,index)=>({focus,index,base:Math.floor(points[focus]*100/total),rest:points[focus]*100%total}));
  const weights=Object.fromEntries(ranked.map(row=>[row.focus,row.base]));
  const remainder=100-ranked.reduce((sum,row)=>sum+row.base,0);
  ranked.sort((a,b)=>b.rest-a.rest || a.index-b.index);
  for(const row of ranked.slice(0,remainder))weights[row.focus]++;
  return {candidate:{...model,plugin_weights:weights},applied,visibleKinds};
}
