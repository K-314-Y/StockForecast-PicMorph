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
