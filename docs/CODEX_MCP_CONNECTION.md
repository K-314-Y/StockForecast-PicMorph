# Creature Lab を Codex CLI から使う（ローカル限定）

**状態（2026年11月14日）:** Nodeゲームは `127.0.0.1:8890`、専用MCPは `127.0.0.1:8896/mcp`。正式なChatGPTプラグインとしての登録ではありません。

## いま使える接続

Codexのプロジェクト設定 `.codex/config.toml` は Codex CLI の権限保護により直接作成できなかったため、**設定を変更しないラッパー**を用意しました。呼び出した1回のCodex CLI実行にだけMCP設定が適用されます。

```bash
cd '/home/yugo314/ドキュメント/14_予測クリーチャー'
curl -fsS http://127.0.0.1:8896/health
./scripts/codex-creature-lab.sh mcp list
./scripts/codex-creature-lab.sh exec --sandbox read-only 'Creature Labのget_my_character_sheetを1回呼んで、設定の概要だけを日本語で教えて。画像本体は取得せず、ファイル変更や保存はしない。' </dev/null
```

ラッパーが公開するのは次の6つの**読み取り専用**ツールだけです。

| ツール | 用途 |
|---|---|
| `get_my_character_sheet` | 現在のキャラ設定をまとめて読む |
| `get_my_companion` | 相棒の予測設定 |
| `get_my_look` | 髪色・服などの見た目設定 |
| `get_my_artwork` | 画像が保存されているかの情報のみ |
| `get_my_creature_growth` | XP・レベルなどの状態確認 |
| `list_my_trained_brains` | 学習済みモデル一覧 |

**保存操作、画像本体の送信、練習プレイ操作は許可していません。** `scripts/codex-creature-lab.sh` の `enabled_tools` が制限の対象です。Codexのファイル編集コマンドそのものを禁止するものではないので、読み取り確認時は `exec --sandbox read-only` を使用します。

Codex CLI の非対話実行で追加入力を待って止まる場合は、上記のように `</dev/null` で標準入力を閉じます。2026年11月14日、実際のCodex CLIから `get_my_artwork` を1回呼んで、画像データなしで4スロットのメタデータを取得できたことを確認しています。

自動テスト:

```bash
node --test mcp/tests/codex-local-connection.test.mjs
bash scripts/test-plugin.sh
```

MCPの応答がない場合は `curl http://127.0.0.1:8896/health` を確認。Codexがツールを見つけなければ、ラッパーを経由して起動しているか確認してください。プロジェクトの信頼確認が表示された場合は、自分のコードだと確認した場合のみ承認します。秘密情報や画像そのものを通常のログに書かないでください。

## ChatGPTプラグインの接続は別工程

2026年11月14日時点のOpenAI公式案内では、ChatGPTのカスタムMCP接続のフル機能はBusiness・Enterprise/Edu向け（ワークスペースの権限が必要）です。Codex CLIに接続できたことは、ChatGPT上にプラグインがインストールされたことを意味しません。

本人に対応するワークスペースと許可がある場合に限り、OpenAI **Secure MCP Tunnel** などで非公開サーバーに接続します。この場合、PlatformのトンネルID、Tunnels権限、制限付きAPIキー、ChatGPTワークスペースとの対応付けが必要です。**このリポジトリには認証情報を保存しません。** トンネルを起動する前に、画像がChatGPTへ送られる範囲、書き込み操作の承認、外部接続の安全性を明示的に確認してください。

- [OpenAI: Connecting custom MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [OpenAI: Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Codex 設定リファレンス](https://developers.openai.com/codex/config-reference)

画像判別の実験Branchや本番のXP・V6のデータには、この接続手順は関与しません。
