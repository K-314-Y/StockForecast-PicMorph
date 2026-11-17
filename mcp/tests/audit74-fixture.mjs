// Fixed synthetic replay reproducing audit74's one-coin rounding liquidation.
export function roundingPlan() {
  const model={risk_fraction:.75,plugin_weights:{},plugin_strengths:{},effective_sha256:'a'.repeat(64)};
  return {mode:'PRACTICE_SYNTHETIC_ONLY',initial_coins:1,fee_rate:.001,initial_price:109,
    future_prices:[107,106,104,101,100,104,108,112,110,114,113,117],
    signals:Array.from({length:12},(_,i)=>({mine:[0,1,8,9,10,11].includes(i)?'LONG':'CASH',owl:'CASH',turtle:'CASH'})),
    allocations:{mine:100,owl:0,turtle:0},models:{mine:model,owl:model,turtle:model},model_sha256:'a'.repeat(64)};
}
