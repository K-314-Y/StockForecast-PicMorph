# Windows からCreature Labを確認する（開発はLinux）

開発、修正、テスト、Gitのコミット・Pushは従来どおりLinuxで行う。Windowsは表示確認専用のGitコピーで、別ネットワーク上でもGitHub SSH経由で最新版に更新できる。公開サーバーは作らない。

## 初回の配置

Windowsの %LOCALAPPDATA%\CreatureLabPreview\repo に非公開GitHubリポジトリをSSHでクローンする。SSH鍵は既にWindowsにあるものを使い、共有・出力しない。WindowsのDocuments・既存プロジェクト・Git設定・ファイアウォールは変更しない。

## Windowsで起動・更新

scripts\Open-Windows-Preview.cmd をダブルクリックすると：
1. GitHubから main をSSHで取得し、更新可能な場合のみ --ff-only（既存のローカル編集は上書きしない）。
2. 以前のWindows確認専用 Node サーバーだけをプロセス名と実行パスで検証して再起動する。他の8891番ポート使用者がいたら停止して報告する。
3. Chromeで http://127.0.0.1:8891/game を開く。

Linuxの通常ゲームは http://127.0.0.1:8890/game 。どちらもそれぞれのPCの 127.0.0.1 にだけ公開する。別ネットワークのPCへ直接開放しない。

## 大事な制限

- WindowsはLinux本番ゲームの遠隔操作ではなく、同じコードを動かす独立プレビュー。Linuxの保存済みイラスト、生成した非公開PNG、XP・育成・モデルデータは同期しない。
- Windowsでボタンを押して保存した内容はWindows側の local_state のみ。Linuxのデータを上書きしない。
- 登録キャラの新規作成はWindowsでは無効。外見スタジオ内の「＋ 新しいキャラを作って登録」で場所は分かるが、実際の生成・登録はLinuxのゲームで実行する。WindowsでLinuxの非公開PNGは表示されず、登録一覧は別管理。
- Python予測ブリッジなどLinuxだけで準備された補助サービスがない場合、詳しい練習や実験は一部使えない。画面・外見管理・レイアウトの確認が主目的。
- Linuxのコードが変わったらLinux側からGitHubへPushし、Windowsの起動スクリプトをもう一度実行して反映を確認する。
- 同じデータ・APIをWindowsから利用する本当の遠隔接続が必要になったら、Tailscale等の認証されたプライベートネットワークを別途設定する。公開トンネルは作らない。
