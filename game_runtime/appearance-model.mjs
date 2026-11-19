import {createHash} from 'node:crypto';
import {APPROACHES, normalizeCompanionColor} from './companion.mjs';
import {validateLook} from './looks.mjs';
import {validateLabModel} from './model-lab.mjs';

export const APPEARANCE_MODEL_VERSION = /^appearance-v[1-9]\d{0,2}(?:_\d{1,3}){5}$/;
const APPEARANCE_RULE_VERSION = 'appearance-v1';
const HAIR_STYLE_SIGNAL = {bob:'trend', long:'reversion', twintails:'momentum'};
const ACCESSORY_SIGNAL = {ribbon:'momentum', glasses:'reversion', star:'volatility', none:null};
const EXPRESSION_RISK_PERCENT = {calm:32, cheerful:50, determined:68};

function versionFor(ruleVersion, {plugin_weights, risk_fraction}) {
  return ruleVersion + '_' + [...APPROACHES.map(id => plugin_weights[id]),
    Math.round(risk_fraction * 100)].join('_');
}

function rgb(value) {
  const hex = normalizeCompanionColor(value);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return {red, green, blue, chroma:Math.max(red, green, blue) - Math.min(red, green, blue),
    brightness:red + green + blue};
}

/** Derive the two engine settings controlled by the look and palette. */
export function deriveAppearanceModel(look, colors) {
  const {hair_style, expression, accessory} = validateLook(look);
  const hair = rgb(colors?.hair_color);
  const clothing = rgb(colors?.clothing_color);

  // Mix RGB channels and chroma continuously before rounding the weights.
  const scores = {
    trend:20*255 + 24*hair.blue + 16*clothing.blue,
    momentum:20*255 + 24*hair.red + 16*clothing.red,
    reversion:20*255 + 24*hair.green + 16*clothing.green,
    volatility:20*255 + 24*hair.chroma + 16*clothing.chroma,
  };
  scores[HAIR_STYLE_SIGNAL[hair_style]] += 32*255;
  const accessorySignal = ACCESSORY_SIGNAL[accessory];
  if (accessorySignal) scores[accessorySignal] += 24*255;

  // Round by largest remainder. Ties follow the fixed plugin order.
  const total = APPROACHES.reduce((sum, id) => sum + scores[id], 0);
  const shares = APPROACHES.map((id, order) => ({id, order,
    weight:Math.floor(100*scores[id] / total), remainder:100*scores[id] % total}));
  const pointsLeft = 100 - shares.reduce((sum, share) => sum + share.weight, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder || a.order - b.order).slice(0, pointsLeft)) {
    share.weight++;
  }
  const plugin_weights = Object.fromEntries(shares.map(({id, weight}) => [id, weight]));

  // Brightness moves the expression's baseline by at most ±25 percentage points.
  const brightness = (8*hair.brightness + 17*clothing.brightness) / (3*255);
  const riskPercent = EXPRESSION_RISK_PERCENT[expression] + Math.round(2*brightness - 25);

  // Bump the version when the mapping rules change. Identify the rounded settings.
  const model = {plugin_weights, risk_fraction:riskPercent / 100};
  return {model_version:versionFor(APPEARANCE_RULE_VERSION, model), model};
}

export function deriveForwardAppearanceModel(look, colors) {
  const {model_version, model} = deriveAppearanceModel(look, colors);
  // Use engine.Model() defaults for parameters outside the appearance rules.
  const plugin_strengths = Object.fromEntries(APPROACHES.map(id => [id, 100]));
  return {model_version, model:{fast_window:3, slow_window:9, ...model, plugin_strengths}};
}

export function identifyForwardAppearanceModel({model_version, model}) {
  model = validateLabModel(model);
  if (typeof model_version !== 'string' || !APPEARANCE_MODEL_VERSION.test(model_version)) {
    throw new RangeError('外見モデル版が不正です');
  }
  const ruleVersion = model_version.split('_')[0];
  if (model_version !== versionFor(ruleVersion, model) ||
      model.risk_fraction !== Math.round(model.risk_fraction * 100) / 100) {
    throw new RangeError('外見モデル版と予測設定が一致しません');
  }
  const modelHash = createHash('sha256').update(JSON.stringify({ruleVersion, model})).digest('hex');
  return {model_version, model, modelHash};
}
