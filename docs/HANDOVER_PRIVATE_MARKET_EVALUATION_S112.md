# 株価予測キャラクターゲーム / Creature Lab 開発引継ぎ S112

更新日 2026-11-27 JST。区切り: 実データを扱う前の合成評価基盤・保存方式の試作完了。次フェーズ S113。GitHub K-314-Y/StockForecast-PicMorph の main の最新コミットとローカルのHEAD・変更状態を確認してから着手する。Linuxの既存プロジェクトを使用し、別プロジェクト、ブランチ、worktree、Windows、既存の保存データには無断で触れない。

## 開発方針

本人専用のローカルゲームを優先。キャラクターの装備が分析重みに与える影響を、同じ銘柄・期間・資金の基準モデルと候補モデルで比較する。重みの変更は学習そのものではない。予測誤差、仮想損益、最大下落率を独立評価する。公開、複数利用者、課金、実売買、外部への実データ転送は保留。公開リポジトリにはコード、文書、架空データだけを置く。

## 現在の実装

| 工程 | 状態・確認場所 |
| --- | --- |
| S104 | 将来評価条件をV1として事前固定。 game_runtime/accessory-registration-protocol-v1.json と mcp/accessory_registration_store.py。固定コード11ファイルと既存記録を改変しない。 |
| S105 | 入力構造・固定コードの指紋照合。 mcp/accessory_evaluation_readiness.py。未確認の根拠では採点不可。 |
| S106 | 10銘柄×12日間の合成ペア比較。 mcp/tests/frozen_accessory_replay_fixture.py と frozen-accessory-replay.test.mjs。 |
| S107 | 保存済み合成結果の表示。 docs/S107_SYNTHETIC_RESULT_VIEW.md。 |
| S108-S109 | 証拠6種類のファイル内容照合と画面。 docs/S108_EVIDENCE_ATTACHMENT_AUDIT.md, docs/S109_EVIDENCE_REVIEW_VIEW.md。一致は真正性・権利の証明ではない。 |
| S110 | データ供給元、契約、時刻、価格訂正の調査。 docs/S110_MARKET_DATA_SOURCE_REVIEW.md。J-Quants候補、無料の遅延、契約終了時の消去義務、実データの利用条件は未確認。 |
| S111 | 翌営業日始値の仮想売買試作。 game_runtime/next-open-practice.mjs, docs/S111_NEXT_OPEN_PRACTICE.md。前日終値での事後購入を防ぐ。 |
| S112 | 観測版を明示IDで保持・参照する合成保存試作。 mcp/synthetic_observation_store.py, docs/S112_OBSERVATION_SNAPSHOT.md。実時刻・実価格は未対応。 |

## 次フェーズ S113 の開始条件

まず本人が使用できるデータ提供プラン・権利、公式営業日、取得・訂正の時刻、ローカルの保持と契約終了時の消去要件を確認する。料金・契約の変更や実データ取得は別途明示許可が必要。S111とS112をつなぐ新V2の評価手順は未固定。公式カレンダー、企業行動、欠測・無約定、判断の確定時刻、取引コスト、予測確率の評価と始値執行の分離を仕様化し、合成テストを済ませてからV2を別名で固定する。V1の採点禁止を維持し、過去の利益を見て条件を選ばない。実データの評価を開始できるとはまだ判断しない。次の作業で最初に不足条件を報告し、実データの新規取得を無断で開始しない。

## 再開時のテスト

- python3 -B -m unittest discover -s mcp/tests -p 'test_synthetic_observation_store.py' -v
- python3 -B -m unittest discover -s mcp/tests -p 'test_accessory_evaluation_readiness.py' -q
- node --test mcp/tests/next-open-practice.test.mjs mcp/tests/frozen-accessory-replay.test.mjs
- npm --prefix game_runtime run typecheck

現段階ではS111・S112は実行中のゲームへ未接続。既存ゲームはLinuxの127.0.0.1:8890、MCPは8896/8897（再開時に現状を確認）。実データの検証を行った、予測力が証明された、真正性が確認された、とは記載しない。以前の作業の制限を継承し、既存のローカル保存状態を削除・上書きしない。
