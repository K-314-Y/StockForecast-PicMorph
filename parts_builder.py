"""Versioned declarative parts. No paths, images, uploads or executable code."""
from copy import deepcopy
from datetime import datetime, timezone
import uuid

import blueprints as bp
from engine import Model, prediction
from indicators import REGISTRY

MAX_REQUEST_BYTES = 8192
NOTICE = '固定架空データで動きを試す設計演習です。実相場の精度・優位性を示しません。外見は予測に使いません。'
IDS = tuple(s.id for s in REGISTRY)
PART_CATALOG = [
    dict(part_id='window:' + key, kind='window', version=1, name=name,
         explanation=f'短期{fast}点・長期{slow}点を観測します。',
         config=dict(fast_window=fast, slow_window=slow))
    for key, name, fast, slow in [('short', 'すばやいコア', 3, 9),
                                 ('balanced', 'バランスコア', 5, 12), ('patient', 'じっくりコア', 8, 20)]
] + [dict(part_id='risk:' + key, kind='risk', version=1, name=name,
          explanation=f'仮想配分比率{risk:.0%}。予測確率自体は変わりません。', config=dict(risk_fraction=risk))
     for key, name, risk in [('cautious', '慎重', .20), ('normal', 'ふつう', .35), ('aggressive', '積極的', .65)]
] + [dict(part_id='indicator:' + s.id, kind='builtin_indicator', version=1,
          name=s.name, explanation=s.description, config=dict(indicator_id=s.id)) for s in REGISTRY]
FIXTURES = (
    ('上り坂', tuple(100 + i for i in range(24))),
    ('静かな湖', tuple(100 + i % 2 for i in range(24))),
    ('下り坂', tuple(124 - i for i in range(24))),
)


def catalog():
    return dict(schema=1, parts=deepcopy(PART_CATALOG), notice=NOTICE)


def compile_loadout(payload):
    allowed = {'name', 'concept', 'window_part_id', 'risk_part_id', 'analysis'}
    if type(payload) is not dict or set(payload) - allowed or not allowed - {'concept'} <= set(payload):
        raise bp.BlueprintError('対応する名前・コア・分析パーツだけ指定してください。')
    name = bp._text(payload['name'], '名前', 60, required=True)
    concept = bp._text(payload.get('concept', ''), '設定', 300)
    lookup = {p['part_id']: p for p in PART_CATALOG}
    cores = []
    for field, kind in [('window_part_id', 'window'), ('risk_part_id', 'risk')]:
        key = payload[field]
        if type(key) is not str or key not in lookup or lookup[key]['kind'] != kind:
            raise bp.BlueprintError('登録済みのコアを選んでください。')
        cores.append(deepcopy(lookup[key]))
    analysis = payload['analysis']
    if type(analysis) is not list or not 2 <= len(analysis) <= 4:
        raise bp.BlueprintError('分析パーツは2〜4個選んでください。')
    equipped = {}
    for row in analysis:
        if type(row) is not dict or set(row) != {'part_id', 'share', 'strength'}:
            raise bp.BlueprintError('分析パーツの指定が不正です。')
        key = row['part_id']
        if (type(key) is not str or key not in lookup or lookup[key]['kind'] != 'builtin_indicator'
                or key in equipped):
            raise bp.BlueprintError('分析パーツは登録済みIDを重複せず指定してください。')
        for field, low, high in [('share', 1, 100), ('strength', 50, 150)]:
            if type(row[field]) is not int or not low <= row[field] <= high:
                raise bp.BlueprintError('配分は整数1〜100、感度は整数50〜150です。')
        equipped[key] = row
    shares = [equipped.get('indicator:' + k, {}).get('share', 0) for k in IDS]
    total = sum(shares)
    weights = [100 * v // total for v in shares]
    order = sorted(range(len(IDS)), key=lambda i: (-(100 * shares[i] % total), i))
    for i in order[:100 - sum(weights)]:
        weights[i] += 1
    strengths = [equipped.get('indicator:' + k, {}).get('strength', 100) for k in IDS]
    model = Model(**cores[0]['config'], **cores[1]['config'],
                  plugin_weights=tuple(weights), plugin_strengths=tuple(strengths))
    parts = cores + [dict(deepcopy(lookup['indicator:' + k]),
                          share=equipped['indicator:' + k]['share'], strength=strengths[i])
                     for i, k in enumerate(IDS) if 'indicator:' + k in equipped]
    params = dict(fast_window=model.fast_window, slow_window=model.slow_window, risk_fraction=model.risk_fraction,
                  plugin_weights=dict(zip(IDS, weights)), plugin_strengths=dict(zip(IDS, strengths)))
    return dict(schema=1, compiler_version=1, name=name, concept=concept, parts=parts,
                engine_parameters=params, summary=' / '.join(f'{k} {w}%' for k, w in zip(IDS, weights)),
                interop=dict(protocol='parts_assembly_v1', indicator_order=list(IDS),
                             code_parts_supported=False, future_code_identity='namespace:name@version'))


def preview(payload):
    compiled = compile_loadout(payload)
    p = compiled['engine_parameters']
    model = Model(p['fast_window'], p['slow_window'], p['risk_fraction'],
                  tuple(p['plugin_weights'][k] for k in IDS), tuple(p['plugin_strengths'][k] for k in IDS))
    fixtures = []
    for name, observations in FIXTURES:
        probabilities = prediction(model, observations)
        fixtures.append(dict(name=name, observed_points=len(observations), target_index=len(observations),
                             probabilities=probabilities, predicted=max(probabilities, key=probabilities.get)))
    return dict(compiled=compiled, fixtures=fixtures, notice=NOTICE)


def create_draft(payload):
    c = compile_loadout(payload)
    indicators = [p for p in c['parts'] if p['kind'] == 'builtin_indicator']
    draft = dict(schema=1, id='bp_' + uuid.uuid4().hex, created_at=datetime.now(timezone.utc).isoformat(),
                 notice=NOTICE, generator=dict(kind='manual_parts_v1', version=1, vision_used=False, text_analysis_used=False),
                 user_declared=dict(name=c['name'], concept=c['concept'], style='', trait='balanced'),
                 candidate_id='manual_parts_v1', title=c['name'], reasoning=c['summary'],
                 capacity_parts=[dict(id=p['part_id'], kind=p['kind'], indicator_id=p['config']['indicator_id'], name=p['name']) for p in indicators],
                 blueprint=dict(kind='indicator_composition_v1', capacity_part_ids=[p['part_id'] for p in indicators],
                                engine_parameters=c['engine_parameters']),
                 parts_assembly=c, visual_asset=None, status='draft', training_job=None,
                 deployed_model_version=None, competition_eligible=False)
    return bp._persist_draft(draft)
