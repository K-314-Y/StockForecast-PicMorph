/** This file is never executed. It catches incompatible plan shapes in CI. */
import type {PracticePlan, TradingSignal, CharacterSlot} from './contracts.js';
declare const plan: PracticePlan;
const signal: TradingSignal = plan.signals[0]!.mine;
const slot: CharacterSlot = 'mine';
void signal;
void slot;
// @ts-expect-error Invalid signal cannot become a model decision.
const invalidSignal: TradingSignal = 'SELL';
void invalidSignal;
// @ts-expect-error Allocation requires all three slots.
const invalidAllocation: PracticePlan['allocations'] = {mine: 100};
void invalidAllocation;
// @ts-expect-error Practice mode must not be labelled as live performance.
const invalidMode: PracticePlan['mode'] = 'LIVE_TRADING';
void invalidMode;
