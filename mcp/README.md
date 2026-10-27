# Sprint 2: ChatGPT用 MCPツール (local-first)

2026-10-27 時点のローカル実装。

## 成果
- Node.js公式MCP SDKを使い、`http://127.0.0.1:8766/mcp` に Streamable HTTP MCPサーバーを実装
- 状態取得 `get_creature_state`、装備一覧 `list_creature_parts`、目の変更 `set_eye`、盾の変更 `set_shield`、パラメータ変更 `set_model_parameters` の5ツール
- Python側の状態 `http://127.0.0.1:8765/api/state` と同一モデルを編集
- browser ⇄ Python ⇄ MCP 間で装備と計算設定が双方向に同期。ブラウザは約1.5秒ごとにrevisionを確認
- 競合防止: `expected_revision` が古いと HTTP 409。編集中のコードを勝手に書き換えない
- 安全境界: 両サービスとも127.0.0.1のみ待受、MCP接続Origin/Host/接続元を検査。外部API、実市場価格、実取引、任意Python実行なし
- 再起動するとメモリ上の設定は初期化される。アカウント認証や永続化は未実装

## 起動（Linux）
別々のターミナルで：

```bash
cd ~/ドキュメント/14_予測クリーチャー
python3 -B app.py --port 8765
```

```bash
cd ~/ドキュメント/14_予測クリーチャー/mcp
npm ci --ignore-scripts --no-audit --no-fund
node server.mjs
```

- キャラ編集画面: `http://127.0.0.1:8765/`
- MCP endpoint: `http://127.0.0.1:8766/mcp`
- MCP health: `http://127.0.0.1:8766/health`

## 自動テスト

```bash
cd ~/ドキュメント/14_予測クリーチャー
python3 -B -m unittest discover -s tests -v
cd mcp
npm test
```

`npm test` はMCPへの接続、ツール列挙、装備変更、コード⇄絵の同期、古いrevisionの拒否、外部Originの拒否を検証する。テスト終了時はモデル定数を元に戻すが、revisionは進む。

## ChatGPTへの登録はまだ未実施

**ローカルでMCPが動作することと、ChatGPTアプリにインストール済みであることは異なる。**
現在は未公開で、ChatGPTからこのローカルURLには接続できない。

現行の公式手順：
1. OpenAI PlatformのTunnel設定で、対応するPlatform組織とChatGPTワークスペースを確認し、利用可能ならSecure MCP Tunnelを作成する。
2. Linux側で`tunnel-client`をローカルMCP URLへ接続して`doctor`→`run`を実行する（組織権限、tunnel_id、ランタイム用APIキーが必要）。**資格情報はこのプロジェクトへ保存しない。**
3. ChatGPT → Plugins → + → Add custom MCP server → Connection: Tunnel から該当トンネルを選び、本人が接続を承認する。利用権限はアカウント／ワークスペースによって異なる。
4. `@Creature Lab` として状態取得→装備変更→確認を実機検証する。
5. もし安全なトンネルが利用できなければ、認証や配布を設計するまで**非認証の公開ngrok等は使わない**。

- 公式: https://developers.openai.com/plugins/deploy/connect-chatgpt
- 公式: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- 公式: https://developers.openai.com/plugins/build/mcp-server

注意: 現在のサーバーはローカル開発・一人利用専用。**公開エンドポイントへ接続してはいけない。**
テスト用の装備変更は局所的に状態を変えるため、ChatGPTで使う場合も書き込み確認を適切に行うこと。

## 動作確認用のChatGPTプロンプト例
- 「Creature Labの現在の装備と架空の予測を教えて」
- 「目をフクロウに変えて、変更前後の予測確率を比較して」
- 「短期4、長期13、リスク比率25%に変更し、絵がどう変わったか教えて」

## 次のSprint候補
- Pluginに直接表示するMCP Apps UI（UI Resource）を開発
- ChatGPTプラグインの実接続（ユーザーの許可・Tunnel接続を要する）
- モデル・装備の保存とバージョン管理
- コインの会計ルールを合成データで厳密に実装
- 任意画像の領域とプラグインの対応付け。将来的な自由作画の土台

## Sprint 03 MCP tools
ローカルMCP経由で `run_coin_practice(mine_pct, owl_pct, turtle_pct)`、`list_saved_models()`、`save_current_model(name, expected_revision)`、`load_saved_model(id, expected_revision)` が利用できます。現在はローカル認証なしの個人用。インターネットに公開しないでください。

## Sprint 04
- `list_analysis_plugins()`: 許可済み3種の分析モジュール一覧と説明。
- `set_analysis_plugins(trend_pct, momentum_pct, volatility_pct, expected_revision)`: 重みの合計100%を必須として更新。実市場・任意コード実行・資金操作なし。

## Sprint 05
`configure_analysis_plugins(weights, expected_revision)` を追加。`weights` は現状 `{"trend":20,"momentum":20,"volatility":10,"reversion":50}` のように全登録プラグインIDを指定、合計100%。旧 `set_analysis_plugins` では `reversion_pct` 省略時に0%とみなす。任意コード実行なし、localhost限定。

## Sprint 06 MCP
`set_plugin_strengths(strengths, expected_revision)`: 登録済みすべてのプラグインIDに整数感度50..150を指定。
`get_character_lineup()`: 保存済みモデルを使うルナとミドリの現行編成・revision。
`assign_character_version(slot, version_id, expected_lineup_revision)`: owl/turtleに保存モデルIDを割当。version_id=nullは標準へ戻す。実売買なし。

## Sprint 07
`get_creature_growth()` は読み取り専用。`complete_creature_training(mine_pct, owl_pct, turtle_pct, expected_growth_revision)` は明示的に練習実績を記録し、同じ課題へのXPは一度きり。`equip_creature_gear(slot, gear_id, expected_growth_revision)` は各キャラの解放済み装備のみ選択可能。練習シミュレーション結果は実際の運用成績ではありません。
