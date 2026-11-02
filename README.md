# Creature Lab / 予測クリーチャー
**Sprint 01 / 2026-10-27 / 動く試作品**

ゲームの構想: ChatGPT内のアプリから、利用者が自由な絵・プログラム・ゲーム内プラグインを組み合わせて予測キャラクターを制作・共有し、将来は無料の仮想コインで疑似運用する。

## 今回完成した範囲
- Linuxローカルに、キャラクターSVG表示と目・盾の装備編集画面を作成。
- **絵 → 設定 → 計算**: 目の装備から短期・長期移動平均期間を変更し、合成価格データのUP/FLAT/DOWN確率が再計算される。
- **コード → 設定 → 絵**: Pythonソースの3つの数値定数を編集すると、装備と結果に反映される。認識できない構造変更は拒否。
- 盾はコイン10,000枚の「参考リスク配分枠」にのみ影響。**売買は発生しない**。
- V6のBrier Score定義と整合する独立関数をテスト付きで収録。
- 単一端末ローカル実行。データは40点の**完全な架空価格**。インターネット接続、証券API、課金、認証、ユーザー任意のPython実行なし。
- ページを閉じてもプロセスを終了しなければモデル状態は保持。**再起動後は初期化**される。複数ユーザー未対応。

## 起動と検証
```bash
cd ~/ドキュメント/14_予測クリーチャー
python3 -B -m unittest discover -s tests -v
python3 -B app.py --port 8765
```
同じLinuxのChromeから http://127.0.0.1:8765/ を開く。

## 試し方
1. 「ハヤブサ目」「フクロウ目」「カメ目」を切り替える。移動平均期間、キャラの目、確率が変わることを確認。
2. 盾スライダーを変更し、コイン参考枠が変わることを確認。売買処理はない。
3. 右のPythonソースの `FAST_WINDOW = 3` を `FAST_WINDOW = 4` に書き換える。
4. 「コードをモデル・絵に反映」を押す。目が「カスタム」仕様になり、結果とコードのハッシュが更新される。
5. `__import__` 等を追加しても拒否され、実行しない。

## 意図的に未実装
- **ChatGPT MCPアプリとしての接続・公開**: これはローカル技術実証。ChatGPTで呼べるプラグインを作ったと主張しない。
- 自由な手描き画像、自由なPython、AIコード生成、ユーザー作成プラグインの実行、モデル共有・派生。
- BTC/株の実価格データ取得、権利処理、未来予測の締切・Forward成績、売買損益、シーズン、資金データ永続化。
- 任意コードの隔離実行、安全な複数ユーザー認証、コスト・法規・市場データの検証。

## 設計原則
- 最終目標は**自由な絵と自由なコード**。Sprint 01 の制限を製品の永続的な制限にしない。
- 単一の `Model` 設計図を情報源とし、ビジュアル表示と計算処理を同期する。ユーザーの未承認コードを実行しない。
- 現在は構成ファイルの生成とパラメータ編集。任意Pythonの意味を完全解析する仕組みは**未解決**。
- 既存の `13_株価予測` は**一切変更しない**。V6の採点思想は参考にしているが、このSprintでは既存V6の外部依存コードを直接インポートしない。
- 公開サービスとして利用する前に、プラグイン審査、ユーザー作成コードの分離、データ配信権、規制について別途検証する。

## 次のバックログ（Sprint 02候補）
1. MCPツールを使ったChatGPTからのモデル編集。正式なChatGPT利用可能性は実機で確認。
2. 配布してよいデータ（初期は合成）で仮想コイン台帳を実装し、価格変化・取引手数料・損益の式をテスト。
3. 自由に描いた画像の部分領域をユーザーが機能に関連付ける画面（画像とコードは別々の属性として保持）。
4. バージョンの保存と差分。公開・任意コード実行は安全設計がまとまるまで凍結。

### 注意
デモに示される上昇確率は架空の時系列と簡単な決定論的数式による**例**であり、予測精度を検証・保証するものではありません。

## Sprint 02: ChatGPT向けMCPのローカル実装（2026-10-27）
- `mcp/server.mjs`: Streamable HTTPのMCPサーバー（localhost:8766/mcp）。get_creature_state, list_creature_parts, set_eye, set_shield, set_model_parametersを提供。
- `mcp/tests/mcp.test.mjs`: MCP通信、ツールの更新、整合性、403/409拒否をテスト。
- `app.py`: 楽観的排他制御 `expected_revision`（不一致は409）。
- `web/index.html`: 別クライアントからの変更を自動同期し、編集中のコードを保護。
- 結果：ローカルのMCP呼び出しで画面と計算が反映されることをブラウザでも確認。
- **ChatGPTへのインストールや公開は未実施**。Secure MCP Tunnel等の組織設定・資格情報・ユーザー自身の接続操作が必要。詳細は `mcp/README.md`。

## Sprint 02 外見改善（ユーザー確認用）
キャラクターの初期外見をロボットからかわいい女の子のSVGに変更。アカリ（短期・ピンク）、ルナ（バランス・銀青）、ミドリ（長期・ラベンダー）の3タイプで髪・瞳・衣装・アクセサリー・背景が変化。Pythonのパラメータを直接変更するとオリジナル配色へ移行。盾の演出は仮想資金の配分設定に連動。絵の完全自由描画と写真アップロードは今後のスプリント。

