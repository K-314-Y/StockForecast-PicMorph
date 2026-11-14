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

## 2026-11-14: 同じ条件で切り抜きを比較する（実験専用）

**これは認識AIそのものではなく、切り抜きの精度を測る道具です。** 作者がマスク（対象は白、それ以外は黒。もしくはRGBAの透明度）を正解として用意し、色選択方式や別の画像AIの出力がどの程度一致するかを測ります。入力の元画像とマスクは同寸法PNG、最大4096pxかつ400万画素です。

### コマンド例

1. 人が指定した一点から同じ色のつながった領域を選択する場合:

    python3 experiments/image_parts/evaluate_masks.py --source /tmp/source.png --truth /tmp/truth-hair.png --method seeded --seed-x 80 --seed-y 50 --tolerance 25

2. 他の方式が出した二値または透過マスクと比較する場合:

    python3 experiments/image_parts/evaluate_masks.py --source /tmp/source.png --truth /tmp/truth-hair.png --method mask --prediction /tmp/predicted-hair.png

3. AnimeSeg Mask2Former標準12クラスのカラーラベルPNGを評価する場合:

    python3 experiments/image_parts/evaluate_masks.py --source /tmp/source.png --truth /tmp/truth-hair.png --method anime-seg-rgb --prediction /tmp/animeseg-colors.png --part hair --output /tmp/proposed-hair.png

    --part は hair / face / outfit が指定できます。色は髪が赤（255,0,0）、顔が青（100,150,255）、服が紫（180,0,255）の**完全一致**を前提とします。アンチエイリアスのあるマスクやAnimeSeg-Nextの異なるクラスには、そのまま使えません。推論モデルのダウンロードや実行は行いません。

4. 既存と追加の自動テスト:

    python3 -B -m unittest discover -s experiments/image_parts -p 'test_*.py' -v

### 評価指標

- **IoU（重なり率）**: 正しく選べた画素を、正解または選択された画素全体で割った割合。1.0に近いほど良い。
- **Precision**: 選んだ画素の中で正しい割合。**Recall**: 正解の画素をどれだけ取りこぼさなかったか。**F1**: そのバランス。TP/FP/FN/TNは正解/余計な選択/見逃し/正しく除外した画素数。
- **coverage**: 全画素に占める選択画素。**elapsed_ms**: 読み込み・抽出・評価の時間であり、別プログラムで実行した画像AIの推論時間は含まれません。
- 正解も予測も空なら、IoU/F1/Precision/Recallを1.0と定義。一方だけ空なら0.0。実データ集計では空マスクと対象あり画像を別々に報告します。

出力はJSON標準出力。--outputを指定したときだけ同じサイズの透過PNGを書き出します。入力画像、既存ファイル、ゲームのlocal_stateを上書きすることは拒否し、自動的にゲームへ取り込みません。

### 本格的な認識AIへ進む条件

1. **権利・利用許可を確認した実イラスト20〜30枚以上**について、人の手で髪・顔・服の正解マスクを作成する。合成画像だけの精度は本番採用の根拠になりません。
2. 暫定基準として部位ごとの平均IoU0.80以上、極端な失敗が少ないこと、本人が少ない操作で修正できること、Linux CPUで処理時間・メモリ消費が許容できることを評価する。**0.80は検証前の仮説で、確立した合格値ではありません**。
3. AnimeSegは髪・顔・服などの12クラスを扱えるが、公開モデル一式が約2.77GB、個別の重みも数百MB規模。AnimeSeg-Nextは31/37クラスに細分化されているものの、今回の12クラス用の色解釈とは互換性がありません。モデルのライセンス・配布条件・CPU実行可否も別途検証するまで導入しない。
4. 実行前にユーザーに画像プライバシーと保存意図を確認する。元画像を残し、自動保存やMCPでの画像送信はしない。

仕様の参照先:
- https://github.com/suzukimain/AnimeSeg
- https://huggingface.co/suzukimain/AnimeSeg
- https://github.com/suzukimain/AnimeSeg-Next

現状: **切り抜き精度の測定準備はできたが、実イラストの髪・顔・服の自動識別精度は未測定**。mainには統合していない。
