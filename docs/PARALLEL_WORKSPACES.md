# 並列開発の作業場所

同時開発では**同じGitリポジトリを共有するworktree（ワークツリー）**を使います。プロジェクト直下で別機能の作業を始めず、次の担当フォルダだけを編集してください。workspaces/ はローカル専用でGit管理対象にしません。

## ブランチを増やさない運用（2026-11-19更新）

- **株価予測ゲームP0〜P7の成果は `dev/forward-game` に統合済み**。P8以降も原則このブランチと既存worktreeを再利用し、工程ごとに新しいブランチを作らない。
- 最新キャラクター制作の `main` との最終統合は、互換性とテストを確認してから行う。`main` の別作業を無断で上書きしない。
- 旧 `feature/forward-...` の段階ブランチ、`workspaces/forward-paper/`、`workspaces/market-guard/` は整理済み。関連するコミット履歴は `dev/forward-game` に残っている。
- 外見・HatchPetの並行作業に使う既存worktreeは維持する。未統合の変更や `local_state/` がある作業場所は削除しない。
- やむを得ず追加のブランチが必要なら、用途と統合先を決め、終了後に変更が残っていないことを確認して速やかに整理する。


| 作業 | フォルダ（プロジェクト直下から） | ブランチ |
| --- | --- | --- |
| 統合・最終テスト | . | main |
| キャラの表情・動き | workspaces/character-animation/ | sprint79/manual-expression-artwork |
| HatchPet待機アニメーションの統合・表示調整 | workspaces/hatchpet-integration/ | sprint80/hatchpet-idle-integration |
| HatchPet体＋顔PNG合成の実験 | workspaces/hatchpet-parts/ | sprint82/hatchpet-png-parts |
| 外見と株価予測AIの作成画面を分離 | workspaces/create-flow/ | sprint81/separate-appearance-and-model |
| 予測AI・仮想メダル・先出し予測の継続開発 | ~/.paseo/worktrees/2fbfnfht/forward-predict-engine/ | dev/forward-game |

## 守ること

1. 作業前に担当フォルダで git branch --show-current と git status --short を確認する。Codexもそのフォルダを -C で指定する（モデルはGPT-6.2 Sol）。
2. 一方の作業からもう一方のフォルダを編集しない。キャラ側は表示や表情、注文タイミング側は独立した検証ロジックを基本の担当領域とする。同じファイルの編集が必要なら、先に片方を統合する。
3. 実験結果・実ユーザーの画像・local_state/・予測モデルの保存データを別のworktreeへコピーしない。ここでの売買は架空の練習のみ。実際の取引を実行しない。
4. 予測ゲームは `dev/forward-game` で開発を継続する。既存テストが通り、変更点を確認してから `main` に統合する。競合を無理に上書きせず、テストに失敗したら統合しない。
5. 各作業の開発サーバーは別ポートを使う。既存の8890番などのサーバーを勝手に停止・再起動しない。
6. GitHubへのPushは明示指示があるまで禁止。

## 新しい並列作業を増やす場合

原則、**新しいブランチやworktreeを作らず、既存の担当ブランチで進める**。特にP8、P9などの工程番号だけを理由に `feature/forward-*` を増やさない。

どうしても同じファイルを別の担当が同時編集する必要がある場合に限り、開始前に担当範囲と統合先を明示する。作業が完了したら変更・未追跡ファイル・未統合コミットを確認し、安全に作業場所とブランチを整理する。`main`、V9の予測データ、保存済みの `local_state/` は掃除の対象にしない。
