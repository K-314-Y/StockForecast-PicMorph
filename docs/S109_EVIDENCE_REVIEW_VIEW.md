# S109: 固定記録の証拠ファイル照合画面

S108のローカル証拠照合を、Linuxの装飾品分析画面の固定記録一覧から明示的に実行できるようにする。現在のキャラ・装備とは独立して選択した固定記録のみを検査する。

POST /api/accessory-analysis/v1/registration/evidence は小文字64桁の registration_id 一つだけを受け付ける。既存S105と同じ同一オリジン、ホスト、入力長、同時実行数、タイムアウトの制限を適用する。S108の読取専用ヘルパーを --evidence 付きで呼ぶ。入力パッケージまたはコードに問題があれば添付を照合しない。

取得元、取得記録、営業日、価格調整、利用権限、当時の利用可能性を、未添付・安全に読取不可・不一致・一致の4状態で表示する。6項目と一致件数の整合性をサーバーで検査し、資料本文・ハッシュ・参照ID・ファイルパス・株価を返さない。未検査なら evidence_audit は null。全項目一致しても真正性、利用権限、内容の検証、採点許可は false のまま。資料の収集・内容の確認・実データ評価は別工程。固定記録とデータ、XP、コインを更新しない。

検証: Node の accessory-evaluation-readiness.test.mjs、synthetic-frozen-report.test.mjs、Python の test_accessory_evaluation_readiness.py、型チェック、320pxの合成ブラウザテスト。S104の固定対象コードは変更しない。
