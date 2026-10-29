"""Visual-only 2D layers. Never writes drafts, models, or game state."""
import base64
import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from threading import Lock

import blueprints as bp

STORE_FILE = Path(__file__).resolve().parent / 'local_state' / 'looks2d.json'
MAX_REQUEST_BYTES = 1536 * 1024
MAX_LOOKS = 50
MAX_TOTAL_BYTES = 20 * 1024 * 1024
LOCK = Lock()
NOTICE = '外見だけの変更。予測性能は変わりません。'


def _paths():
    assets = STORE_FILE.parent / 'looks2d_assets'
    if any(p.is_symlink() for p in (STORE_FILE, assets, *STORE_FILE.parents)):
        raise bp.BlueprintError('外見保存先が不正です。', 500)
    return assets


def _number(value, low, high):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('range')
    return value


def _read():
    assets = _paths()
    try:
        files = list(assets.iterdir()) if assets.exists() else []
        if any(p.is_symlink() or not p.is_file() for p in files):
            raise ValueError('assets')
        for path in files:
            if (not re.fullmatch(r'acc_[a-f0-9]{64}\.image', path.name)
                    or path.stat().st_size > bp.MAX_IMAGE_BYTES
                    or hashlib.sha256(path.read_bytes()).hexdigest() != path.name[4:-6]):
                raise ValueError('asset integrity')
        if sum(p.stat().st_size for p in files) + (STORE_FILE.stat().st_size if STORE_FILE.exists() else 0) > MAX_TOTAL_BYTES:
            raise ValueError('quota')
        if not STORE_FILE.exists():
            return {}
        if STORE_FILE.stat().st_size > 128 * 1024:
            raise ValueError('size')
        raw = json.loads(STORE_FILE.read_text(encoding='utf-8'))
        if type(raw.get('schema')) is not int or raw['schema'] != 1 or set(raw) != {'schema', 'looks'}:
            raise ValueError('schema')
        looks = raw['looks']
        if not isinstance(looks, dict) or len(looks) > MAX_LOOKS:
            raise ValueError('looks')
        for draft_id, look in looks.items():
            bp.validate_id(draft_id)
            if (set(look) != {'schema', 'draft_id', 'layers'} or type(look['schema']) is not int
                    or look['schema'] != 1 or look['draft_id'] != draft_id
                    or not isinstance(look['layers'], list) or len(look['layers']) > 1):
                raise ValueError('look')
            for layer in look['layers']:
                if set(layer) != {'asset_id', 'z', 'position_x_pct', 'position_y_pct', 'scale_pct', 'visible', 'media_type', 'bytes'}:
                    raise ValueError('layer')
                if not isinstance(layer['asset_id'], str) or not re.fullmatch(r'acc_[a-f0-9]{64}', layer['asset_id']):
                    raise ValueError('asset')
                if type(layer['z']) is not int or layer['z'] != 1 or type(layer['visible']) is not bool:
                    raise ValueError('display')
                _number(layer['position_x_pct'], -100, 100)
                _number(layer['position_y_pct'], -100, 100)
                _number(layer['scale_pct'], 10, 200)
                path = assets / (layer['asset_id'] + '.image')
                if type(layer['bytes']) is not int or not 0 < layer['bytes'] <= bp.MAX_IMAGE_BYTES:
                    raise ValueError('bytes')
                if path.is_symlink() or path.stat().st_size != layer['bytes']:
                    raise ValueError('file')
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != layer['asset_id'][4:]:
                    raise ValueError('hash')
                bp.validate_image('data:' + layer['media_type'] + ';base64,' + base64.b64encode(data).decode())
        return looks
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError) as exc:
        raise bp.BlueprintError('外見保存データを読み取れません。上書きせず停止しました。', 500) from exc


