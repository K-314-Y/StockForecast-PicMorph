/**
 * Synthetic, game-only leverage settlement.
 *
 * The original market simulator stays unchanged: it computes a model's
 * 12-step equity using its own risk_fraction and simulated fees. This helper
 * applies the user's independently selected multiplier to the resulting net
 * P&L path. Once the allocated balance hits zero it is liquidated and cannot
 * recover, even if later synthetic prices rise. Unallocated cash is untouched.
 * This is NOT an FX margin, real intraday stop-out, or brokerage simulator.
 */
export const MAX_PRACTICE_LEVERAGE = 25;
export const PRACTICE_START_BALANCE = 10000;
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;

export function settleLeveragedPractice({equityPath,amount,leverage,available=10000}) {
  if (!Number.isSafeInteger(amount) || amount<1 ||
      !Number.isSafeInteger(available) || available<amount ||
      !Number.isSafeInteger(leverage) || leverage<1 ||
      leverage>MAX_PRACTICE_LEVERAGE) {
    throw new RangeError('練習額・倍率が不正です');
  }
  if (!Array.isArray(equityPath) || equityPath.length<2 ||
      equityPath.length>501 ||
      !equityPath.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0) ||
      Math.abs(equityPath[0]-amount)>0.01) {
    throw new RangeError('架空の損益推移が不正です');
  }
  const cashHeld=available-amount;
  const leveragedPath=[amount];
  let stoppedAtStep=null;
  for (let i=1;i<equityPath.length;i++){
    if (stoppedAtStep!==null){
      leveragedPath.push(0);
      continue;
    }
    // Scale fee-inclusive net profit relative to original practice capital.
    const tentative=amount + leverage*(equityPath[i]-amount);
    if (tentative<=0){
      leveragedPath.push(0);
      stoppedAtStep=i;
    } else {
      leveragedPath.push(tentative);
    }
  }
  let peak=amount,dd=0;
  for (const capital of leveragedPath.slice(1)){
    peak=Math.max(peak,capital);
    dd=Math.max(dd,1-capital/peak);
  }
  const finalCapital=leveragedPath.at(-1);
  return {
    leverage,
    invested_coins:amount,
    cash_held:cashHeld,
    profit_coins:round(finalCapital-amount),
    final_balance:round(cashHeld+finalCapital),
    allocated_final:round(finalCapital),
    max_drawdown_pct:round(dd*100),
    liquidated_at_step:stoppedAtStep,
    estimated_using_daily_steps:true,
    // Internal path is returned only by the helper, not the public API.
    allocated_equity_path:leveragedPath.map(round),
  };
}

// Unwired experiment: freeze at the first daily sample gaining or losing the stake.
// Daily closes cannot model intraday execution or guarantee economic neutrality.
export function settleSymmetricCappedExperiment({equityPath,amount,leverage,available=10000}) {
  const original=settleLeveragedPractice({equityPath,amount,leverage,available});
  const gainLimit=2*amount;
  const cappedPath=[amount];
  let stoppedAtStep=null,stopReason=null;
  let finalCapital=amount,peak=amount,dd=0;
  for(let i=1;i<original.allocated_equity_path.length;i++){
    if(stoppedAtStep===null){
      // The original output path rounds cents; thresholds and drawdown must not.
      finalCapital=amount+leverage*(equityPath[i]-amount);
      if(finalCapital>=gainLimit){
        finalCapital=gainLimit;
        stoppedAtStep=i;
        stopReason='gain_cap';
      } else if(original.liquidated_at_step===i){
        finalCapital=0;
        stoppedAtStep=i;
        stopReason='loss_cap';
      }
    }
    cappedPath.push(stoppedAtStep===null ? original.allocated_equity_path[i] : finalCapital);
    peak=Math.max(peak,finalCapital);
    dd=Math.max(dd,1-finalCapital/peak);
  }
  return {
    leverage,
    invested_coins:amount,
    cash_held:original.cash_held,
    profit_coins:round(finalCapital-amount),
    allocated_final:round(finalCapital),
    final_balance:round(original.cash_held+finalCapital),
    max_drawdown_pct:round(dd*100),
    stopped_at_step:stoppedAtStep,
    stop_reason:stopReason,
    experimental_only:true,
    daily_close_only:true,
    capped_equity_path:cappedPath,
  };
}
