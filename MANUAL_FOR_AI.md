# Creature Lab：AI操作マニュアル（Sprint 9）

## 1. 利用範囲
Creature LabはLinuxのローカル環境で動く**架空相場の教育用ゲーム**です。実際の株価や資金・口座への接続、発注、現実の投資予測は行いません。別プロジェクト `13_株価予測`（V6）、そのFrozen/Official/既存Gitを操作しないこと。ファイル操作やOSコマンドの実行をMCP経由で代替しないこと。

## 2. 接続構成
- アプリ：`http://127.0.0.1:8765/`（Python `app.py`、`/game`もあり）
- MCP：`http://127.0.0.1:8766/mcp`（Node `mcp/server.mjs`）
- **2プロセス・MCPサーバー1つ**。外部公開・認証なしのMCPとして運用しない。localhostと既存の信頼済みローカルブラウザ拡張経由に限定。
- AIは最初に `get_creature_manual` で本説明書と動的プラグイン一覧を確認する。ツールのJSON Schemaが入力の機械可読な契約であり、この文書はそれを置き換えない。

## 3. 操作の原則
- **読み取り優先**：まず `get_creature_state`、`get_character_lineup`、`get_creature_growth`、`list_saved_models` などで現在値・revisionを取得。
- **明示的な変更のみ**：モデル変更・保存・復元・XP付与・装備変更はユーザーが意図する時だけ呼ぶ。
- **競合対策**：編集APIには直前の `expected_revision`、キャラ編成は `expected_lineup_revision`、育成は `expected_growth_revision` を指定。409 conflictやツールの isError を受けたら状態を読み直し、勝手に上書きしない。
- **検証**：4プラグインの重みは各0〜100の整数、合計100%。感度は各50〜150の整数。入力キーは常に最新の `plugins[].id` を用い、存在しないIDを捏造しない。
- **予測の解釈**：合成価格でのUP/FLAT/DOWN確率と、固定12日間のBrier・損益・最大下落率は練習数字。過学習の危険があり投資助言ではない。

## 4. MCPツールと主な用途
| 読み取り | 目的 |
|---|---|
| `get_creature_manual` | この説明書、最新の内蔵分析一覧、シナリオ一覧 |
| `get_creature_state` | 現在のモデル、予測、revision |
| `list_creature_parts` | 目・盾の装備一覧 |
| `list_analysis_plugins` | 登録済み分析プラグイン |
| `list_saved_models` | 名前付き保存モデル |
| `get_character_lineup` | ルナ/ミドリのモデル割当、編成revision |
| `get_creature_growth` | 3体のXP、解放装備、育成revision |
| `list_challenge_scenarios` | 固定架空シナリオ一覧 |
| `run_coin_practice` | 架空コイン練習。XP記録なし |
| `run_challenge_comparison` | Brier・仮想損益・最大下落率の独立順位 |

| 書き込み | 目的 |
|---|---|
| `set_eye`, `set_shield`, `set_model_parameters` | 目、仮想配分リスク、期間の変更 |
| `configure_analysis_plugins` | 全プラグインの重みを登録済みIDで設定 |
| `set_plugin_strengths` | 全プラグインの感度50〜150を設定 |
| `set_analysis_plugins` | 旧式の3+1重み設定（互換用） |
| `save_current_model`, `load_saved_model` | モデルの保存・復元 |
| `assign_character_version` | 保存済みモデルをルナ/ミドリに割当 |
| `complete_creature_training` | 明示的にチュートリアルのXPを記録 |
| `equip_creature_gear` | 解放済み育成装備の選択 |