## Sprint 03: 無料コイン練習とモデル保存（動作確認済み）
- ゲーム画面: `http://127.0.0.1:8765/game` （Linuxローカルのみ）
- ゲーム内のコイン10,000枚を自作モデル・ルナ・ミドリの3枠へ配分。合計100%超はエラー、余りは現金待機。
- 各キャラは過去観測価格だけで次ステップを判定し、ロング／現金待機で練習。レバレッジ・空売り・外部発注なし。
- 架空の日足40点＋未知の架空12点を用意。運用損益、0.1%という例示の手数料、最大下落率、同一期間の買い持ちと比較する。
- **同じ架空資産を複数キャラが予測しているだけで、銘柄分散ではない。**固定の練習シナリオを繰り返せるため、フォワード成績や実運用評価ではない。
- Pythonのモデル数値とキャラ外見は現在のローカル状態を共有する。保存は`local_state/versions.json`に原子的に書き込み、読み込み時はSHA256照合。100版まで。
- 保存・復元操作はrevision競合検出付き。保存版は既存V6と独立。モデルのプログラム本体を自由実行しない。
- ChatGPT向けMCPツール追加: `run_coin_practice`, `list_saved_models`, `save_current_model`, `load_saved_model`。ローカルMCPで動作確認済み。ChatGPT側への登録は未実施。
- 検証: `python3 -B -m unittest discover -s tests -v` と `cd mcp && npm test`。
- 今回のゲーム内3枠は**任意プラグインを組み合わせる完成形ではなく、現在のモデルと2つの固定プリセット**。次の開発で拡張する。

## Sprint 04: 3つの分析プラグインを自由な割合で合成

- 編集画面: `http://127.0.0.1:8765/` （Linuxローカルのみ）
- **トレンド / モメンタム / ボラティリティ** の3種を `0..100%` の整数重み（合計100%）で合成する。ゼロ重みは無効化と同等。例: `50/30/20`。
- 各分析モジュールは同じ与えられた過去の価格のみを入力とし、それぞれ `UP/FLAT/DOWN` の3クラス確率を返す。最終確率はその加重平均。
- `Model.plugin_weights` は単一のソース・オブ・トゥルース。画面の設定 → 予測値・SVGの装飾・Pythonコード・コイン運用シミュレーションに反映。逆方向は `WEIGHT_TREND` 等の定数をコード欄で編集することで反映。
- `/api/plugins` GETは許可済み分析モジュールのカタログ、POSTは比率更新（revision競合拒否）。
- 既存の保存済みバージョンを破壊しない。Sprint 3で保存した3定数モデルは旧SHA256を照合し、デフォルト重み `100/0/0` として復元できる。
- MCPに `list_analysis_plugins` と `set_analysis_plugins` を追加。外部プラグインのダウンロードや任意Pythonコードの実行は未実装・禁止。
- 今は固定された合成データを使った**演習用モジュール**であり、学習済みモデルや実市場への接続ではない。未来の価格を参照しない。
- 初回コミット、以降の変更履歴、バックアップはローカルGitで管理。GitHubへのpush・公開設定はユーザーが管理する。

## Sprint 05：分析プラグインの登録制（ローカル）

- `indicators.py` が監査済み内蔵分析モジュールの登録簿。`IndicatorSpec` にID、名称、説明、外見装飾、ローカル計算関数を登録する。
- トレンド、モメンタム、ボラティリティに加え「平均回帰（reversion）」を追加。新プラグインは初期0%、既存モデルは100/0/0/0。
- 画面の分析重み入力欄、モデルの重み検証、予測結果一覧、Pythonプレビューが同じ登録簿から生成される。ユーザーがアップロードしたプログラムは実行しない。
- 既存のSprint 3/4保存モデルと古いPythonプレビューを検証・読み込み可能。旧保存データは書き換えず、足りない平均回帰の比率を0%として扱う。
- 平均回帰分析は**架空データの例示モデル**であり、学習済みモデルや投資助言ではない。どのモジュールも与えられた過去の価格しか使用しない。
- MCPに `configure_analysis_plugins(weights, expected_revision)` を追加。ID→整数重みのマップで、プラグイン数が変わっても同じ操作名を使える。古い `set_analysis_plugins` も互換維持。
- テスト: `python3 -B -m unittest discover -s tests -v`、`cd mcp && npm test`。
- GitHubへのpushは行わず、ローカルGitで作業履歴を管理する。

## Sprint 06: プラグイン別感度とキャラ別モデル編成

- 各登録済みプラグインに独立した `strength_pct`（50〜150、標準100）を追加。100ならSprint 5と同じ計算。50では均等確率へ近づけ、150では各プラグインの偏りを強める。結果は正規化する。これは演習用感度で、モデル精度の保証ではない。
- `Model.plugin_strengths` は定数のみを受け付け、`with_plugin_strength_change` と `POST /api/plugin-settings` から変更。UIの分析欄に感度入力を追加し、`STRENGTH_...` がPythonプレビューへ同期する。
- `local_state/versions.json` ではモデル名、期間、リスク、各分析重み、各感度をバージョン保存。Sprint 3/4/5の旧ハッシュは当時の生成形式で照合し、読み込み時にファイルを書き換えない。
- `local_state/lineup.json` にはルナ（owl）・ミドリ（turtle）の保存モデルIDだけを、revision付きで原子的に保存。各枠は「標準」または任意の保存済みバージョンを参照する。自作キャラ（mine）は常に現在編集しているモデルを使う。
- 練習シミュレーションでは、この編成に基づいて3体それぞれ独立したモデルが行動する。架空価格のみ、実売買・他人とのランキングなし。
- `GET /api/lineup`、`POST /api/lineup` を追加。モデル自体と編成のrevisionは別管理で、不正な保存ID・古い編成revisionを拒否。
- MCP操作に `set_plugin_strengths`、`get_character_lineup`、`assign_character_version` を追加。ChatGPT本体へのプラグイン接続はまだ行っていない。
- 運用ルール：LinuxのローカルGitでコミット/マージ、GitHubのpushはユーザーに委ねる。既存株価予測V6へ書き込みしない。

## Sprint 07：チュートリアル育成・キャラ装備

