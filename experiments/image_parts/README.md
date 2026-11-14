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

## 複数画像の著作権・許諾チェック付き評価（2026-11-14）

**実験のみ。本番ゲームへ未統合。画像・正解マスク・予測マスクはローカルPC上だけに置きます。** 公開されているイラストの自動収集、外部サイトへのアップロード、モデル重みの取得は行いません。

テストする各画像セットについて、データの出所と**ローカル採点に使う許可**をJSONで宣言します。これは自己申告を機械的に確認する仕組みであり、法律上の許可を自動的に証明するものではありません。出所に疑問がある画像、作品・キャラの複製、権利者を確認できないもの、無断で学習データから抜き出した画像は追加しないでください。

### 準備と実行

個人データはGitリポジトリ外の非公開フォルダに置き、以下を参考に manifest.json を作成します。例では、絵と正解マスク・予測マスクの**すべてを自分で制作した合成図形**として宣言しています。

    {
      "schema_version": 1,
      "dataset_type": "synthetic_original",
      "cases": [
        {
          "id": "study_01",
          "part": "hair",
          "method": "mask",
          "source": "drawing.png",
          "truth": "ground_truth.png",
          "prediction": "predicted_mask.png",
          "rights": {
            "basis": "self_created",
            "evidence": "Original simple drawing and masks made by the tester, 2026-11-14",
            "covered_files": ["source", "truth", "prediction"],
            "local_evaluation_allowed": true,
            "redistribution_allowed": false
          }
        }
      ]
    }

    # 上の3枚をmanifest.jsonと同じフォルダに置いた場合
    python3 experiments/image_parts/batch_evaluate.py --manifest /path/to/private/manifest.json

- method は seeded / mask / anime-seg-rgb。seeded は prediction を外し、seed_x、seed_y、tolerance を加え、covered_files は ["source","truth"] にします。
- dataset_type は synthetic_original（独自作成の合成図形）か permissioned_art（権利確認済みの実イラスト）を指定。事実と異なるラベルは禁止です。
- basis は self_created / author_permission / licensed のいずれか。evidence には、作者本人の記録、許可文書の保管先、利用許諾のURLなど**実際に確認できる根拠**を記録。URLが書いてあっても自動で訪問・検証しません。
- **元画像、手で作った正解マスク、AIが出力した予測マスクのすべてが許可の対象**です。正解マスクは二次的な画像になり得るため、元絵だけに許可がある場合は使わないでください。
- ソフトは全件の宣言、相対パス、PNGファイルの存在を確認してから評価します。許可情報が足りない場合は採点を開始しません。リンク先画像、シンボリックリンク、親フォルダへの脱出、重複ID、無関係な項目は拒否します。最大100件、manifestは128 KiB以下です。
- 出力は**標準出力のJSONだけ**です。画像や評価レポートを勝手に保存・共有しません。レポートのIDは入力順の匿名IDになり、画像のパス・許可証の文言は含めません。ただし成績や統計も非公開のまま扱い、他人に配布しないでください。

### 数字の集計と限界

部位×方法ごとに、IoU（重なり率）とF1の**平均・中央値・最低値**を出します。正解が空のケースを平均から除外して別件数で表示するため、何も切り抜かないだけで高得点になることを防ぎます。処理時間は**画素の採点だけ**で、AIの推論や画像読み込みにかかった時間ではありません。多数の実例で評価する前の点数は「実際のアニメ絵における認識精度」を意味しません。

AnimeSeg/AnimeSeg-Nextの説明資料に含まれる12クラスなどの**仕様を参照すること**と、モデルのコード・重み・学習元画像・出力マスクを**再配布・商用利用する許諾**は別です。少なくとも今回確認できた公開ページだけでは重みの配布権を確認できていません。モデルもサンプル画像もダウンロードせず、ライセンスや権利範囲が確認されるまで本番組み込みしません。今回の実験コードはそれらを同梱・複製していません。

### 安全性の範囲

この実験はローカル単独ユーザー用です。パスやシンボリックリンクを事前確認しますが、**別の悪意あるローカルプロセスが確認後にファイルを入れ替える競合**までは完全に防げません。また、権利の自己申告が真実であるかは自動検証できません。他人の画像を扱う際は、権利者が示した具体的な条件・目的・期間を人が確認してください。

**次にやるべきこと**: 作者の許可を得た実イラスト20～30枚程度に、同寸法の正解マスクを作成。画像そのものを外部送信せず、髪・顔・服について実測し、修正時間やCPU負荷も別途測る。モデル利用条件が不明な間は画像AIの重みを導入しません。

## ブラウザで「人が正解を描く」作業（オフライン実験）

