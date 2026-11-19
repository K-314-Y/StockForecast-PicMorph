import {createHash} from 'node:crypto';
import {APPEARANCE_MODEL_VERSION, identifyForwardAppearanceModel} from './appearance-model.mjs';
import {APPROACHES} from './companion.mjs';
import {validateLabModel} from './model-lab.mjs';

export const COMPANION_MODEL_VERSION = /^companion-v1(?:_\d{1,3}){5}$/;

export function isForwardModelVersion(value) {
  return typeof value === 'string' &&
    (COMPANION_MODEL_VERSION.test(value) || APPEARANCE_MODEL_VERSION.test(value));
}

export function deriveForwardCompanionModel({approach, risk_percent}) {
  if (!APPROACHES.includes(approach) || !Number.isInteger(risk_percent) ||
      risk_percent < 5 || risk_percent > 100 || risk_percent % 5 !== 0) {
    throw new RangeError('保存済みの判断ルールが不正です');
  }
  const model = validateLabModel({fast_window:3, slow_window:9, risk_fraction:risk_percent / 100,
    plugin_weights:Object.fromEntries(APPROACHES.map(id => [id, id === approach ? 100 : 0])),
    plugin_strengths:Object.fromEntries(APPROACHES.map(id => [id, 100])),
  });
  const ruleVersion = 'companion-v1';
  const model_version = ruleVersion + '_' + [...APPROACHES.map(id => model.plugin_weights[id]), risk_percent].join('_');
  const modelHash = createHash('sha256').update(JSON.stringify({ruleVersion, model})).digest('hex');
  return {model_version, model, modelHash};
}

export function identifyForwardModel({model_version, model}) {
  if (typeof model_version === 'string' && APPEARANCE_MODEL_VERSION.test(model_version)) {
    return identifyForwardAppearanceModel({model_version, model});
  }
  const saved = validateLabModel(model);
  const frozen = deriveForwardCompanionModel({
    approach:APPROACHES.find(id => saved.plugin_weights[id] === 100),
    risk_percent:Math.round(saved.risk_fraction * 100),
  });
  if (frozen.model_version !== model_version || JSON.stringify(frozen.model) !== JSON.stringify(saved)) {
    throw new RangeError('モデル版と予測設定が一致しません');
  }
  return frozen;
}