- `growth.py` でローカルの育成進捗と装備を管理。保存場所はGit管理対象外の `local_state/growth.json`。保存済みモデルやV6のファイルには触れない。
- 初参加20XP、2体以上へ配分10XP、配分合計100%で10XP。**各実績は各キャラ一度きり**で最大40XP。XPは運用損益・的中率・相場に連動しない。Lv1→Lv2(20XP)→Lv3(40XP)はゲーム表示用。
- 装備なし、集中レンズ(20XP、トレンド感度+10)、ひらめきの飾り(30XP、モメンタム感度+15)、静寂の輪(40XP、ボラティリティ感度+15)。上限150で補正。装備効果は**架空相場の練習実行時のみ**に反映し、元の予測モデル・保存モデルを変更しない。精度向上を意味しない。
- `GET /api/growth` で育成状態を確認。`POST /api/training/complete` はサーバー側で練習計算し、明示的操作のときにのみ実績を登録。`POST /api/growth/equip` で装備を選ぶ。すべてローカル、revision競合保護・原子的ファイル保存あり。
- `POST /api/practice` は従来通り読み取り専用。編成モデルに装備補正を適用したシミュレーションを実行。`characters.*.effective_sha256` で使用した一時モデルを区別。
- `/game` で経験値・レベル・装備の選択、練習後にXP取得。MCPの `get_creature_growth`、`complete_creature_training`、`equip_creature_gear` も利用できる（ChatGPTアプリ登録は未実施）。

## Sprint 08：架空チャレンジで独立した3指標を比較

- `challenge.py` は固定の架空シナリオ（`rising` / `falling` / `sideways`、各12ステップ）を定義し、3キャラに**同じ価格履歴**と**各自10,000ゲーム内コイン**を提供する。すべてローカル・読み取り専用。
- **未来参照の禁止**：各ステップ開始時点に観測済みの価格だけで予測確率を算出・取引判断し、次の価格とUP/FLAT/DOWNの実現結果はその後で評価。横ばい判定は前日価格比 `±0.8%` 以内。
- **Brier Score**：3クラスの二乗誤差の合計を12ステップ平均（低いほど良い）、**損益**：手数料込みの架空コイン額（高いほど良い）、**最大下落率**：ポートフォリオのピーク比下落幅（低いほど良い）。別々の順位を示し、**総合優勝を作らない**。同点は同順位。的中率も参考表示。
- モデルは現在の自作キャラ、保存モデルから割り当てたルナとミドリ、育成装備補正の組み合わせを反映。ただし元の保存モデル・編成・育成XPを変えない。
- `POST /api/challenge/run`：シナリオIDの allowlist、Brier・損益・リスク・監査用予測履歴・SHA256を返す読み取り専用の計算。`GET /api/challenge/scenarios`：固定シナリオ一覧。MCPにも `list_challenge_scenarios` と `run_challenge_comparison` を追加。
- `/game` に「05 チャレンジ・対戦モード」を追加。3指標に独立順位を表示。練習成績・予測誤差をXPとして付与しない。
- **重要**：少数の固定された架空シナリオを繰り返して最適化しても、実市場への予測能力は検証できない。評価モデルの調整や投資判断には使わない。
- GitHubへのpush・アカウント操作はしない。ローカルGitだけで開発を管理する。

## Sprint 09：MCPと説明書の一元化

MCPサーバーは引き続き1つ。機能別サーバー分割や旧ツール削除は行わない。
AI向け操作マニュアルは [MANUAL_FOR_AI.md](MANUAL_FOR_AI.md)。
`GET /api/meta` はPythonレジストリ由来のプラグイン一覧・シナリオ一覧・マニュアルを返す。
MCPの `get_creature_manual` を最初に呼べば、操作方法と利用可能な分析IDを確認できる。
個別ツールの機械可読な入力スキーマはそのまま残し、無差別な汎用API実行ツールは作らない。
Node/Pythonの統合とインターネット公開は実施していない。Geminiの既存ローカルMCP SuperAssistantと、
Web版ChatGPTからの外部接続要件は区別する。

## Sprint 10：Gemini MCP SuperAssistantとのローカル接続

既存の `mcp/server.mjs` から `makeMcpServer()` を共有して `mcp/stdio.mjs` を追加。
MCP SuperAssistantにはこのstdioを1件登録し、**同じ21ツール**を利用する。
追加の公開HTTPポートは作らず、PythonのゲームAPI `127.0.0.1:8765` を内部で利用。
ローカルの `~/.config/mcp-superassistant/config.json` は既存設定をバックアップのうえ更新。
ブラウザ拡張では読み取り専用10ツールのみ有効化、書き込み系11ツールは無効のまま。
MCPサーバーのツール一覧認識とstdio統合テストは成功。
**Gemini Argonでの実際のツール呼び出しは未検証**：公式手順に従い新規会話でMCP用Instructionsを挿入する必要があり、実験時は操作指示が旧ツール一覧のまま残った。

## Sprint 13：実在の日本株を使う実相場リプレイ（ローカル専用）

/game のチャレンジは「実相場リプレイ」を先頭表示。日本株4〜5桁コードと過去の終了日を選び、J-Quants API V2の日次原終値(C)を実際に取得し、直近52営業日のうち前40営業日でモデル準備、後12営業日で1日ずつ予測し対戦します。3キャラが同じ履歴で比較され、仮想コイン・予測Brier・均等予測・過去頻度の順位は独立。結果の詳細は任意展開です。旧架空シナリオは明示的な練習モードでのみ利用できます。

使用データ提供元: J-Quants API V2 `/v2/equities/bars/daily` と `/v2/markets/calendar`。Pythonサーバー起動時にのみ、環境変数 `JQUANTS_API_KEY` を安全に設定してください。設定値をHTML・URL・Git・チャット等に書かないでください。例: 端末上で `export JQUANTS_API_KEY=...\` はシェル履歴にキーを残す危険があるため、直接入力よりシークレット管理や一時環境変数の安全な注入を推奨します。キー未設定時は実相場モードを無効化し、架空データへの黙ったフォールバックはしません。

新ローカルAPI: `GET /api/market/status` は設定済みかどうか（秘密そのものは返しません）、`POST /api/market/replay` はJSON `{"code":"7203","end_date":"2025-06-30"}` を受けます。過去の日付と銘柄・API利用契約に応じて利用可否が決まります。JPX個人向けJ-QuantsのFreeプランは直近12週間のデータを取得できないため、無料利用時はそれ以前の日付にしてください（契約範囲を要確認）。HTTP429・認証・価格欠損・株式分割を検知したら停止します。

**重要:** 厳密なその当時のデータ版を再現するPoint-in-Time監査ではありません。補正前終値を使い、株式分割等が含まれる52営業日を拒否します。データは改訂されうるため、履歴上の成績が将来の予測力を示すわけではありません。実売買・口座接続・現金移動・発注なし。取得データの再配布禁止（J-Quants個人向け利用規約）。公開Sitesへは実株価・プレイヤー結果を配信しないこと。

### Sprint 14 — イラスト付きモデル案のDRAFT制作（ローカル限定）

`http://127.0.0.1:8765/create`（`/game`から移動）で、任意のイラスト、名前、申告した設定・性格・スタイルから3候補をプレビューし、1案を変更不可のDRAFTとして保存できます。
「絵のAI解析は未接続: イラストは外見、候補はあなたが選んだ性格・設定から生成」。性格だけを決定的な対応表に使い、自由文は保存のみ。実際の指標レジストリとModel検証を使用します。未学習・性能未検証で、実相場対戦には参加できず、既存3キャラに影響しません。