正解マスクを自分で用意するための独立HTML編集画面を追加しました。
Chromeで experiments/image_parts/annotate.html を開きます。通常は file:// から直接開く設計です。ブラウザのファイルアクセス制限により表示できない場合のみ、同じPC内で一時的なlocalhost静的サーバーを使い、作業後に停止してください。本番ゲームのHTTP/MCPに接続する機能はありません。

- 自作画像、または正解マスクを作成・ローカル評価する明示的な許可がある画像だけを選びます。権利確認チェックを入れるまで、ファイル選択は無効です。自己申告の真偽を自動確認するものではありません。
- ローカルPNGのみを選択します。PNGは8MiB以下、1辺4096px以下、合計400万画素以下です。ネット上の画像URLやアニメ作品の画像は自動取得しません。
- 髪、顔、服を選んでマウスまたはタッチで塗り、消しゴム、Undo、選択部位のクリアを使います。各部位のマスクは独立し、元画像のピクセル数のまま保持します。
- まずマスクをプレビューし、作者が各保存ボタンと確認操作を明示的に実行した場合だけ、その部位の不透明な白＋透明背景のPNGをダウンロードします。元画像は変更しません。ブラウザの保存先を確認して既存ファイルを置き換えないでください。
- 保存したマスクは、前節の evaluate_masks.py の method=mask と prediction にそのまま渡せます。配布や公開時には元画像と正解マスク両方の権利条件を確認してください。本人の操作なしに画像が外部送信・自動保存されることはありません。
- 編集内容はタブ内メモリだけにあり、別画像を選ぶときは未保存内容の破棄を確認します。再読み込み・タブを閉じると消えます。未保存の修正には注意してください。AIによる髪・顔・服の自動識別ではありません。

静的チェック: python3 -B -m unittest discover -s experiments/image_parts -p 'test_*.py' -q。
保存画素・ブラシ・ダウンロードの実操作はChrome/Playwrightの受け入れ確認で行い、テスト画像はPillow生成の抽象図形だけを使います。第三者キャラクター、学習モデル重み、公開アニメ作品の画像は同梱していません。

## 編集したPNGから評価JSONを作る（手入力を減らすCLI）

1. `annotate.html` で許可を確認し、元PNGを開いて髪・顔・服の正解を塗り、プレビュー後に必要な部位のPNGを保存します。
2. 元画像と保存した全マスクを、既存の**リポジトリ外の非公開フォルダ1つ**へ手動で移動してまとめます。元画像は保管したまま、そのコピーを用意してください。CLIは入力のコピー・変更やフォルダ作成をしません。Git管理下のフォルダも拒否し、元画像や許可記録をうっかりコミットしないようにします。
3. 元画像、生成した正解マスク、指定する予測マスクの**すべて**についてローカル評価する権利と根拠を確認し、次を実行します。これは独自制作の合成図形の例です。実際の根拠に合わせて記録してください。

```bash
python3 experiments/image_parts/prepare_benchmark.py --folder /ABS/PRIVATE/DATA_DIR --source original.png --hair-truth hair.png --face-truth face.png --outfit-truth outfit.png --basis self_created --evidence "Original artwork and masks made by creator for local scoring on 2026-11-14" --dataset-type synthetic_original --tolerance 20 --confirm-local-evaluation --output benchmark.json
python3 experiments/image_parts/batch_evaluate.py --manifest /ABS/PRIVATE/DATA_DIR/benchmark.json
```

4. 集計結果をローカルで確認します。実イラストやモデルによる評価はまだ実施していません。**データ受け渡しの自動化は、意味的な髪・顔・服の識別精度を意味しません。**