def read_look(draft_id):
    bp.read_drafts(bp.validate_id(draft_id))
    with LOCK:
        look = _read().get(draft_id, {'schema': 1, 'draft_id': draft_id, 'layers': []})
    return {'look': look, 'notice': NOTICE}


def read_accessory(draft_id):
    bp.read_drafts(bp.validate_id(draft_id))
    with LOCK:
        look = _read().get(draft_id)
        if not look or not look['layers']:
            raise bp.BlueprintError('アクセサリーはありません。', 404)
        layer = look['layers'][0]
        return layer['media_type'], (_paths() / (layer['asset_id'] + '.image')).read_bytes()


def save_look(payload):
    fields = {'draft_id', 'accessory_data_uri', 'position_x_pct', 'position_y_pct', 'scale_pct', 'visible'}
    if not isinstance(payload, dict) or set(payload) - fields or 'draft_id' not in payload:
        raise bp.BlueprintError('外見設定が不正です。')
    draft_id = payload['draft_id']
    bp.read_drafts(bp.validate_id(draft_id))
    try:
        settings = {key: _number(payload.get(key, default), low, high) for key, default, low, high in (
            ('position_x_pct', 0, -100, 100), ('position_y_pct', 0, -100, 100), ('scale_pct', 100, 10, 200))}
        visible = payload.get('visible', True)
        if type(visible) is not bool:
            raise ValueError('visible')
    except ValueError as exc:
        raise bp.BlueprintError('位置・サイズ・表示設定が不正です。') from exc
    image = bp.validate_image(payload.get('accessory_data_uri'))
    with LOCK:
        looks = _read()
        if draft_id not in looks and len(looks) >= MAX_LOOKS:
            raise bp.BlueprintError('外見の保存上限50件です。', 413)
        assets = _paths()
        layers = looks.get(draft_id, {}).get('layers', [])
        layer = dict(layers[0]) if layers else None
        if image:
            layer = dict(asset_id='acc_' + hashlib.sha256(image[1]).hexdigest(), media_type=image[0], bytes=len(image[1]))
        if layer:
            layer.update(settings, visible=visible, z=1)
        look = dict(schema=1, draft_id=draft_id, layers=[layer] if layer else [])
        target = assets / (layer['asset_id'] + '.image') if image else None
        total = sum(p.stat().st_size for p in assets.iterdir()) if assets.exists() else 0
        # Include metadata and temporary replacement image in the physical quota.
        encoded = json.dumps({'schema': 1, 'looks': {**looks, draft_id: look}}, ensure_ascii=False).encode()
        if total + len(encoded) + (len(image[1]) if target and not target.exists() else 0) > MAX_TOTAL_BYTES:
            raise bp.BlueprintError('外見の合計保存上限20 MiBです。', 413)
        temp_name = None
        created = False
        try:
            STORE_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if target and not target.exists():
                assets.mkdir(exist_ok=True, mode=0o700)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                created = True
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(image[1]); stream.flush(); os.fsync(stream.fileno())
            with tempfile.NamedTemporaryFile(dir=STORE_FILE.parent, prefix='.looks2d-', delete=False) as stream:
                temp_name = stream.name
                stream.write(encoded); stream.flush(); os.fsync(stream.fileno())
            os.replace(temp_name, STORE_FILE)
        except OSError as exc:
            if created:
                target.unlink(missing_ok=True)
            raise bp.BlueprintError('外見を保存できませんでした。', 500) from exc
        finally:
            if temp_name:
                Path(temp_name).unlink(missing_ok=True)
        # Only remove our now-unreferenced immutable accessory files after commit.
        used = {l['asset_id'] + '.image' for v in {**looks, draft_id: look}.values() for l in v['layers']}
        if assets.exists():
            for path in assets.iterdir():
                if re.fullmatch(r'acc_[a-f0-9]{64}\.image', path.name) and path.name not in used:
                    try:
                        path.unlink()
                    except OSError:
                        pass
    return {'look': look, 'notice': NOTICE}