## 5. 典型的な操作
1. `get_creature_manual()` → `get_creature_state()`。プラグインIDやrevisionを確認。
2. 必要なら `configure_analysis_plugins(weights={trend:20,momentum:20,volatility:10,reversion:50},expected_revision=現在値)`。**例は内蔵4個の場合**。新規追加時は実際の一覧に追従する。
3. `save_current_model(name="検証モデル",expected_revision=更新済みrevision)` で保存（ユーザーの明示依頼時のみ）。
4. `assign_character_version(slot="owl",version_id=保存ID,expected_lineup_revision=現在値)` でルナへ装備。 `version_id=null` は標準モデルへ戻す。
5. `run_coin_practice(mine_pct=40,owl_pct=30,turtle_pct=20)` は**結果を見るだけ**。
6. `run_challenge_comparison(scenario_id="rising")` で3体を公平な初期コインで比較。3指標の総合優勝は作らない。
7. 経験値を受け取るには、別途ユーザーの依頼を確認して `complete_creature_training(...,expected_growth_revision=現在値)` を実行する。

## 6. エラーと安全ルール
- 400：入力キー・型・範囲を再確認。文書にないパスやスクリプトを引数へ入れない。
- 409：状態競合。最新revisionを取得し、変更を再確認してから再実行。
- 接続エラー：Linux上で両プロセスが稼働中か確認。外部公開や認証省略で回避しない。
- ローカルJSONは `local_state/` に保存。モデルの保存履歴や育成データをテスト目的で変更しない。
- MCP接続を増やすのではなく、内蔵分析の登録簿を拡張する。**Node/Pythonの全面統合と既存ツール削除は今回行わない**。

## 7. データ源
`GET /api/meta` で本マニュアル・現在の分析プラグイン一覧・固定シナリオを取得。MCPからは `get_creature_manual` を使う。詳細な引数の型・必須条件は各MCPツールの `inputSchema` を優先する。

## 8. Gemini MCP SuperAssistant接続

GeminiのMCP SuperAssistantはLinuxローカルのstdioクライアントとして利用。
`mcp/stdio.mjs` は**既存の同じMCPツールを登録**し、Python `app.py` (127.0.0.1:8765) に接続します。追加のMCP用TCPポートやインターネット公開は不要です。
構成例: `"creature-lab": {"command":"/usr/bin/node","args":["/home/yugo314/ドキュメント/14_予測クリーチャー/mcp/stdio.mjs"]}`。
Node版HTTPサーバー `127.0.0.1:8766/mcp` は既存の接続用に維持し、このGeminiの接続に必須ではありません。

## Sprint 11：チャレンジ詳細
/game の「05 チャレンジ」で結果を表示後、各キャラの「12ステップ詳細」を開閉できます。
既存の contestants.*.history の prediction、predicted、actual、brier、observed_price を表示します。
Brier推移は縦軸0〜2、横軸1〜12。表は横スクロールできます。
確率とBrierは丸め値です。的中率と確率予測誤差、架空損益、最大下落率は別の指標です。
API・MCP21ツール・予測アルゴリズムに変更はありません。

## Sprint 12：予測ベースライン
結果に baselines.uniform / past_frequency（name, history, brier_mean）を追加。
history は step, prediction, actual, brier。既存フィールドは維持。
均等予測は各1/3、Brierは常に2/3（二乗誤差の合計）。
過去頻度はチャレンジ開始時に各方向の擬似カウント1を設定し、
P=(1+当該ステップより前の方向回数)/(3+過去ステップ数)。
開始前の価格履歴は頻度に含めず、正解のカウント追加は評価後。
contestants.*.baseline_comparison.* は mean_difference（キャラ平均−基準平均、負が良い）、
won_steps（丸め前Brierで基準より1e-12超小さいステップ数）。
ベースライン値と差分は丸め前から計算。既存キャラ値・画面は丸め表示。
詳細内で3系列のグラフと各基準の確率表を確認可能。
12ステップでは統計的優位性を証明できず、損益・最大下落率とは別評価。

## Sprint 13：実在の日本株を使う実相場リプレイ（ローカル専用）

