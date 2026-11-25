/** Type contracts shared by the Python forecast bridge and the Node gameplay.
 * This file is compile-time only. Runtime inputs still require validation.
 */
export type CharacterSlot = 'mine' | 'owl' | 'turtle';
export type TradingSignal = 'LONG' | 'CASH';
export type PluginId = 'trend' | 'momentum' | 'volatility' | 'reversion';
export type Allocations = Record<CharacterSlot, number>;
export type StepSignals = Record<CharacterSlot, TradingSignal>;
export interface CharacterModel {
  risk_fraction: number;
  plugin_weights: Record<PluginId, number>;
  plugin_strengths: Record<PluginId, number>;
  effective_sha256: string;
}
export interface PracticePlan {
  mode: 'PRACTICE_SYNTHETIC_ONLY';
  allocations: Allocations;
  initial_coins: number;
  fee_rate: number;
  initial_price: number;
  future_prices: number[];
  signals: StepSignals[];
  mine_decision_trace?: Array<{
    method_supports: Partial<Record<'bollinger_breakout' | 'rsi_oversold' | 'macd_momentum' | 'moving_average_trend', number>>;
    baseline_up: number;
    combined_support: number;
    threshold: 0.54;
    signal: TradingSignal;
  }>;
  models: Record<CharacterSlot, CharacterModel>;
  model_sha256: string;
}
export interface GameWallet {
  cash: number;
  units: number;
  fees: number;
  trades: number;
  initial: number;
  long_steps: number;
}
export interface CharacterResult {
  allocation_pct: number;
  initial: number;
  final: number;
  fees: number;
  trades: number;
  long_steps: number;
  risk_fraction: number;
  plugin_weights: Record<PluginId, number>;
  plugin_strengths: Record<PluginId, number>;
  effective_sha256: string;
}
export interface PracticeResult {
  mode: 'PRACTICE_SYNTHETIC_ONLY';
  initial_coins: number;
  final_coins: number;
  profit_coins: number;
  return_pct: number;
  max_drawdown_pct: number;
  benchmark_buy_hold_pct: number;
  allocations: Allocations;
  cash_unallocated: number;
  steps: number;
  fee_rate_pct: number;
  equity_path: number[];
  benchmark_path: number[];
  decisions: Array<{step: number; price: number; signals: StepSignals}>;
  characters: Record<CharacterSlot, CharacterResult>;
  model_sha256: string;
  warnings: string[];
}
