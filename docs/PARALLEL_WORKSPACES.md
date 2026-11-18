# 並列開発の作業場所

同時開発では**同じGitリポジトリを共有するworktree（ワークツリー）**を使います。プロジェクト直下で別機能の作業を始めず、次の担当フォルダだけを編集してください。workspaces/ はローカル専用でGit管理対象にしません。

| 作業 | フォルダ（プロジェクト直下から） | ブランチ |
| --- | --- | --- |
| 統合・最終テスト | . | main |
| キャラの表情・動き | workspaces/character-animation/ | sprint79/manual-expression-artwork |
| HatchPet待機アニメーションの統合・表示調整 | workspaces/hatchpet-integration/ | sprint80/hatchpet-idle-integration |
| 仮想コイン・注文タイミングの試作 | workspaces/forward-paper/ | feature/forward-paper-core-20261118 |

## 守ること

1. 作業前に担当フォルダで git branch --show-current と git status --short を確認する。Codexもそのフォルダを -C で指定する（モデルはGPT-6.2 Sol）。
2. 一方の作業からもう一方のフォルダを編集しない。キャラ側は表示や表情、注文タイミング側は独立した検証ロジックを基本の担当領域とする。同じファイルの編集が必要なら、先に片方を統合する。
3. 実験結果・実ユーザーの画像・local_state/・予測モデルの保存データを別のworktreeへコピーしない。ここでの売買は架空の練習のみ。実際の取引を実行しない。
4. 統合はmainから行う。各ブランチでテストを通してコミットし、変更点を確認してからmainにマージ。競合があれば無理に上書きしない。テストに失敗したら統合しない。
5. 各作業の開発サーバーは別ポートを使う。既存の8890番などのサーバーを勝手に停止・再起動しない。
6. GitHubへのPushは明示指示があるまで禁止。

## 新しい並列作業を増やす場合

プロジェクト直下（mainがクリーンな時）で、例えば次のようにします。

~~~bash
git worktree add -b feature/new-task workspaces/new-task main
~~~

作業が完了し、統合と検証が済んでから git worktree remove workspaces/new-task で作業用フォルダを整理できます。コミット前の変更が残っている作業場所は削除しないでください。