/game のチャレンジは「実相場リプレイ」を先頭表示。日本株4〜5桁コードと過去の終了日を選び、J-Quants API V2の日次原終値(C)を実際に取得し、直近52営業日のうち前40営業日でモデル準備、後12営業日で1日ずつ予測し対戦します。3キャラが同じ履歴で比較され、仮想コイン・予測Brier・均等予測・過去頻度の順位は独立。結果の詳細は任意展開です。旧架空シナリオは明示的な練習モードでのみ利用できます。

使用データ提供元: J-Quants API V2 `/v2/equities/bars/daily` と `/v2/markets/calendar`。Pythonサーバー起動時にのみ、環境変数 `JQUANTS_API_KEY` を安全に設定してください。設定値をHTML・URL・Git・チャット等に書かないでください。例: 端末上で `export JQUANTS_API_KEY=...\` はシェル履歴にキーを残す危険があるため、直接入力よりシークレット管理や一時環境変数の安全な注入を推奨します。キー未設定時は実相場モードを無効化し、架空データへの黙ったフォールバックはしません。

新ローカルAPI: `GET /api/market/status` は設定済みかどうか（秘密そのものは返しません）、`POST /api/market/replay` はJSON `{"code":"7203","end_date":"2025-06-30"}` を受けます。過去の日付と銘柄・API利用契約に応じて利用可否が決まります。JPX個人向けJ-QuantsのFreeプランは直近12週間のデータを取得できないため、無料利用時はそれ以前の日付にしてください（契約範囲を要確認）。HTTP429・認証・価格欠損・株式分割を検知したら停止します。

**重要:** 厳密なその当時のデータ版を再現するPoint-in-Time監査ではありません。補正前終値を使い、株式分割等が含まれる52営業日を拒否します。データは改訂されうるため、履歴上の成績が将来の予測力を示すわけではありません。実売買・口座接続・現金移動・発注なし。取得データの再配布禁止（J-Quants個人向け利用規約）。公開Sitesへは実株価・プレイヤー結果を配信しないこと。

### Sprint 14: local draft blueprints

Use `/create` for an optional illustration → three deterministic rule blueprints → immutable DRAFT gallery. Show exactly: 「絵のAI解析は未接続: イラストは外見、候補はあなたが選んだ性格・設定から生成」. Only declared trait selects rule parameters; concept/style text is retained without analysis. No vision, image generation, training, performance claim, battle eligibility, or changes to the three game characters.

Local-only routes: GET `/create`, GET `/api/blueprints`, POST `/api/blueprints/preview`, POST `/api/blueprints/create`, GET `/api/blueprints/{id}/image`. POST fields: name, concept, style, trait, optional image_data_uri; create also needs candidate_id from preview. The server regenerates the selected recipe; never accepts client-supplied Model parameters. Drafts have separate visual_asset, blueprint, training_job=null, deployed_model_version=null, competition_eligible=false. No edit/deploy endpoint.

Blueprint JSON has its own bounded reader (~1.34 MiB); legacy limit stays 8192 bytes. Images <=1 MiB, PNG/JPEG/WebP data URI and signature validation; fixed filenames, private files, atomic catalog, 50 drafts/20 MiB image cap, no public Sites exposure. Storage is only this clone's ignored local_state. Run Python unittest and mcp npm tests; sandbox socket/process/DNS restrictions must be reported as incomplete validation, not a passing full suite. No Playwright/Chrome/Gemini validation was run for this slice.

## Sprint15 appendix — isolated blueprint training

- `training_lab.py` uses stdlib and only `engine.SYNTHETIC_PRICES`, never market feeds
  or challenge scenarios. HTTP only accepts a saved `bp_` UUID; no code/data upload.
- Feature prefixes include decision index (0-based). Train decisions 20–31, targets
  21–32; validation decisions 32–38, targets 33–39. Features precede labels via
  `challenge.actual_direction` (FLAT band .008). Validation is built after selection.
- Exhaustive 56 weight mixtures, multiples of 20, total100; fixed original windows,
  strengths and risk. Objective is unrounded mean multiclass Brier; ties use L1
  distance to draft then registry-order lexicographic tuple. Original model and
  uniform (2/3) are independent baselines, not selection candidates.
- Preview writes nothing. Save recomputes and appends an immutable practice version
  and separate job record atomically to `trained_versions.json` (100 maximum).
  SHA256 records cover full source draft, selected parameters, and fixed dataset.
  `trained_until=32` means last observed training target; it excludes validation.
- No changes to Sprint14 draft schema, image, game saves, active model, market code,
  or MCP's 21 tools. No competition registration or load-to-game endpoint.
- Unit tests: `python3 -m unittest discover -s tests -v`. Training route tests use
  in-memory handlers, no socket/browser. Browser integration QA is a separate task:
  preview a saved draft, inspect collapsed details and scores, save, reload gallery,
  and confirm game state is unchanged. Do not start the user's live service for QA.
- Caveat: 固定架空40点での学習演習。実相場の能力を証明しない。検証期間は選択に使わない。
  Validation can worsen; repeated human choices can also overfit this tiny dataset.

Sprint 16 の外見は2Dが基本。`/create` の保存DRAFT →「2D 着せ替え」で1枚のアクセサリーを重ねる。`looks2d.py` / `local_state/looks2d.json` は独立した外見専用schema。外見だけの変更。予測性能は変わりません。重み・スコア・既存DRAFT・保存モデルを書き換えない。3D、実際のvision、画像からのPythonコード実行、AI画像生成は未実装。絵なしはCSSフレーム。画像検証は既存のコンテナ署名検証であり完全なデコードではない。

## Sprint 18: パーツ組み立て

`/assemble` は独立した手動制作画面です。localhost限定の `GET /api/parts/catalog`、`POST /api/parts/preview`、`POST /api/parts/draft` を使います。POSTはJSON・8192バイト以内。入力は name、任意concept、window_part_id、risk_part_id、analysis（part_id/share/strength）のみ。プレビューは架空観測値だけを利用し、保存は既存blueprintsストアの不変DRAFTです。既存の3候補制作・現行ゲームモデルは変更しません。manual_parts_v1の学習は元の0%指標を保持し、画像・任意コードは予測入力にしません。既存MCPツールは増減していません。

## Sprint19: 独立したキャラ PACK

- `/pack-lab` は `_blueprint_access` と同じローカル制限の GET 静的画面のみ。
  POST/API/MCPツールの追加なし。既存ゲーム・Sprint18・保存schemaは変更しない。
- `python3 scripts/character_pack_cli.py --input sample.png --output /tmp/my-character-pack`
  は新しいディレクトリだけに出力。入力はローカル画像のみ、Pillowで実デコード。
  上書き・symlink・URLは拒否し、失敗時は一時出力を削除する。
- 画面はPACKフォルダまたはmanifestと画像の個別選択を受け付ける。
  アップロード・localStorage・local_state書込みなし。HTML単独でオフライン利用可能。
  fallbackは元画像のみ、layersはパーツのみ。両者を重ねない。
  Canvas2Dで透明PNGと対応ブラウザのWebPを原寸出力する。PixiJSは未使用。
- 画像は最大4096×4096、ソース20 MiB、64レイヤー、PACK300 MiB以内。
  パス・ファイル数・サイズ・実寸を検証する。詳細仕様・追加の展開後上限はREADME参照。
- PSDは任意のpsd-tools 1.26 API向けアダプタ。未導入なら説明付きで停止する。
  通常レイヤーと一度だけflattenしたグループをbboxで配置し、マスクはライブラリに委ねる。
  クリッピング・効果・複雑なblendは拒否。merged referenceとの差は警告。
  Photoshop完全再現・画像解析・学習・対戦への登録は行わない。
- Python追加テストとNodeのPACK UIテストあり。NodeはブラウザAPIのmock検証であり、
  実ブラウザや実PSDを検証済みと主張しない。全体テストのsocket/process制限とSDK欠如は
  READMEに記録。既存のライブサーバーや元プロジェクトをテスト目的に変更しない。
