"""Prepare a permission-gated local benchmark manifest without changing PNGs."""
from __future__ import annotations

import argparse
import hashlib
import re
import stat
import json
import os
from pathlib import Path
import sys

if __package__:
    from .batch_evaluate import require, validate_rights, local_png, MAX_MANIFEST_BYTES, exact_keys, unique_object
    from .evaluate_masks import read_png, binary_mask, PART_COLORS
else:
    from batch_evaluate import require, validate_rights, local_png, MAX_MANIFEST_BYTES, exact_keys, unique_object
    from evaluate_masks import read_png, binary_mask, PART_COLORS


def filename(value):
    require(isinstance(value, str) and value and value not in ('.', '..')
            and not any(c in value for c in '/\\:?#')
            and not any(ord(c) < 32 or ord(c) == 127 for c in value),
            'Simple filename required')
    return value


def load_seeds(root, name, source, size, paths):
    path = root / filename(name)
    info = path.lstat()
    require(path.suffix.lower() == '.json' and stat.S_ISREG(info.st_mode)
            and not path.is_symlink() and info.st_size <= 16 * 1024,
            'Bounded plain seed JSON required')
    require((info.st_dev, info.st_ino) not in
            {(p.stat().st_dev, p.stat().st_ino) for p in paths}, 'Seed input alias forbidden')
    with path.open('rb') as stream:
        raw = stream.read(16 * 1024 + 1)
    require(len(raw) <= 16 * 1024, 'Seed JSON too large')
    data = json.loads(raw, object_pairs_hook=unique_object)
    exact_keys(data, ('schema_version', 'source', 'width', 'height', 'sha256', 'points'))
    require(type(data['schema_version']) is int and data['schema_version'] == 1,
            'Invalid seed schema')
    require(data['source'] == source, 'Seed source mismatch')
    require(all(type(data[k]) is int and data[k] == v
                for k, v in zip(('width', 'height'), size)), 'Seed dimensions mismatch')
    digest = data['sha256']
    require(isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest)
            and digest == hashlib.sha256(paths[0].read_bytes()).hexdigest(), 'Seed hash mismatch')
    exact_keys(data['points'], PART_COLORS)
    for point in data['points'].values():
        if point is None:
            continue
        exact_keys(point, ('x', 'y'))
        require(all(type(point[k]) is int and 0 <= point[k] < limit
                    for k, limit in zip(('x', 'y'), size)), 'Invalid seed coordinates')
    require(any(p is not None for p in data['points'].values()), 'At least one seed required')
    return data['points']


def seed_inside(mask):
    """Nearest positive pixel to bbox pixel-center; ties use row then column."""
    box = mask.getbbox()
    if box is None:
        return None
    left, top, right, bottom = box
    cx, cy = left + right - 1, top + bottom - 1
    pixels = mask.load()
    best = None
    for y in range(top, bottom):
        for x in range(left, right):
            if pixels[x, y]:
                candidate = ((2 * x - cx) ** 2 + (2 * y - cy) ** 2, y, x)
                if best is None or candidate < best:
                    best = candidate
    return best[2], best[1]


