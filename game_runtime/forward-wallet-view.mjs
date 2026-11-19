import {MOCK_MARKET_PAPER_MODE} from './forward-market-guard.mjs';
import {inspectForwardWallet} from './forward-paper.mjs';
import {FORWARD_STARTING_MEDALS, requireForwardGameWalletMode} from './forward-store.mjs';

export function forwardWalletState(snapshot, created = false) {
  const {revision = null, ledger} = snapshot ?? {};
  if (ledger) requireForwardGameWalletMode(ledger.mode);
  const generations = ledger?.appearanceGenerations ?? [];
  return {
    mode:'FORWARD_WALLETS_MARKET_UNCONNECTED', revision, created,
    initialMedals:ledger?.initialMedals ?? FORWARD_STARTING_MEDALS,
    unallocated:ledger?.unallocated ?? FORWARD_STARTING_MEDALS,
    currentAiId:generations.at(-1)?.aiId ?? null,
    generations, wallets:ledger?.wallets ?? {},
  };
}

export function forwardWalletSummary(snapshot, created = false) {
  const state = forwardWalletState(snapshot, created);
  const ledger = snapshot?.ledger;
  return {...state, mock:ledger?.mode === MOCK_MARKET_PAPER_MODE,
    generations:state.generations.map(({aiId, model_version}) => ({aiId, model_version})),
    wallets:Object.fromEntries(Object.keys(state.wallets).map(aiId => {
      const {cash, equity, status, position} = inspectForwardWallet(ledger, aiId);
      return [aiId, {cash, equity, status, position:position ?
        {symbol:position.symbol, direction:position.direction} : null}];
    })),
  };
}
