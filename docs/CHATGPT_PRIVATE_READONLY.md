# Creature Lab: ChatGPT接続候補の読み取り専用MCP

**2026年11月14日**。ローカル開発・接続準備の状態です。**ChatGPTへの正式登録は未完了**です。

## 2種類のサーバー

| ローカル接続先 | ツール | 内容 |
|---|---:|---|
| 127.0.0.1:8896/mcp | 10 | 既存の開発用。キャラの保存とイラスト画像本体の取得を含む |
| 127.0.0.1:8897/mcp | 6 | 新しい読み取り専用版。キャラ情報の確認だけ |

新しい8897版には、キャラ情報・外見・画像登録状況・XPなど育成情報・学習済みモデル一覧の**6ツールだけ**を登録します。保存操作、画像本体の送信、架空相場の試遊機能は登録しません。AIへの口頭指示ではなく、MCPのツール登録時点で除外する仕組みです。

Linuxで読み取り専用版を起動するコマンド（既存8890と8896の再起動は不要）:

    cd '/home/yugo314/ドキュメント/14_予測クリーチャー'
    node mcp/companion-chatgpt.mjs --read-only --port=8897

別のターミナルから確認:

    curl -fsS http://127.0.0.1:8897/health
    node --test mcp/tests/chatgpt-private-readonly.test.mjs
    bash scripts/test-plugin.sh

両サーバーとも127.0.0.1でのみ待ち受けます。特に**8896の10ツール版を公開・転送してはいけません**。8897も名前・予測設定・XPなどを読めるため、認証済み接続先が確定しない間はネットワーク公開しません。同じPC上の別プロセスに対する本人認証は備えていません。

## ChatGPTへの登録でまだ必要なこと

OpenAI公式案内の2026年11月時点の条件では、カスタムMCPのフル機能は対応するChatGPT Business・Enterprise/Eduのワークスペースと権限が必要です。Businessなら管理者・オーナー、Enterprise/Eduなら許可された開発者等が接続できます。**個人Plusだけでは同じカスタムMCPを自由に登録できるとは限りません**。

対応する権限が確認できた場合、OpenAI Secure MCP Tunnelに**読み取り専用の8897**を向ける方式を検討できます。Platform組織のTunnels権限、トンネルID、実行用APIキー、ChatGPTワークスペースとの対応付けが必要です。トンネルはアウトバウンド通信で接続し、ルーターのポート開放は不要です。

**未実施:** トンネルの作成・起動、秘密情報の取得・入力、認証済みHTTPSの公開、ChatGPTへのMCP登録・実使用テスト。これらはアカウント所有者や管理者による許可・確認が必要です。設定ファイルやGitに認証情報を書き込まないでください。接続前に、名前やXPがChatGPTへ送られる範囲も確認してください。

公式資料:
- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

画像の髪・顔・服の意味的な自動判別は別の実験Branchで評価中です。このMCPでは判別しません。
