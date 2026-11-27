/** S111: isolated synthetic accounting prototype; not a game endpoint or real-data evaluator. */
const MODE='SYNTHETIC_NEXT_OPEN_V2_DRAFT';
const INITIAL=10000, FEE=.001, DAYS=12;
const exact=(obj,keys)=>obj && typeof obj==='object' && !Array.isArray(obj) &&
  Object.keys(obj).sort().join('|')===[...keys].sort().join('|');
const number=(v,min,max)=>typeof v==='number' && Number.isFinite(v) && v>=min && v<=max;
const price=v=>number(v,.01,1e6);
const fail=()=>{throw Error('Invalid synthetic next-open plan');};

// Only precomputed signals are accepted. The execution function never calls a forecaster.
// Fractional units, no leverage, no dividend or corporate actions, no slippage.
// Keep the position overnight; at the next open rebalance, then mark at close.
// End with a mark-to-market valuation, not an assumed final sale.
export function runNextOpenPractice(plan) {
  if(!exact(plan,['mode','initial_close','risk_fraction','sessions']) || plan.mode!==MODE ||
     !price(plan.initial_close) || !number(plan.risk_fraction,.05,1) ||
     !Array.isArray(plan.sessions) || plan.sessions.length!==DAYS)fail();
  for(const day of plan.sessions) {
    if(!exact(day,['open','close','signal']) || !price(day.open) || !price(day.close) ||
       !['LONG','CASH'].includes(day.signal))fail();
  }
  let cash=INITIAL, units=0, fees=0, trades=0, peak=INITIAL, maxDrawdown=0;
  const steps=[];
  const path=[INITIAL];
  function mark(p) {
    const total=cash+units*p;
    if(!number(total,0,Number.MAX_SAFE_INTEGER/10000))fail();
    peak=Math.max(peak,total);
    maxDrawdown=Math.max(maxDrawdown,1-total/peak);
    path.push(total);
    return total;
  }
  for(const {open,close,signal} of plan.sessions) {
    // Existing holdings bear the overnight gap. New holdings do not.
    const before=mark(open);
    const held=units*open;
    const target=signal==='LONG'?before*plan.risk_fraction:0;
    const diff=target-held;
    let gross=0, fee=0, side='NONE';
    if(diff>1e-8) {
      gross=Math.min(diff,cash/(1+FEE));
      if(gross>1e-8) {
        side='BUY'; fee=gross*FEE;
        cash-=gross+fee; units+=gross/open;
      } else gross=0;
    } else if(diff< -1e-8) {
      side='SELL'; gross=Math.min(-diff,held); fee=gross*FEE;
      cash+=gross-fee;
      units=target===0?0:Math.max(0,units-gross/open);
    }
    if(cash< -1e-7 || units<0 || !Number.isFinite(units))fail();
    if(cash<0)cash=0;
    if(side!=='NONE'){trades++;fees+=fee;}
    const after=mark(open);
    const end=mark(close);
    steps.push({signal,side,execution_price:side==='NONE'?null:open,gross,fee,
      equity_before_open_trade:before,equity_after_open_trade:after,equity_at_close:end,cash,units});
  }
  const final=path.at(-1);
  return {mode:MODE,real_market_history:false,score_allowed:false,holdout_evaluated:false,
    initial_coins:INITIAL,fee_rate:FEE,steps,fees,trades,final_coins:final,
    profit_coins:final-INITIAL,max_drawdown_pct:100*maxDrawdown,equity_path:path};
}