API: `GET /create`, `GET /api/blueprints`, `POST /api/blueprints/preview`, `POST /api/blueprints/create`, `GET /api/blueprints/{id}/image`。POSTはJSONで `name`, `concept`, `trait`（balanced/energetic/cautious/analytical）, `style`, 任意の `image_data_uri` を指定。createには候補の `candidate_id`（trend/reversion/balanced）を追加。全ルートでloopback接続・Host・Origin・転送ヘッダーを検証し、公開Sitesでは提供しません。

専用本文上限は約1.34 MiB（旧APIは8192 Bのまま）。画像はPNG/JPEG/WebPのbase64 data URI、1 MiB以下、magic byte照合（完全な画像デコードではありません）。固定IDのファイル名でGit対象外の `local_state/created_visual_assets/` に保存し、`created_blueprints.json` を原子的更新。最大50件・画像合計20 MiB。asset・blueprint・将来のtraining_job・deployed_model_versionは分離し、後者2つはnullです。

検証: `python3 -B -m unittest discover -s tests -v`、`npm ci --prefix mcp && npm test --prefix mcp`。制限環境では既存HTTPテストのsocket、Nodeの子プロセス、依存取得DNSが拒否されるため、通常のローカル端末で全件を再実行してください。ブラウザーでのモバイル表示・画像選択・3候補・保存後リロードの確認は別途必要です。

### Sprint15: 下書きから架空データで学習

`/create` の保存済みカードで「架空データで学習して比較」→「練習版保存」。
プレビューは読み取り専用。固定架空40点だけを使い、4指標の重みを20刻み・
合計100の56候補から学習平均3クラスBrier最小で選びます。期間・感度・
リスク比率は元の下書きのまま。同点は元の重みへのL1距離、登録順の辞書順で決定。
0始まりの判断index 20..31（12件）で学習し、32..38（7件）で検証します。
各入力はindexまでの価格だけで、次の価格のラベルは特徴生成後に計算します。
`trained_until=32` は最後の学習ラベルの価格index（最後の判断indexは31）。
元の案の学習・検証Brierと均等予測2/3も独立に表示します。改善は保証しません。

`POST /api/blueprints/train-preview` / `train-save` は `{ "draft_id": "bp_…" }`
のみ、最大8192バイト、既存と同じ厳格なローカル制限。保存は
`local_state/trained_versions.json` に最大100件、原子的に追加し、モデル版と
学習記録を分離します。`GET /api/blueprints/trained` は安全なメタデータのみ。
画像・任意Python・外部価格入力・実相場評価・ゲームへの反映はありません。
固定架空40点での学習演習。実相場の能力を証明しない。検証期間は選択に使わない。
繰り返し比較・手動選択でも過剰適合するため、検証成績は研究上の汎化性能ではありません。

### Sprint 16: 2D 着せ替え

`/create` の保存済みDRAFTで「2D 着せ替え」を開き、アクセサリー1枚を選んでX/Y位置・サイズ・表示を調整し「外見を保存」します。**外見だけの変更。予測性能は変わりません。** ベース絵がなければ中立のCSSフレームを表示します。2Dが基本で、3D・アニメーション・実際のvision解析・AI画像生成はありません。ユーザー画像からPythonコードを実行することもありません。

外見は独立したschema 1の `local_state/looks2d.json` と `looks2d_assets/` に保存します（最大50件、合計20 MiB、PNG/JPEG/WebP各1 MiBまで）。`layers` は配列ですが現在は1枚のみ。画像未指定の保存は既存アクセサリーを維持し、表示OFFで隠せます。位置は中心から±100%、サイズはフレームの10〜200%。枠外は切り取ります。署名検証は完全な画像デコードではないため、破損画像はブラウザで表示できない場合があります。保存データ破損時は上書きせず停止します。既存DRAFT・練習版・ゲーム保存・予測重み・スコアは変更しません。

同一端末限定API: `GET /api/looks2d?draft_id=bp_…`、`POST /api/looks2d/save`（JSON上限1.5 MiB）、`GET /api/looks2d/{draft_id}/accessory`。保存JSONは `draft_id, accessory_data_uri, position_x_pct, position_y_pct, scale_pct, visible` のみ。ローカルHost/Origin検証は制作APIと共通です。

### Sprint 18 パーツ工房

`/assemble` で期間・仮想配分コアと2〜4個の分析パーツを選び、相対配分を合計100%に正規化して試せます。固定架空データのプレビュー後に不変のDRAFTを保存し、`/create` のギャラリーで確認・学習できます。手動DRAFTの学習は当初0%の指標を再有効化しません。実相場の精度を示す機能ではありません。設計と検証上の制限は `docs/SPRINT18_PARTS_DESIGN.md` を参照してください。

## Sprint19 — isolated character PACK MVP

Convert a local single-frame PNG/JPEG/WebP to a **new** PACK directory (Pillow is
required and available in this environment; no downloads or remote services):

```bash
python3 scripts/character_pack_cli.py --input sample.png --output /tmp/my-character-pack
```

