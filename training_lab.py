"""Bounded stdlib learning on the fixed fictional series; never a game model.

Only saved declarative blueprints enter the public API. Internal sample helpers
accept prices for causality tests, but no HTTP input can supply data or code.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

import blueprints
from challenge import actual_direction, FLAT_BAND
from engine import Model, PLUGIN_IDS, SYNTHETIC_PRICES, prediction_components, multiclass_brier

STORE_FILE = Path(__file__).resolve().parent / 'local_state' / 'trained_versions.json'
MAX_REQUEST_BYTES = 8192
MAX_VERSIONS = 100
LOCK = Lock()
NOTICE = '固定架空40点での学習演習。実相場の能力を証明しない。検証期間は選択に使わない。'
TRAIN_INDICES = tuple(range(20, 32))
VALIDATION_INDICES = tuple(range(32, 39))
KEYS = ('UP', 'FLAT', 'DOWN')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def model_from_parameters(parameters):
    if (not isinstance(parameters, dict) or set(parameters) != {
            'fast_window', 'slow_window', 'risk_fraction', 'plugin_weights', 'plugin_strengths'}):
        raise ValueError('モデル設定が不正です')
    for field in ('plugin_weights', 'plugin_strengths'):
        if not isinstance(parameters[field], dict) or set(parameters[field]) != set(PLUGIN_IDS):
            raise ValueError('登録済み指標だけ指定できます')
    return Model(parameters['fast_window'], parameters['slow_window'], parameters['risk_fraction'],
                 tuple(parameters['plugin_weights'][k] for k in PLUGIN_IDS),
                 tuple(parameters['plugin_strengths'][k] for k in PLUGIN_IDS))


def parameters(model):
    return dict(fast_window=model.fast_window, slow_window=model.slow_window,
                risk_fraction=model.risk_fraction,
                plugin_weights=dict(zip(PLUGIN_IDS, model.plugin_weights)),
                plugin_strengths=dict(zip(PLUGIN_IDS, model.plugin_strengths)))


def samples(model, prices, indices):
    rows = []
    for index in indices:
        # Generate features BEFORE reading the next observation or its label.
        parts = prediction_components(model, tuple(prices[:index + 1]))
        label = actual_direction(prices[index], prices[index + 1])
        rows.append(dict(index=index, target_index=index + 1, components=parts, actual=label))
    return rows


def mixture(weights, parts):
    result = {key: sum(w * parts[name][key] / 100 for name, w in zip(PLUGIN_IDS, weights))
              for key in ('UP', 'FLAT')}
    result['DOWN'] = max(0.0, 1 - result['UP'] - result['FLAT'])
    return result


def score(weights, rows):
    return sum(multiclass_brier(row['actual'], mixture(weights, row['components']))
               for row in rows) / len(rows)


def grid():
    # C(8,3) = 56; registry changes require an explicit new training protocol.
    if len(PLUGIN_IDS) != 4 or set(PLUGIN_IDS) != {'trend', 'momentum', 'volatility', 'reversion'}:
        raise blueprints.BlueprintError('学習演習は登録済み4指標にのみ対応しています。', 503)
    return [(a, b, c, 100-a-b-c) for a in range(0, 101, 20)
            for b in range(0, 101-a, 20) for c in range(0, 101-a-b, 20)]


def select_weights(model, training, candidates=None):
    return min(grid() if candidates is None else candidates, key=lambda weights: (
        score(weights, training),
        sum(abs(a-b) for a, b in zip(weights, model.plugin_weights)), weights))


def _preview(payload):
    if not isinstance(payload, dict) or set(payload) != {'draft_id'}:
        raise blueprints.BlueprintError('保存したdraft_idだけ指定してください。')
    draft_id = blueprints.validate_id(payload['draft_id'])
    draft = blueprints.read_drafts(draft_id)['draft']
    try:
        blueprint = draft['blueprint']
        if blueprint['kind'] != 'indicator_composition_v1':
            raise ValueError()
        model = model_from_parameters(blueprint['engine_parameters'])
        training = samples(model, SYNTHETIC_PRICES, TRAIN_INDICES)
        candidates = grid()
        if draft.get('generator', {}).get('kind') == 'manual_parts_v1':
            candidates = [w for w in candidates if all(
                initial > 0 or fitted == 0 for initial, fitted in zip(model.plugin_weights, w))]
        weights = select_weights(model, training, candidates)
        selected = Model(model.fast_window, model.slow_window, model.risk_fraction,
                         weights, model.plugin_strengths)
        # Validation is constructed only after the chosen weights are fixed.
        validation = samples(model, SYNTHETIC_PRICES, VALIDATION_INDICES)
        dataset = dict(id='engine.SYNTHETIC_PRICES', kind='fixed_fictional', points=40,
                       sha256=digest(SYNTHETIC_PRICES), index_base=0,
                       prefix='prices[0:index+1]', target='index+1', flat_band=FLAT_BAND,
                       train_indices=list(TRAIN_INDICES), validation_indices=list(VALIDATION_INDICES),
                       train_labels=[r['actual'] for r in training],
                       validation_labels=[r['actual'] for r in validation])
        result = dict(source_draft_id=draft['id'], source_draft_sha256=digest(draft),
                      engine_parameters=parameters(selected), parameters_sha256=digest(parameters(selected)),
                      dataset=dataset, trained_until=32, last_training_decision_index=31,
                      competition_eligible=False, notice=NOTICE,
                      training_job=dict(method='constrained_grid_v1', objective='mean_multiclass_brier',
                                        candidate_count=len(candidates), weight_step=20,
                                        tie_break='exact objective, L1 distance to draft, lexicographic registry order',
                                        indicator_order=list(PLUGIN_IDS), validation_used_for_selection=False),
                      scores=dict(training_count=len(training), validation_count=len(validation),
                                  trained_train_brier=score(weights, training),
                                  trained_validation_brier=score(weights, validation),
                                  original_train_brier=score(model.plugin_weights, training),
                                  original_validation_brier=score(model.plugin_weights, validation),
                                  uniform_brier=2/3))
    except (ValueError, KeyError, TypeError, OverflowError) as exc:
        raise blueprints.BlueprintError('保存された下書きのモデルが不正です。') from exc
    return result


def train_preview(payload):
    """Read-only: no directories, files, job records, or game state are written."""
    return _preview(payload)


def _read():
    if any(p.is_symlink() for p in (STORE_FILE, *STORE_FILE.parents)):
        raise blueprints.BlueprintError('練習版保存先が不正です。', 500)
    if not STORE_FILE.exists():
        return {'schema': 1, 'versions': [], 'jobs': []}
    try:
        if STORE_FILE.stat().st_size > MAX_VERSIONS * 32768:
            raise ValueError()
        data = json.loads(STORE_FILE.read_text(encoding='utf-8'))
        if (data['schema'] != 1 or not isinstance(data['versions'], list)
                or not isinstance(data['jobs'], list) or len(data['versions']) > MAX_VERSIONS
                or len(data['jobs']) != len(data['versions'])):
            raise ValueError()
        for version in data['versions']:
            if version['competition_eligible'] is not False or version['status'] != 'practice_only':
                raise ValueError()
            _metadata(version)
        return data
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise blueprints.BlueprintError('練習版保存データを読み取れません。上書きせず停止しました。', 500) from exc


def _metadata(version):
    # Explicit allowlist: neither image nor model/source code is returned here.
    return {k: version[k] for k in ('id', 'source_draft_id', 'created_at', 'status',
                                    'competition_eligible', 'trained_until', 'source_draft_sha256',
                                    'parameters_sha256', 'dataset_sha256')}


def read_trained():
    with LOCK:
        data = _read()
    return dict(versions=[_metadata(v) for v in reversed(data['versions'])],
                limit=MAX_VERSIONS, notice=NOTICE)


def train_save(payload):
    # Recompute from immutable source; never trust client-supplied fitted weights.
    result = _preview(payload)
    now = datetime.now(timezone.utc).isoformat()
    job_id = 'tj_' + uuid.uuid4().hex
    version = dict(id='tv_' + uuid.uuid4().hex, created_at=now, status='practice_only',
                   competition_eligible=False, training_job_id=job_id,
                   **{k: result[k] for k in ('source_draft_id', 'source_draft_sha256',
                                             'engine_parameters', 'parameters_sha256', 'trained_until')},
                   dataset_sha256=result['dataset']['sha256'])
    job = dict(id=job_id, created_at=now, version_id=version['id'],
               **{k: result[k] for k in ('training_job', 'scores', 'dataset', 'notice')})
    with LOCK:
        data = _read()
        if len(data['versions']) >= MAX_VERSIONS:
            raise blueprints.BlueprintError('練習版の保存上限100件に達しました。', 413)
        temp_name = None
        try:
            STORE_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=STORE_FILE.parent,
                                             prefix='.trained-', delete=False) as stream:
                temp_name = stream.name
                json.dump(dict(schema=1, versions=data['versions'] + [version],
                               jobs=data['jobs'] + [job]), stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, STORE_FILE)
        except OSError as exc:
            raise blueprints.BlueprintError('練習版を保存できませんでした。', 500) from exc
        finally:
            if temp_name:
                Path(temp_name).unlink(missing_ok=True)
    return dict(version=_metadata(version), notice=NOTICE)