- `--hair-truth` / `--face-truth` / `--outfit-truth` は個別に省略可能ですが、最低1つ必要です。それぞれ正画素の外接矩形の中心に最も近い**正画素内**のseedを自動選択し、`hair_seeded` 等のケースを作ります。同距離なら上、左の順です。これは正解を利用した色領域選択の補助評価で、自律的な部位認識ではありません。**正解からseedを選ぶため実際の利用場面より有利な条件（答えを見てクリック位置を決める比較）です。自動判別モデルの精度と公平に比較するには、正解を見ずに利用者が選んだseedを別に記録して試す必要があります。**
- `--hair-prediction hair_pred.png` 等は対応するtruthがある場合だけ指定可能で、独立した `method=mask` の `hair_mask` 等を追加します。正解のコピーを予測として機械の成功と称さないでください。空のtruthは警告して部位全体を除外し、全部空なら失敗します。
- `--folder` は既存の絶対パス。入出力はその中の単純なファイル名だけで、URL、絶対パス、区切り文字、親参照、シンボリックリンクは拒否します。入力の重複（ハードリンクを含む）も拒否します。全PNGは同寸法、既存評価器と同じ容量・寸法制限、マスクは二値L/1またはRGBAです。
- `--basis` は `self_created` / `author_permission` / `licensed`。`--dataset-type synthetic_original` は `self_created` のみ、`permissioned_art` は上記3種を許可します。実イラストを合成図形と偽って指定しないでください。自己申告の真偽は自動確認できません。
- `--evidence` の文字列はシェル履歴や一時的なプロセス表示には残る可能性があります。個人情報・氏名・秘密の許可証をそのままコマンドに書かず、非公開資料を自分で照合できる短い参照記号を記録してください。
- `--evidence` は既存の権利検査と同じく10〜2048文字、制御文字や山括弧は禁止、URLを含めるなら通常のHTTPS参照のみです。根拠は非公開のJSON内に残りますが、CLIの標準出力・エラーには表示しません。
- `--tolerance` は0〜255、既定値20。`--confirm-local-evaluation` は保存への明示同意として必須です。未指定や検査エラーなら永続出力は作りません。
- 出力JSONは作成時に所有者だけが読めるモード0600で作り、許可根拠を不用意に公開しないようにします。ただしバックアップや管理者によるアクセス、シェル履歴までは防げません。
- `--output` は必須の新規 `.json` ファイル名（例は `benchmark.json`、`manifest.json` も可）。全検査後に一度だけ排他的に作成し、既存出力・入力の上書きと `local_state` 内の保存は拒否します。出力物はこのローカルマニフェストだけで、成功時の標準出力は `success` のみです。

## 2026-11-14: 濃淡に対応する適応型の色領域抽出（実験限定）

**これはAIによる意味的な髪・顔・服の認識ではありません。** 旧方式 seeded は、クリックした開始点の色との差が小さい画素を4方向にたどります。新方式 adaptive-seeded は、**隣の画素との色差（step_tolerance）** と **最初にクリックした画素との色差の上限（drift_tolerance）** の両方を満たす画素をたどります。元画像と同じ大きさの透明PNGを作れます。元画像は書き換えません。

- メリット: なめらかなグラデーションで、開始点から離れた同一領域を取り逃しにくくなる。
- デメリット: 似た色が徐々につながっている背景にも広がり、**誤って余計に切り抜く場合がある**。線画の線で領域が分断される場合も解決しない。
- 安全対策: 4方向の連結領域だけ、透明部分を通らない、4百万画素まで、抽出率が高すぎたらエラー。描画対象の名前（髪など）を機械が判定しているわけではない。

既存の prepare_benchmark.py に --adaptive を付けると、髪・顔・服の各正解マスクについて、**同じ開始位置**を使った seeded と adaptive-seeded の2ケースを一括評価できます。--adaptive を省略した場合は今までのままです。

    python3 experiments/image_parts/prepare_benchmark.py \
      --folder /ABS/PRIVATE/DATA_DIR --source original.png \
      --hair-truth hair.png --basis self_created \
      --evidence "Original artwork and masks made by creator for local evaluation" \
      --dataset-type synthetic_original --tolerance 20 \
      --adaptive --step-tolerance 18 --drift-tolerance 90 \
      --confirm-local-evaluation --output paired.json

    python3 experiments/image_parts/batch_evaluate.py \
      --manifest /ABS/PRIVATE/DATA_DIR/paired.json

直接1件だけ評価する場合:

    python3 experiments/image_parts/evaluate_masks.py \
      --source /ABS/PRIVATE/DATA_DIR/original.png \
      --truth /ABS/PRIVATE/DATA_DIR/hair.png \
      --method adaptive-seeded --seed-x 40 --seed-y 50 \
      --step-tolerance 18 --drift-tolerance 90

**公平性への注意:** prepare_benchmark.py は人が描いた正解マスクを見て開始位置を選びます。これは比較の再現性を高めるための「正解を見てクリック位置を決める実験」であり、本人が正解を見ずにクリックする実際の操作とは条件が違います。実イラストで本番の精度を主張するなら、**正解を見ずに決めた開始位置**も別途記録して検証してください。閾値をテスト画像に合わせて何度も調整すると成績が水増しされるため、先に決めた閾値で未使用画像を評価します。

### オフライン比較例（Pillowで独自作図した抽象図形）

64×48ピクセル、同じ開始点、旧方式 tolerance=20、改良版 step=18/drift=90。**実イラストでの認識精度を示す値ではありません。**

| 画像の条件 | 旧方式IoU | 新方式IoU | 解釈 |
|---|---:|---:|---|
| 色が滑らかに変わる矩形 | 0.375 | 1.000 | 新方式が見逃しを減らした |
| 背景と明確に色が違う矩形 | 1.000 | 1.000 | 差はない |
| 背景に近い色の細い通路がつながる矩形 | 0.865 | 0.748 | 新方式が余分な背景を選んだ |

