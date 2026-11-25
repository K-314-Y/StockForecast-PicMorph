export const MAX_EQUIPPED_ACCESSORIES = 3;
export const ACCESSORY_METHODS = Object.freeze({
  star:'bollinger_breakout', glasses:'rsi_oversold',
  ribbon:'macd_momentum', none:'moving_average_trend',
});
export const BUILTIN_ACCESSORIES = Object.freeze([
  Object.freeze({id:'star',name:'星',method:ACCESSORY_METHODS.star}),
  Object.freeze({id:'glasses',name:'眼鏡',method:ACCESSORY_METHODS.glasses}),
  Object.freeze({id:'ribbon',name:'リボン',method:ACCESSORY_METHODS.ribbon}),
]);
const fail = message => Object.assign(new Error(message),{status:400});

export function normalizeAccessoryDefinition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !Object.hasOwn(value,'name') || !Object.hasOwn(value,'method') ||
      typeof value.name !== 'string' || value.name.length > 48 ||
      /[\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(value.name)) {
    throw fail('アクセサリー名を1〜24文字で入力してください');
  }
  const name = value.name.trim().normalize('NFC');
  if (!name || [...name].length > 24) throw fail('アクセサリー名を1〜24文字で入力してください');
  if (!Object.values(ACCESSORY_METHODS).includes(value.method)) {
    throw fail('アクセサリーの分析方法を4種類から選んでください');
  }
  return {name,method:value.method};
}

// Both the browser and registry hash this normalized definition to identify custom equipment.
export const accessoryIdentityInput=({name,method})=>JSON.stringify([name,method]);

// ZIP and registration share the same format: built-in IDs or named definitions.
export function normalizeEquipment(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_EQUIPPED_ACCESSORIES)
    throw fail('アクセサリーを1〜3個指定してください');
  const normalized=items.map(item=>{
    if(typeof item!=='string')return normalizeAccessoryDefinition(item);
    if(!BUILTIN_ACCESSORIES.some(accessory=>accessory.id===item))
      throw fail('装備できるアクセサリーを指定してください');
    return item;
  });
  requireDistinctMethods(normalized.map(item=>typeof item==='string'?ACCESSORY_METHODS[item]:item.method));
  return normalized;
}

export function requireDistinctMethods(methods) {
  if (new Set(methods).size !== methods.length)
    throw fail('同じ分析方法のアクセサリーは1個だけ装備できます');
}

// A trace is optional. Keep the recorded decisions usable when its detail is unavailable.
export function validDecisionTrace(trace,signals,expectedMethods) {
  if (!Array.isArray(trace) || trace.length!==12 || signals?.length!==12) return false;
  const score=value=>Number.isFinite(value) && value>=0 && value<=1;
  const allowed=Object.values(ACCESSORY_METHODS);
  let methods=expectedMethods;
  for (const [day,row] of trace.entries()) {
    if (!row || Object.keys(row).sort().join('|')!=='baseline_up|combined_support|method_supports|signal|threshold' ||
        !score(row.baseline_up) || !score(row.combined_support) || row.threshold!==0.54 ||
        row.signal!==signals[day] || row.signal!==(row.combined_support>row.threshold?'LONG':'CASH')) return false;
    const supports=row.method_supports;
    if (!supports || typeof supports!=='object' || Array.isArray(supports)) return false;
    const keys=Object.keys(supports);
    methods ??= keys;
    if (keys.length<1 || keys.length>MAX_EQUIPPED_ACCESSORIES || keys.length!==methods.length ||
        !keys.every(key=>allowed.includes(key) && methods.includes(key) && score(supports[key]))) return false;
    const average=keys.reduce((sum,key)=>sum+supports[key],0)/keys.length;
    if (Math.abs(row.combined_support-(0.8*average+0.2*row.baseline_up))>Number.EPSILON) return false;
  }
  return true;
}
