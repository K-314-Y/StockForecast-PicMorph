# S108: 評価データの証跡ファイル照合（Linux・読取専用）

S105では証跡の参照IDとハッシュが申告されるだけだった。S108は明示的なローカル操作で、申告されたSHA-256と実際の添付ファイルのバイト列を比較する。取得元や利用条件の正しさを自動認証するものではない。

## 入力と実行

S104の有効な固定記録と、それに対応するS105入力パッケージが必要。固定IDのフォルダ内に、以下の6種類のファイルを置く形式を定める。ファイルを作成する機能や取得機能はない。

- 保存先: local_state/accessory_evaluation_evidence/<registration_id>/
- ディレクトリ: 0700、ファイル: 0600、各256 KiB以下かつ空でない通常ファイル。
- source.bin（取得元）、retrieval.bin（取得記録）、calendar.bin（営業日）、adjustment.bin（価格調整）、rights.bin（利用権限）、point_in_time.bin（当時の利用可能性）。
- 各ファイルのSHA-256をS105入力の対応する evidence 項目に記録する。ref は参照用IDに過ぎず、ファイル名・パスに使用しない。外部URLは開かない。

Linuxのリポジトリ直下で、実在する固定記録のIDを指定して実行する。

```sh
printf '%s\n' '{"registration_id":"<64桁の固定記録ID>"}' | python3 -B -E mcp/accessory_evaluation_readiness.py --evidence
```

既存S105の検査が成功した場合だけ添付を読む。結果の evidence_audit は6項目の状態（missing / unsafe / hash_mismatch / hash_match）、一致件数、必要件数だけを返す。読み取り不可能、リンク、権限不正、サイズ超過を安全に拒否する。読み取ったファイルが検査中に変更された場合は照合失敗として扱う。データ・証跡を保存、変更、生成、送信しない。指定した記録以外のフォルダを走査しない。通常のS105 API・UIは変更しない。

## 残る確認

ハッシュ一致は申告されたバイト列との一致だけを表す。資料の真正性、契約・利用権限、公式営業日、価格調整、観測時点の正しさを証明しない。全6件一致しても content_reviewed、authenticity_verified、score_allowed、holdout_evaluated および従来の検証済みフラグは false のまま。実データを採点する経路は未実装。実際の契約・取得元の確認および資料収集は別工程とする。

テスト: python3 -B -m unittest discover -s mcp/tests -p 'test_accessory_evaluation_readiness.py' -q