出力JSONの segmentation_ms は切り抜き処理の計測値です。既存の batch_evaluate.py の elapsed_ms は画素の正誤を計算した時間で、画像の読み込みやAIモデル推論時間を含みません。実際に操作する時のCPU負荷・メモリも別に測定する必要があります。

著作権ルールは前節を引き継ぎます。使用許可が不明な作品画像を取得せず、モデル重みをダウンロードせず、画像を外部送信せず、実験Branchを本番ゲームにはまだ統合しません。

## 2026-11-14: 正解マスクを見ずに点を選ぶブラインド比較

以前の prepare_benchmark.py は、正解マスク内のピクセルを探して開始点にしていたため、実利用より簡単な条件での比較でした。新しい choose_seeds.html は **元画像だけを読み込む画面**で、髪・顔・服の点を作者自身が指定できます。これは意味を自動理解するAIではありません。

### 使い方

1. 権利が確認できた自作・許諾済みの元画像を準備。先に Chrome で experiments/image_parts/choose_seeds.html を開きます。ローカルPNGだけを選択し、部位を選んで元画像の上をクリックします。正解マスクはこの画面では**一切読み込めません**。
2. 点を選択したあと、ダウンロードを明示的に承認して seeds_...json を保存。JSONは元画像のファイル名、幅・高さ、ファイルSHA-256、髪・顔・服の座標だけを持ち、画像そのものや権利者の情報は含まれません。
3. その後、別の「手で描く正解マスク」画面 annotate.html などで正解を用意します。**元画像、各マスク、seedのJSONを同じ非公開のGit管理外フォルダ**に配置します。ファイル名は変更しないでください。本人がダウンロードしたseed JSONの名前を --seeds-file にそのまま渡します。
4. ローカル処理の権利が確認済みであることを宣言して評価用JSONを生成します。seedが不正な場合・別のPNGに紐づく場合・権限が不足する場合は拒否します。元画像とマスクは変更せず、評価用JSONのみ0600で新規作成します。

    python3 experiments/image_parts/prepare_benchmark.py \
      --folder /ABS/PRIVATE/DATA_DIR --source original.png \
      --hair-truth original_hair.png --face-truth original_face.png \
      --basis self_created \
      --evidence "Creator verified original artwork and derived masks for local scoring" \
      --dataset-type permissioned_art --seeds-file seeds_...json \
      --tolerance 20 --adaptive --step-tolerance 18 --drift-tolerance 90 \
      --confirm-local-evaluation --output blind_benchmark.json

    python3 experiments/image_parts/batch_evaluate.py \
      --manifest /ABS/PRIVATE/DATA_DIR/blind_benchmark.json

**注意:** 例の dataset_type=permissioned_art は自作の実イラストを含む実画像用です。許可された実画像の準備がないうちは synthetic_original と自作の単純な図形だけを使ってください。--basis の self_created / author_permission / licensed も利用許諾を自動検証するものではありません。正解マスクと予測マスクにも権利条件が及びます。証拠の文書自体や個人情報はコマンドに書かず、私的な照合用の短い記録を残してください（シェル履歴に残り得ます）。

### 自己申告の限界と正しい読み方

- 出力には seed_selection=image_only_manual と明記します。従来の正解から選ぶ方式では truth_assisted と表示します。古いmanifestの seed_selection が無い場合は truth_assisted とみなします。
- クリック位置が正解マスクの外側でも、勝手に正解へ移動させません。透明ピクセルや広すぎる背景で抽出停止した場合も、**手動選択の評価では空の抽出結果として数え、失敗を除外しません**。各ケースに segmentation_rejected=true を出します。これは精度を都合よく上げないためです。
- 両方式はまったく同じ画像・同じ座標を使い、別々の閾値を事前に決めて比較します。正解を見て閾値を調整しないでください。
- **ユーザーが本当に正解を見ずに点を選んだかは自己申告**です。SHA-256は同じPNGかどうかを照合するだけで、点を選んだ時刻や順番を証明するものではありません。
- 外部通信やAIモデル重みのダウンロードを必要としません。評価の実用性を主張する前には権利確認済みの実イラストで、見逃し・誤抽出・CPU時間・修正に必要な作業量を別に測定してください。

UIの静的確認と評価ツールのテスト:

    node --check experiments/image_parts/choose_seeds.js
    python3 -B -m unittest discover -s experiments/image_parts -p 'test_*.py' -q

画面は独立したローカル実験ツールで、Creature Labの通常ゲーム画面や保存データには接続しません。
