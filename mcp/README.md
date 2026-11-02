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

## Sprint 08
`list_challenge_scenarios()` で架空チャレンジ3種を列挙。`run_challenge_comparison(scenario_id)` で同一の固定架空経路を3キャラに走らせ、3クラスBrier（低いほどよい）、ゲーム内利益（高いほどよい）、最大下落率（低いほどよい）の独立順位を返す。モデル・XP・キャラ編成・保存データは変更しない。実市場精度の検証ではない。

## Sprint 09：共通説明書

`get_creature_manual()` で `MANUAL_FOR_AI.md` と動的な分析プラグイン・シナリオ一覧を取得。
従来ツールはすべて維持。MCPツールの `inputSchema` は説明書では置換できない。
外部向けにMCPポートを無認証で開かない。

## Sprint 10: ローカルGemini向けstdio接続

`node stdio.mjs` は `server.mjs` と**同一のツールレジストリ**を使用。MCP SuperAssistantにはこのスクリプトをstdioサーバーとして1件登録する。Web版Geminiブラウザ拡張のローカル橋渡しとしてのみ使用する。API本体は `127.0.0.1:8765` が稼働必須。ブラウザやnodeの外部公開は不要。

MCP SuperAssistantの公式手順では、**Geminiの新規チャットでMCPのInstructionsを挿入**してからツール実行を依頼する。新しいツールが拡張の接続一覧に表示されても、挿入用Instructionsが古いままのことがあるため、実際のArgon呼び出しが完了するまで接続完了と断定しない。

## Sprint 30: ChatGPTから「自作した相棒」をWebゲームへ接続するMCP

**旧ゲームのMCP (`8766`) とは別サーバー**。既存の旧Pythonモデルの
`set_eye` やコード変更ツールを公開せず、以下の**3ツールのみ**を提供。

| ツール | 説明 |
|---|---|
| `get_my_companion` | Webゲームと共有する自作相棒の名前・髪色・服色・得意分析・仮想資金比率とrevisionを確認（読み取り） |
| `save_my_companion` | 本人が決めた上記5項目を、新しいNodeゲームに保存（書き込み。事前に取得したrevision必須） |
| `get_my_creature_growth` | 新しいNodeゲームの育成XP・装備を確認（読み取り） |

`save_my_companion` はNodeゲームの `POST /api/companion` へ送信するため、
**ChatGPTで編集すればWebゲームに反映され、Webで変更すればChatGPTから読める**。
自作キャラのファイルは今までどおり
`local_state/node_game/companion.json`。このMCP独自の保存先はない。
変更できるのはゲーム用キャラ設定だけ。
実相場への注文、V6予測データ、Pythonゲームの古いモデルやXPを
変更するツールは**追加しない**。キャラ画像をAI生成・保存する機能も未実装。

### Linuxでの起動（新しいNodeゲーム8890が動作している場合）

```bash
cd /home/yugo314/ドキュメント/14_予測クリーチャー
npm --prefix mcp run start:chatgpt
# http://127.0.0.1:8896/mcp  (Streamable HTTP、ローカル専用)
# http://127.0.0.1:8896/health
```

代替のstdio起動（ローカルMCPクライアント／Secure MCP Tunnel向け）:

```bash
cd /home/yugo314/ドキュメント/14_予測クリーチャー
node mcp/companion-stdio.mjs
```

stdio起動はMCPプロトコルの読み書きを使うため、
通常の端末に対話用文章は表示されない。

### ChatGPTの「カスタムMCPプラグイン」として使うための次の接続作業

**8896のローカルURLをChatGPTの接続欄へ直接貼っても使えない。**
また、現状のMCPにはWeb公開向けユーザー認証がないので、
`ngrok` やポート転送を用いて**無認証で公開しない**。

公式の**Secure MCP Tunnel**を使う場合:

1. OpenAI Platformでトンネル作成の権限 (`Tunnels Read + Manage`) と
   対象ChatGPTワークスペースへの関連付けがあるか確認。
   **個人アカウントのプランや権限によって利用できない**。
2. OpenAI PlatformのTunnel設定でトンネルを作り、
   `tunnel_id` と適切な権限を持つ実行用APIキーを用意する。
   このリポジトリに**秘密鍵、キーの値、認証Cookieを保存しない**。
3. OpenAI公式`tunnel-client`をLinuxにインストールし、
   `tunnel-client help quickstart` で最新の設定方法を確認。
   MCPターゲットは、ローカルHTTP `http://127.0.0.1:8896/mcp`
   かstdio `node /home/yugo314/ドキュメント/14_予測クリーチャー/mcp/companion-stdio.mjs`。
   `doctor`が成功して`run`が接続されることを確認。
4. **ChatGPTの画面**で Plugins → ＋ → Add custom MCP server →
   Connection: Tunnel → 作ったトンネルを選択し、接続を承認してインストール。
   画面に項目がないときは、アカウント／ワークスペースにMCP作成権限がない可能性がある。
5. `@Creature Lab`を選び「現在の相棒を教えて」「髪色を変えて相棒を保存して」
   などを依頼し、Webゲーム画面 `127.0.0.1:8890/game` を更新して一致を確認。

このリポジトリでは**ローカル接続と保存の双方向反映まで実証**する。
外部のChatGPTにプラグイン登録済みだと誤認しない。
ユーザーごとのOAuth・安全な一般公開・アイコン付きChatGPT画面などは未実装。

公式:
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt

### 回帰テスト

```bash
cd /home/yugo314/ドキュメント/14_予測クリーチャー
node --test mcp/tests/chatgpt-companion.test.mjs
(cd mcp && npm test)
```

テストでは一時保存ファイルと別ポートのNodeゲームを使い、
実ゲームの相棒を勝手に作成・更新しない。
