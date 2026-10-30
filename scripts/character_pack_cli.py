#!/usr/bin/env python3
"""Offline image → isolated character PACK directory."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_packs import PackError, convert


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, help='Local PNG/JPEG/WebP or optional PSD')
    parser.add_argument('--output', required=True, help='NEW output directory; no overwrite')
    args = parser.parse_args()
    try:
        manifest = convert(args.input, args.output)
    except (PackError, OSError) as exc:
        parser.exit(2, f'PACK error: {exc}\n')
    print(f'Created {args.output} ({len(manifest["layers"])} layers)')
    for warning in manifest['warnings']:
        print(f'Warning: {warning}', file=sys.stderr)


if __name__ == '__main__':
    main()