Open `/pack-lab` on your own clone server, or open `web/pack-lab.html` directly
as an offline file. Choose the generated directory; alternatively select
`manifest.json`, `original.png`, and all files inside `parts/` together. This
screen does not upload files, call APIs, or write local/game state. It exports
full-resolution transparent PNG, or WebP when supported by the browser, using
Canvas2D `toBlob`. Preview checkerboarding is CSS only. Directory picking and
`createImageBitmap` require a supporting modern browser; individual file picking
is provided as an alternative. Nothing was added to `/create`, `/assemble`, the
MCP API, model code, or save schemas.

PACK v1 contains `manifest.json`, `original.png`, `parts/layer_00.png` etc., and
`source.psd` only for PSD input. JSON fields are `manifest_version: 1`, `canvas`
(`width`, `height`), `source` (`kind: image|psd`, original bytes' `sha256`),
`mode_default: fallback|layers`, and `layers` (`id`, `slot`, `path`, `z`,
`visible`). Unknown slots use `unclassified`; z is unique and sorted ascending.
`warnings` is optional diagnostic text. Generated PNGs are fixed-canvas RGBA,
straight alpha, with an sRGB marker; embedded raster ICC profiles are converted
where supported, and untagged input is assumed sRGB. No image segmentation or
slot inference is claimed. A simple raster has a separate standalone layer
with the same pixels as the original. **Fallback draws only `original.png`;
layers mode draws only visible parts**, so translucent pixels are never doubled.
`character_packs.load_pack(path, mode='layers')` validates/reimports canonical
PNG packs without writing anything. Browser-only imports also accept WebP parts.

Limits: local regular files only, no URLs or symlinks in any path component;
source ≤20 MiB, each canvas side ≤4096, ≤64 layers (PSD groups also count),
output ≤300 MiB. Browser compressed files and retained decoded surfaces are
bounded to 300 MiB, with at most 67 files and 70 MiB per image, manifest ≤128 KiB,
and preserved PSD ≤20 MiB. Converter also restricts decoded surface totals for
browser compatibility. PNG/WebP headers and actual decoded dimensions are
checked in the viewer; animated WebP and unusual WebP chunk layouts are not
supported. Only canonical paths `original.png` and `parts/<safe-name>.png`
(or `.webp` in the browser) are accepted. Failed conversion removes its temporary
sibling directory. Publication uses Linux `renameat2(RENAME_NOREPLACE)` so even a
concurrently created destination is preserved. Existing output is never reused.

PSD support is **optional and not installed/tested against a real PSD here**.
The adapter follows psd-tools 1.26 `PSDImage.open`, `PSDImage.composite` and
`layer.composite`: header dimensions/size are checked before parsing; normal
layers use bbox offsets; each top-level group is flattened once (its children
are not emitted again). Masks are delegated to psd-tools. Clipping, effects,
unsupported blends, excess layers/bounds, or parser failures produce a detailed
error suggesting a merged PNG. The visible layer composite is compared with the
merged reference; differences emit a warning and default remains fallback.
Opacity, color management, group behavior and masks can differ. This is not a
promise of Photoshop fidelity. Raw PSD bytes are preserved only within limits.
Tests cover missing-module behavior and a fake PSD adapter, not real PSD fidelity.

The renderer is **Canvas2D, not PixiJS**. A future offline PixiJS v8 adapter can
reuse the validated manifest, sorted exclusive render plan and fixed canvas,
then use `renderer.extract.canvas` for transparent exports. It must bundle its
own dependency locally and pass the same alpha/visibility/mode tests; no CDN or
Pixi dependency has been introduced in Sprint19.

Validation commands:

```bash
python3 -m unittest discover -s tests -v
node --experimental-test-isolation=none --test mcp/tests/pack-lab-ui.test.mjs
(cd mcp && npm test)
git diff --check
```

In this restricted sandbox the Python suite reached 116 tests: 115 passed; the
existing `test_live_meta_contains_manual_registry_and_scenarios` cannot bind an
ephemeral socket (`EPERM`). Full Node tests are also incomplete: MCP SDK is absent,
and the existing challenge UI test cannot spawn Python (`EPERM`). No dependencies
were installed to bypass those restrictions. New Node tests execute the actual
inline script with mocked browser APIs; real browser visual/export QA and real
PSD checks remain for the independent review environment. Do not restart or use
the original live server for these checks.

## Sprint 21: V6設計を参考にした予測記録（オフライン専用）

株価予測V6の次のコードを**読み取りのみ**で確認したうえで、Creature Lab
独立実装の `forward_journal.py` を追加した。

- `13_株価予測/engine/forward_storage.py`：予測記録のcreate-only、
  同一内容での再試行、内容競合時の拒否、SHA-256検証、保存後の再読込。
- `13_株価予測/research/small_mvp/core.py`：as-of日付と次の対象営業日を
  厳密に区別し、過去の研究再生を本番の先行予測と誤認しない。
- `13_株価予測/engine/parallel_models.py` および
  `research/scanner/evaluation.py`：UP/FLAT/DOWNのBrier合計
  （3で割らない）と評価前のモデル・入力固定。

Creature Labの新しい記録は `mode=OFFLINE_REPLAY_ONLY`、
`forward_eligible=false` を必須とする。受け取った日時が予測作成日時より
後の入力、指定カレンダーで翌営業日ではない組合せ、確率合計が1でない場合は
保存できない。モデルと入力のSHA-256を記録し、予測と結果を**別々のファイルに**
一度だけ記録する。結果はBrierと均等予測の参考値を保存し、
**損益・経験値・装備・公式の予測実績には反映しない**。保存形式はSHA-256
付きの普通のローカルJSONであり、悪意あるローカル管理者からの改変を
完全に防ぐ電子署名/WORMではない。保存先は呼出側が明示的に渡す。
ネットワーク取得、バックグラウンド起動、GUI/APIからの自動実行は未接続。

V6のモデル本体、学習済み成果物、J-Quants取得データ、Official、
Freeze、既存ログは読み込まずコピーもしない。V6のコードや設定を
Creature Labへ直接importする依存関係も作らない。将来の実時間版では
営業日カレンダー・価格公開時刻・利用権限・実時計の検証が別途必要。
過去リプレイの結果を「本当に翌日の予測が的中した」と表示しない。

オフライン記録の使用例（この実行例は仮のSHA値・架空確率なので
**実市場の予測実績を意味しない**）：

```python
from pathlib import Path
from forward_journal import freeze_offline, settle_offline

root = Path("local_state/offline_forecast_demo")
forecast = freeze_offline(
    root, run_id="trial1", as_of_session="2026-10-29",
    target_session="2026-10-30", calendar=["2026-10-29", "2026-10-30"],
    generated_at="2026-10-31T03:20:00+09:00",
    input_available_at="2026-10-31T03:19:00+09:00",
    input_sha256="a"*64, model_sha256="b"*64,
    probabilities={"UP": .5, "FLAT": .3, "DOWN": .2})
outcome = settle_offline(
    root, run_id="trial1", target_session="2026-10-30",
    actual="DOWN", outcome_available_at="2026-10-31T03:21:00+09:00",
    outcome_sha256="c"*64)
```

検証: `python3 -B -m unittest tests.test_forward_journal -v`、
`python3 -B -m unittest discover -s tests -q`、`(cd mcp && npm test)`。

## Sprint 22: Game runtime migration (JavaScript game math, Python forecasting)

**Migration direction:** use TypeScript/JavaScript for the Web game, gameplay
state/progression, economy, eventual Node.js game API, and scheduled leagues.
Keep Python for model calculation, feature extraction, and offline research.
The two sides will exchange a deliberately small versioned prediction
contract. The game must not import the V6 repo or execute arbitrary model code.

### First completed migration seam

- `game_runtime/practice.mjs` implements the **pure JavaScript synthetic
  practice economy**: per-character allocation, LONG/CASH position changes,
  virtual fees, equity trajectory, drawdown, benchmark, and result formatting.
  It accepts prediction signals and model metadata as **inputs**. It never
  imports Python or accesses files/network; it never places real trades.
- `tests/practice_parity_fixture.py` is a **test-only** exporter. It asks the
  existing Python model for time-prefix-based signals and computes the
  reference output using the old Python game implementation.
- `mcp/tests/game-runtime.test.mjs` verifies exact/near-exact parity for four
  scenarios (solo, three participants, zero allocation, changed model) and
  rejection of malformed inputs, without changing user data.
- **Not yet switched:** `/game` and `/api/practice` still use the old
  Python server. Saved models, XP, gear, and account state stay untouched.
  No Node game API or independent scheduled server is running yet.

### Migration sequence

1. Keep the JS simulator as a parity-tested replacement candidate.
2. Move the *gameplay API* and storage into Node.js, with model-only forecasts
   obtained from a narrowly defined local Python predictor interface.
3. Validate server-side game economy and reward claims, then route the Web
   game to Node.js. Browser computations alone are not authoritative for
   multiplayer rankings or XP.
4. Only after parity and storage checks, retire the corresponding Python game
   handlers. Preserve existing local state and revision history.
5. Build the actual offline-progress scheduler and league on the Node server;
   do not claim that synthetic replays are live forward predictions.

Recheck with `node --test mcp/tests/game-runtime.test.mjs`,
`(cd mcp && npm test)`, and
`python3 -B -m unittest discover -s tests -q`.

**Important:** This is a phased migration, not a claim that all game logic has
moved from Python. The V6 forecasting repository and the existing Creature
Lab servers remain independent and unchanged.

## Sprint 25: Node.js 実ゲームAPIの独立プレビュー（既存ゲーム無変更）

旧サーバーとは**別の** `127.0.0.1:8890` に、新しいゲームの最小画面と
`POST /api/practice` を実装。ゲームの計算はJavaScript、
Python `game_runtime/predict_bridge.py` は固定の架空価格に対して
`engine.Model` から予測シグナルを作るだけ。**ユーザーがコイン残高、
予測確率、信号やリターンを送信することはできず**、要求は
`{"allocations":{"mine":100,"owl":0,"turtle":0}}` のみ。
Node.js が現在のモデル状態、保存済み編成、装備を既存ローカルPython
サーバーの読み取りAPIから取得し、Python予測を呼び出し、
ゲームのコインと損益をJavaScriptで計算する。
処理の前後で各revisionを読み直し、途中にモデル変更があれば競合で停止する。
旧Pythonの練習結果と同じ数値・判断になることを検証済み。

新しいプレビューは**架空12ステップ限定で読み取り専用**。
XP、モデル保存、装備変更、ランキング更新、実発注、実市場データ取得は
実装せず、明示的に無効化している。Node.jsがV6を直接importしたり
V6のOfficial / Freeze / 履歴・評価結果を書き換えたりしない。
元の `8765` サーバーは再起動せず、保有しているモデルrevisionを
維持する。旧版 `8884` も変更しない。

Linuxで別起動する場合:

```bash
cd /home/yugo314/ドキュメント/14_予測クリーチャー
node game_runtime/server.mjs
# 同じLinuxのブラウザから http://127.0.0.1:8890/game
```

接続元はループバック、HostとOriginは同一ローカル画面のみを許可。
`/health` は新ゲーム用Node.jsサーバーの稼働状況を返す。
Python既存サーバーは `127.0.0.1:8765` で動作している必要がある。
Nodeを公開サーバーにそのまま公開してはいけない。
現段階でのlocalhost同一PC利用はログイン・認証済みの公開サービスではない。

**今後の移行**: 既存の `web/game.html` はまだPython版APIを使用。
このNodeプレビューを同じ結果・UXに育ててから旧ゲームを切り替える。
育成の保存・ユーザー別DBは次の別スプリントで設計する。
Nodeへの移行が完了するまでは「Pythonは予測専用」は未達。

検証:
`node --test mcp/tests/node-game-api.test.mjs`、
`(cd mcp && npm test)`、
`python3 -B -m unittest discover -s tests -q`。
ブラウザで `8890/game` → 「練習スタート」を押し、
12日の結果が表示され、XPと実績に反映されないことを確認。

## Sprint 26: Nodeゲーム育成・装備・XP保存

**JavaScript版の実ゲーム処理を進める**ため、
`game_runtime/growth.mjs` にチュートリアル実績・XP・装備の
Node.js版を追加した。既存のPython `growth.py` と同じ
`schema:1`、スロット `mine/ owl/ turtle`、実績
`first_practice/diversify_slots/full_allocation`、XP=20/10/10、
装備の解放条件を守る。予測精度・ゲーム内損益とXPは独立。

**保存は必ず分離する。** Nodeの書込先は
`local_state/node_game/growth.json`。
元の `local_state/growth.json` が存在する場合、Nodeの保存先が
**まだ存在しない間だけ**旧ファイルを読み取り、最初の変更時に
Node用ファイルへ取り込む。旧ファイルへの書込みは一切しない。
Node用ファイル作成後は、旧ゲームの育成実績変更は自動同期しない。
**同時編集の競合を避けるため**、PythonゲームとNodeゲームを
完成まで別のプレビューとして使う。Node側は単一ライターを前提とした
ローカル版であり、複数プロセス・複数アカウントの本番サービスはまだ対応しない。

新しいNode画面 `http://127.0.0.1:8890/game` でできること:
- `GET /api/growth`: 育成状態と装備の解放条件を表示。
- `POST /api/practice`: 架空の12ステップ練習を実行し、結果と
  **一度だけ使える10分間の受取券**を返す。チケットはサーバー内だけに保存。
- `POST /api/training/complete`: 終了後に利用者が明示的に
  `{"ticket":"<発行済み48桁>","expected_growth_revision":0}`
  と送信したときだけXPを保存。実績ごとに一度きり、
  再実行しても同じ実績のXPは増えない。期限切れ・二重請求を拒否。
- `POST /api/growth/equip`: `{"slot":"mine","gear_id":"focus_lens","expected_growth_revision":1}`
  などの装備変更。未解放装備を拒否し、成長revisionが古ければ
  衝突として拒否する。装備感度はNode版予測要求にだけ反映する。
- 保存は同じディレクトリ内の一時ファイルを同期書込み後に置換する。
  競合するNode内部の更新を直列化し、失敗したリクエストはXPを付けない。

ゲーム内の仮想コインや株価リプレイは**保存せず**、
実相場に対する予測的中率やBrier Scoreへ混ぜない。
まだ既存 `web/game.html` のPython版APIを置き換えておらず、
Nodeの専用画面だけでXP・装備を変更できる。
旧 `8765` / `8884` Pythonサーバー、Node MCPの `8766`、
V6のOfficial/Freeze/モデルには変更を加えない。
ユーザー認証、ランキング、Web公開、キャラ共有は未対応。

テスト: `node --test mcp/tests/node-growth.test.mjs` 7件、
`(cd mcp && npm test)` 全60件、
`python3 -B -m unittest discover -s tests -q` 全122件。
ブラウザ実機は旧データと**独立した一時保存先**を使う
`127.0.0.1:8891` で練習→30XP→集中レンズ装備→
保存revision 2、390px幅の横はみ出し無しを確認。

## Sprint 28: TypeScriptの段階導入（既存ゲームを壊さない）

既存のSprint 27（Nodeの12日間・1体で遊ぶ画面）はすでにmainへ
統合済み。その状態を変更せず、まずコイン計算の**入力と出力の型**を
検査できるようにした。

- `game_runtime/contracts.ts`: 3キャラの配分、LONG/CASHの予測判断、
  元モデルの識別情報、架空12ステップの計算結果をTypeScriptで定義。
  `typecheck.test.ts` は誤った「SELL」や「LIVE_TRADING」、
  3枠未満の配分が**型チェックで拒否される**ことを保証する。
- `game_runtime/practice.mjs`: 実行中のJavaScriptエンジンをそのまま使い、
  JSDocで型の情報を付与。TypeScriptでエラーを検出できるようにした。
  既存の価格計算・手数料・丸め方・リターンを変更しない。
- `game_runtime/tsconfig.json`: 厳格な型チェックのみ。生成ファイルなし。
  `game_runtime/package.json` とlockfileには開発用TypeScript 5.9.3
  のみを追加。React / Vite / PixiJSなどは**まだ追加しない**。

初回のみ `npm ci --prefix game_runtime`。
型チェックは `npm --prefix game_runtime run typecheck`、
型チェック＋既存ゲーム計算互換性のテストは
`npm --prefix game_runtime test`。
ゲーム全体はこれまで通り `node game_runtime/server.mjs`
で起動できる。画面の `demo.mjs` とPythonの予測ブリッジは変更していない。

**限界**: TypeScriptの型チェックは開発中の間違いを検出するものであり、
ネットワーク越しの入力・不正データを無条件で信用する機能ではない。
従来の実行時の配分・モデル・シグナル検証は残す。
型がそろった次の段階で、画面側・ゲーム処理側を徐々にTypeScript化する。

### Sprint29：私の相棒を作る（Nodeゲーム専用）

`/game` の「私の相棒を作る」では、名前・髪色・服色・重視する予測方法・資金使用率を自分で指定できます。これは **自分で設計した予測ルールのゲーム練習用キャラ** です。編集するたびカスタムchibiを一時プレビューし、「この相棒を保存する」で確定した設定だけを次の架空12日間の練習に反映します。名前は1〜16 Unicode文字、HTMLタグも文字として表示します。色は `#rrggbb`、資金使用率は5〜100%の5刻みです。

保存した得意方法（`trend` / `momentum` / `reversion` / `volatility`）だけを mine の `plugin_weights` で100、他を0にし、資金使用率を `risk_fraction` に適用して Python の予測を呼び出します。上昇判断時にその割合の仮想資金を使い、残りは現金待機します。既存の装備感度は併用し、元の `base_model` と owl・turtle の意味は維持します。未作成時は従来の標準モデルで動きます。色と読み込みDRAFT画像は外見だけです。画像表示からカスタムchibiに戻せます。

- `GET /api/companion`：`{revision, created, companion}`。未作成時はrevision 0とdefaultを返し、GETだけでファイルは作りません。
- `POST /api/companion`：`{expected_revision, companion: {name, hair_color, clothing_color, approach, risk_percent}}` のみ。古いrevisionは409、不正入力は400。同一Nodeプロセス内で保存を直列化し、専用ファイルへ原子的に保存します。
- 保存先はignoredの `local_state/node_game/companion.json`。旧 `growth.json`、Python版保存データ、V6別repoは変更しません。テストは一時ディレクトリを使います。
- `/api/practice` は引き続き配分だけを受け取り、ブラウザから予測・利益を受け取りません。結果の `companion_name` / `companion_revision` / `companion_created` / `approach` / `risk_percent` と実効モデル識別情報で保存設定の適用を確認できます。未作成時のapproachはnullです。計算中に相棒revisionが変わると409で結果と受取券を返しません。

**V6の学習済みOfficialに一切影響しません。** 相棒設定による予測と損益は架空相場のゲーム練習専用で、実相場の本番実績には混ぜません。モデルの発注・自動売買も行いません。外部ユーザー認証や複数ユーザー・複数Nodeプロセスの同時書込みには未対応です。今後の課題は、複数相棒の管理、判断理由の説明、ユーザー単位の認証と保存分離です。

## Sprint 30: ChatGPTプラグイン向けのNode版「自作相棒」接続口

旧Pythonゲーム用MCP (`8766`) と分離して、
`mcp/companion-chatgpt.mjs` に3ツールの私用MCPサーバーを新設。
ChatGPTなどのMCPクライアントが
`get_my_companion` で現在の相棒設定・revisionを読み、
`save_my_companion` で本人が決めた5項目を保存すると、
**NodeのWebゲーム(`8890`)と同じ保存データへ反映する**。
逆方向の変更も読み取りに反映される。
`get_my_creature_growth` は育成XPを読み取るだけ。

ローカル入口: `http://127.0.0.1:8896/mcp`。
stdio入口: `node mcp/companion-stdio.mjs`。
既存MCP・旧Python・V6は変更しない。XP増加・モデル改変・
仮想利益の偽装は受け付けない。
一般公開の認証は未実装なので、非認証の公開トンネルは作らず
**ChatGPTへの実際の接続にはOpenAI Secure MCP Tunnelと利用権限が必要**。
詳しくは `mcp/README.md` を参照。

## Sprint 32：ChatGPTで試してから保存する

MCP `preview_my_companion` は未保存の名前・髪色・服色・得意分析・
資金使用率を一時適用し、Nodeゲームに架空12ステップの試遊を依頼する。
`POST /api/practice/preview` は通常練習と予測計算を共用するが、
XP用の受取券は生成せず、ゲームの保存ファイルも編集しない。
`list_my_trained_brains` で過去の学習版を取得して試遊することも可能。
気に入った候補の保存は既存 `save_my_companion` で本人の意思により行う。
MCP登録・安全な外部接続は未完了。詳細は `mcp/README.md`。

## Sprint 33: 自分で組み立てる2Dパーツ（NodeゲームとChatGPT MCP）

Node `/game` の「髪型・表情・飾りを組み立てる」から、髪型（ボブ／ロング／ツインテール）、
表情（にっこり／おっとり／きりっと）、飾り（リボン／眼鏡／星／なし）を選べます。
3×3×4＝36組、従来の髪色・服色と組み合わせ可能。CSSの2Dキャラをその場で
プレビューし、**保存操作をしたときだけ**設定が確定します。
保存済みDRAFT画像は引き続き別枠で選べ、表示パーツを編集するとCSSの自作chibiに戻ります。

外見は `local_state/node_game/looks.json` に専用保存。旧 `companion.json`、
予測・XP・学習済み練習版・V6は更新しません。
`GET/POST /api/looks` は保存revisionを確認して古い上書きを拒否します。
ChatGPT側MCPにも `get_my_look` と `save_my_look` を追加し、
Webと同じ外見が双方向で同期します（外部ChatGPTへの正式登録は別途必要）。

**限界**: 現在の3つの髪型はCSSで描いた簡易2Dパーツで、生成イラストの
自動分割や任意画像のパーツ編集ではありません。ゲーム中の予測結果による
キャラ表情の変化はこれまで通りで、選んだ表情は通常時の顔のデザインです。

## Sprint 34：自分のイラストをそのままゲームに持ち込む

Nodeゲーム `http://127.0.0.1:8890/game` の「私のイラストを重ねる」から、本人が作った
**完成イラスト1枚**をアップロードして、ゲーム画面の相棒として使えます。
PNG/JPEG/WebPをローカルで選ぶと未保存プレビューになり、明示的にSAVEを押した
画像だけが別ファイルに保存され、再読み込み後も表示されます。
任意で、事前に切り抜いた髪・顔・服の透過PNG/WebPを同じサイズのキャンバスで
重ねられます。**1枚のイラストを自動分割する機能は未実装**で、透過パーツは手作業や
外部ツールで用意します。元の画像バイトは加工せずに保存します。
従来のCSS chibiと保存済みDRAFT画像へ戻る操作も残っています。

- `GET /api/artwork`：保存済みの有無、各画像の形式・サイズ、revisionのみ。画像データは返さない。
- `GET /api/artwork/image/base|hair|face|outfit`：画像のみ。形式・マジックバイトを検証し、no-storeとnosniffのヘッダーを付ける。
- `POST /api/artwork`：`{expected_revision,slot,image:{mime,base64}|null}`、画像の保存または明示的な削除。古いrevisionは409。
- 1枚450KBまで、最大4枚、各枠はPNG/WebP（完成絵のみJPEG可）。SVG・GIF・HTML・任意URLは使えない。
- 保存先はGit管理外の `local_state/node_game/artwork.json`。画像スロットの情報と元データを原子的に保存。
- モデル・XP・コイン・学習版・V6、既存 `companion.json` と `looks.json` の意味は変えない。

MCP `get_my_artwork` は保存済み画像のメタ情報だけを読み取る（計8ツール）。
現段階でChatGPTから画像ファイルを直接転送・生成・パーツ分離するツールは実装していない。
正式なChatGPTプラグインとしての外部登録も引き続き別途必要。
