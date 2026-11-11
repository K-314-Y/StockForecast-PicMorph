# Experimental artwork parsing (separate from game and MCP)

**Status:** experimental, not used by the live Node game. Image classifier accuracy not measured yet.

## Approaches compared

| Approach | What it can distinguish | Practical concern |
|---|---|---|
| **Human-seeded RGB region growing** (implemented here) | A connected patch of colour from a click | Very fast and offline; hair gradients, highlights and matching-colour background break it. It does not know what hair/face is |
| SkyTNT Anime Segmentation (ISNet) | Person/character vs background | Doesn't distinguish hair/face/clothes. Usually needs ONNX/PyTorch and model weights |
| suzukimain AnimeSeg (Mask2Former, DINOv2) | Semantic classes like hair, face, clothes, eyes | Trained model is significantly heavier and should be measured on the intended Linux CPU; real samples and model license must be checked |
| shitagaki-lab See-through | Up to 23 semantic drawing layers, including imagined hidden parts | Diffusion models are heavy; inferred invisible content can be *invented*, not evidence of the original drawing |

References (read before evaluating licenses/weights):
- https://github.com/SkyTNT/anime-segmentation
- https://github.com/suzukimain/AnimeSeg
- https://github.com/shitagaki-lab/see-through

## Lightweight prototype

Uses only Pillow, not PyTorch/CUDA/ONNX. Human clicks a seed on the region.
Every region is extracted into a **same-dimension transparent PNG** aligned with the original.

```bash
python3 experiments/image_parts/region_grow.py source.png /tmp/region.png --x 80 --y 50 --tolerance 20
python3 -m unittest discover -s experiments/image_parts -p 'test_*.py' -v
```

Use a **copy** of the user's image; do not put experiment output in the game's
`local_state` directory. Data output is local only, never an XP/model change.

## Decision gates (before integrating into game)

1. Collect user-authored, *permissioned* test art, including flat color, gradients, ornaments and busy backgrounds. Do **not** judge only on synthetic fixtures.
2. Have the creator manually mark hair, face and outfit masks (ground truth). Compare intersection-over-union (IoU), boundary errors, editing time, CPU latency and memory.
3. Always show a proposed **mask preview**, not an automatic save. Keep correction tools and original pixels intact. Misclassification should never be presented as a reliable hair/face result.
4. Benchmark Semantic AnimeSeg on the actual CPU separately **before** downloading gigabytes of model weights into the user's primary project.

Current conclusion: seeded segmentation is a useful no-install *manual assist*, not reliable automatic hair recognition. For automatic semantic parsing, compare pretrained anime-domain multi-class models next.