def prepare(folder, source, basis, evidence, dataset_type, tolerance,
            confirm_local_evaluation, output, adaptive=False, step_tolerance=18,
            drift_tolerance=90, seeds_file=None, **masks):
    require(confirm_local_evaluation is True, 'Explicit local evaluation confirmation required')
    root = Path(folder)
    require(root.is_absolute() and root.is_dir(), 'Existing absolute folder required')
    require(not any(p.is_symlink() for p in (root, *root.parents)), 'Symlinks forbidden')
    require('local_state' not in root.resolve().parts, 'local_state forbidden')
    # Keep original art, annotated masks and private permission evidence out of Git.
    require(not any((parent / '.git').exists() or (parent / '.git').is_symlink()
                    for parent in (root, *root.parents)),
            'Private evaluation inputs must be outside Git repositories')
    filename(output)
    destination = root / output
    require(destination.suffix.lower() == '.json' and not destination.exists()
            and not destination.is_symlink(), 'New JSON filename required')
    require(dataset_type in ('synthetic_original', 'permissioned_art'), 'Invalid dataset type')
    require(dataset_type != 'synthetic_original' or basis == 'self_created', 'Invalid rights combination')
    require(type(tolerance) is int and 0 <= tolerance <= 255, 'Invalid tolerance')
    require(type(adaptive) is bool, 'Invalid adaptive flag')
    for value in (step_tolerance, drift_tolerance):
        require(type(value) is int and 0 <= value <= 255, 'Invalid adaptive tolerance')
    rights = dict(basis=basis, evidence=evidence, local_evaluation_allowed=True,
                  redistribution_allowed=False, covered_files=['source', 'truth'])
    validate_rights(rights)
    names = [source]
    for part in PART_COLORS:
        truth, prediction = masks.get(part + '_truth'), masks.get(part + '_prediction')
        require(prediction is None or truth is not None, 'Prediction requires truth')
        names.extend(n for n in (truth, prediction) if n is not None)
    require(len(names) > 1, 'At least one truth required')
    paths = [local_png(root, filename(n)) for n in names]
    require(output not in names, 'Output conflicts with input')
    require(len({(p.stat().st_dev, p.stat().st_ino) for p in paths}) == len(paths),
            'Duplicate inputs forbidden')
    size = read_png(paths[0]).size
    points = (load_seeds(root, seeds_file, source, size, paths)
              if seeds_file is not None else None)
    normalized = {}
    for name, path in zip(names[1:], paths[1:]):
        image = read_png(path)
        require(image.size == size, 'All dimensions must match')
        normalized[name] = binary_mask(image)
    cases, skipped = [], []
    for part in PART_COLORS:
        truth, prediction = masks.get(part + '_truth'), masks.get(part + '_prediction')
        if truth is None:
            continue
        if points is not None:
            require(points[part] is not None, 'Truth requires manual point')
            seed = (points[part]['x'], points[part]['y'])
        else:
            seed = seed_inside(normalized[truth])
        if seed is None:
            skipped.append(part)
            continue
        common = dict(part=part, source=source, truth=truth)
        cases.append(dict(common, id=part + '_seeded', method='seeded',
                          seed_x=seed[0], seed_y=seed[1], tolerance=tolerance,
                          rights=dict(rights)))
        if adaptive:
            cases.append(dict(common, id=part + '_adaptive', method='adaptive-seeded',
                              seed_x=seed[0], seed_y=seed[1], step_tolerance=step_tolerance,
                              drift_tolerance=drift_tolerance, rights=dict(rights)))
        if prediction is not None:
            cases.append(dict(common, id=part + '_mask', method='mask', prediction=prediction,
                              rights=dict(rights, covered_files=['source', 'truth', 'prediction'])))
    require(bool(cases), 'All truth masks empty')
    payload = json.dumps(dict(schema_version=1, dataset_type=dataset_type, cases=cases,
                              seed_selection=('image_only_manual' if points is not None else 'truth_assisted')),
                         ensure_ascii=True, indent=2) + '\n'
    require(len(payload.encode('utf-8')) <= MAX_MANIFEST_BYTES, 'Manifest too large')
    # Exclusive 0600 creation: permission evidence is private local metadata.
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                 | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(payload)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return len(cases), skipped


class PrivateParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('Invalid command arguments')


def main(argv=None):
    parser = PrivateParser(description=__doc__)
    for name in ('folder', 'source', 'basis', 'evidence', 'dataset-type', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--tolerance', type=int, default=20)
    parser.add_argument('--seeds-file')
    parser.add_argument('--adaptive', action='store_true')
    parser.add_argument('--step-tolerance', type=int, default=18)
    parser.add_argument('--drift-tolerance', type=int, default=90)
    parser.add_argument('--confirm-local-evaluation', action='store_true')
    for part in PART_COLORS:
        for kind in ('truth', 'prediction'):
            parser.add_argument('--' + part + '-' + kind)
    try:
        count, skipped = prepare(**vars(parser.parse_args(argv)))
    except (ValueError, OSError, TypeError, RecursionError):
        print('Rejected: invalid permission, arguments, path or PNG.', file=sys.stderr)
        return 2
    for part in skipped:
        print('Warning: empty truth skipped: ' + part, file=sys.stderr)
    print('success')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
