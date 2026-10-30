"""Isolated, bounded character PACK v1 converter. No game/state dependencies."""
import ctypes
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile
import warnings

from PIL import Image, ImageChops, ImageCms, PngImagePlugin

MAX_SOURCE = 20 * 1024 * 1024
MAX_OUTPUT = 300 * 1024 * 1024
MAX_SIDE = 4096
MAX_LAYERS = 64
MAX_MANIFEST = 128 * 1024


class PackError(ValueError):
    """Invalid, unsupported, or over-budget local pack."""


def dimensions(width, height):
    if any(type(v) is not int or not 1 <= v <= MAX_SIDE for v in (width, height)):
        raise PackError('Canvas must be 1..4096 pixels on each side.')
    return width, height


def local_path(value):
    if not isinstance(value, (str, os.PathLike)) or '://' in str(value):
        raise PackError('Only local filesystem paths are accepted.')
    path = Path(os.path.abspath(value))
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise PackError('Symlinks are not accepted in input/output paths.')
    return path


def read_bounded(path, limit):
    if not path.is_file() or path.stat().st_size > limit:
        raise PackError(f'Expected regular file of at most {limit} bytes: {path.name}')
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise PackError('File exceeds byte limit.')
    return data


def decode(data, formats=('PNG', 'JPEG', 'WEBP')):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                dimensions(*image.size)
                if image.format not in formats or getattr(image, 'n_frames', 1) != 1:
                    raise PackError('Only single-frame PNG, JPEG or WebP images are supported.')
                image.load()  # actual decode, not just signature validation
                profile = image.info.get('icc_profile')
                if profile:
                    try:
                        return ImageCms.profileToProfile(image, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                                                         ImageCms.createProfile('sRGB'), outputMode='RGBA')
                    except (OSError, ValueError, ImageCms.PyCMSError) as exc:
                        raise PackError('Cannot normalize embedded color profile to sRGB.') from exc
                return image.convert('RGBA')
    except (OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise PackError('Image cannot be safely decoded.') from exc


def _psd(data):
    # Bound the header before handing anything to the optional parser.
    if len(data) < 26 or data[:6] != b'8BPS\x00\x01':
        raise PackError('Invalid PSD v1 header.')
    height, width = struct.unpack('>II', data[14:22])
    dimensions(width, height)
    try:
        from psd_tools import PSDImage
    except ImportError as exc:
        raise PackError('PSD import requires optional psd-tools (target API: 1.26); it is not installed. Use a PNG export instead.') from exc
    try:
        psd = PSDImage.open(io.BytesIO(data))
        if psd.size != (width, height):
            raise PackError('PSD header/canvas mismatch.')
        count = 0
        def inspect(nodes):
            nonlocal count
            for node in nodes:
                count += 1
                if count > MAX_LAYERS:
                    raise PackError('PSD exceeds 64 layers including groups.')
                bbox = node.bbox
                if (len(bbox) != 4 or any(type(v) is not int or abs(v) > 8192 for v in bbox)
                        or not 0 <= bbox[2] - bbox[0] <= MAX_SIDE
                        or not 0 <= bbox[3] - bbox[1] <= MAX_SIDE):
                    raise PackError('PSD layer bounds exceed safe limits; export a merged PNG.')
                blend = getattr(node.blend_mode, 'value', node.blend_mode)
                if blend not in (b'norm', b'pass', 'normal', 'pass_through') or getattr(node, 'clipping', False) or getattr(node, 'has_effects', lambda: False)():
                    raise PackError('Unsupported complex PSD: blend modes, clipping or effects. Export a merged PNG; masks on normal layers are supported where psd-tools can composite them.')
                if node.is_group():
                    inspect(node)
        inspect(psd)
        reference = psd.composite()
        if reference is None:
            raise PackError('PSD has no merged composite.')
        reference = reference.convert('RGBA')
        if reference.size != (width, height):
            raise PackError('PSD composite dimensions mismatch.')
        return reference, psd
    except PackError:
        raise
    except Exception as exc:
        raise PackError('PSD parsing/compositing failed; export a merged PNG instead.') from exc


def _publish_new(stage, output):
    """Linux atomic directory publication with NOREPLACE, including racing creators."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise PackError('Atomic no-overwrite publication requires Linux renameat2.')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(stage), -100, os.fsencode(output), 1):
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise PackError('Output already exists; refusing overwrite.')
        raise OSError(code, os.strerror(code))


def convert(source, output):
    """Write a NEW directory atomically from a local raster/PSD. Return manifest."""
    source, output = local_path(source), local_path(output)
    if output.exists() or not output.parent.is_dir():
        raise PackError('Output must be a NEW directory with an existing parent.')
    data = read_bounded(source, MAX_SOURCE)
    is_psd = data[:4] == b'8BPS' or source.suffix.lower() == '.psd'
    original, psd = _psd(data) if is_psd else (decode(data), None)
    stage = Path(tempfile.mkdtemp(prefix='.' + output.name + '-', dir=output.parent))
    try:
        (stage / 'parts').mkdir()
        total = 0
        def write(name, blob):
            nonlocal total
            total += len(blob)
            if total > MAX_OUTPUT:
                raise PackError('Pack exceeds 300 MiB output budget.')
            (stage / name).write_bytes(blob)
        def png(name, image):
            buf = io.BytesIO()
            metadata = PngImagePlugin.PngInfo()
            metadata.add(b'sRGB', b'\x00')
            image.save(buf, format='PNG', pnginfo=metadata)
            write(name, buf.getvalue())
        png('original.png', original)
        manifest = dict(manifest_version=1, canvas=dict(width=original.width, height=original.height),
                        source=dict(kind='psd' if is_psd else 'image', sha256=hashlib.sha256(data).hexdigest()),
                        mode_default='fallback', layers=[], warnings=[])
        composite = Image.new('RGBA', original.size)
        nodes = list(psd) if psd is not None else [None]
        if (len(nodes) + 2) * original.width * original.height * 4 > MAX_OUTPUT:
            raise PackError('Decoded pack surfaces exceed 300 MiB budget.')
        for node in nodes:  # psd-tools order: bottom to top. Groups flatten ONCE.
            if len(manifest['layers']) >= MAX_LAYERS:
                raise PackError('Pack exceeds 64 layers.')
            visible = node.is_visible() if node is not None else True
            layer = Image.new('RGBA', original.size)
            if node is None:
                layer = original.copy()
            else:
                try:
                    part = node.composite()
                except Exception as exc:
                    raise PackError('PSD layer composite failed; export a merged PNG instead.') from exc
                if part is not None:
                    dimensions(*part.size)
                    layer.paste(part.convert('RGBA'), (node.bbox[0], node.bbox[1]))
            index = len(manifest['layers'])
            name = f'parts/layer_{index:02d}.png'
            png(name, layer)
            manifest['layers'].append(dict(id=f'layer_{index:02d}', slot='unclassified', path=name, z=index, visible=visible))
            if visible:
                composite.alpha_composite(layer)
        if is_psd:
            write('source.psd', data)
            if ImageChops.difference(composite, original).getbbox(alpha_only=False):
                manifest['warnings'].append('Layer composite differs from merged PSD reference (blend/opacity/mask/color support may differ). Use fallback for the reference; PSD fidelity is not guaranteed.')
        write('manifest.json', (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2)+'\n').encode())
        # Re-read our artifact with the same public validator before publication.
        load_pack(stage)
        if output.exists() or output.is_symlink():
            raise PackError('Output appeared during conversion; refusing overwrite.')
        _publish_new(stage, output)
        return manifest
    except (OSError, ValueError) as exc:
        if isinstance(exc, PackError):
            raise
        raise PackError(f'Pack conversion failed: {exc}') from exc
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def validate_manifest(manifest):
    try:
        if type(manifest['manifest_version']) is not int or manifest['manifest_version'] != 1:
            raise PackError('Unsupported manifest version.')
        size = dimensions(manifest['canvas']['width'], manifest['canvas']['height'])
        if manifest['mode_default'] not in ('fallback', 'layers'):
            raise PackError('Invalid mode.')
        if manifest['source']['kind'] not in ('image', 'psd') or not re.fullmatch('[a-f0-9]{64}', manifest['source']['sha256']):
            raise PackError('Invalid source metadata.')
        layers = manifest['layers']
        if not isinstance(layers, list) or not 1 <= len(layers) <= MAX_LAYERS:
            raise PackError('Expected 1..64 layers.')
        ids, paths, zs = set(), set(), set()
        for layer in layers:
            if (not re.fullmatch(r'parts/[A-Za-z0-9_-]+\.png', layer['path'])
                    or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', layer['id'])
                    or not isinstance(layer['slot'], str) or not 1 <= len(layer['slot']) <= 64
                    or type(layer['visible']) is not bool or type(layer['z']) is not int
                    or abs(layer['z']) > 1000000
                    or layer['id'] in ids or layer['path'] in paths or layer['z'] in zs):
                raise PackError('Invalid/duplicate layer metadata or unsafe asset path.')
            ids.add(layer['id']); paths.add(layer['path']); zs.add(layer['z'])
        return size
    except (KeyError, TypeError, AttributeError) as exc:
        raise PackError('Malformed manifest.') from exc


def load_pack(directory, mode=None):
    """Validate/reimport a canonical PNG pack; return (manifest, RGBA composite)."""
    root = local_path(directory)
    try:
        manifest = json.loads(read_bounded(local_path(root/'manifest.json'), MAX_MANIFEST))
        size = validate_manifest(manifest)
        expected = {'manifest.json', 'original.png', 'parts'}
        if (root/'source.psd').exists():
            expected.add('source.psd')
            source = read_bounded(local_path(root/'source.psd'), MAX_SOURCE)
            if manifest['source']['kind'] != 'psd' or hashlib.sha256(source).hexdigest() != manifest['source']['sha256']:
                raise PackError('Preserved PSD hash mismatch.')
        else:
            source = b''
        if {p.name for p in root.iterdir()} != expected:
            raise PackError('Unknown pack files.')
        parts = local_path(root/'parts')
        if {p.name for p in parts.iterdir()} != {Path(l['path']).name for l in manifest['layers']}:
            raise PackError('Unknown or missing parts.')
        total = len(source)
        result = Image.new('RGBA', size)
        selected = mode or manifest['mode_default']
        if selected not in ('fallback', 'layers'):
            raise PackError('Invalid mode.')
        order = {layer['path']: layer for layer in manifest['layers']}
        for name in ['original.png'] + [x['path'] for x in sorted(manifest['layers'], key=lambda x: x['z'])]:
            blob = read_bounded(local_path(root/name), MAX_OUTPUT)
            total += len(blob)
            if total > MAX_OUTPUT:
                raise PackError('Pack exceeds byte budget.')
            image = decode(blob, ('PNG',))
            if image.size != size:
                raise PackError('All assets must match the fixed canvas dimensions.')
            if (selected == 'fallback' and name == 'original.png') or (selected == 'layers' and name != 'original.png' and order[name]['visible']):
                result.alpha_composite(image)
        return manifest, result
    except (OSError, json.JSONDecodeError, UnicodeError) as exc:
        raise PackError('Cannot read pack.') from exc
