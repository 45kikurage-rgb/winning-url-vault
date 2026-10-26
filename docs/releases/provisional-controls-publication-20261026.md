# 暫定A〜E 折りたたみ・個別削除：公開記録

2026-10-26 11:23 JST、本番公開と公開後照合に成功。スマートフォン実機での利用者確認は未確認。

- 本番：https://winning-url-vault.45kikurage.workers.dev/
- 公開ソース：9cee2fbb6e9ae47444bfb979368646a5060ea156
- Worker version：535a212d-586f-41d6-ae38-1949c111d56e（100%）
- CI成功：https://github.com/45kikurage-rgb/winning-url-vault/actions/runs/40258723994
- ブラウザー確認・公開・照合成功：https://github.com/45kikurage-rgb/winning-url-vault/actions/runs/40258723851
- 当該runのartifact：provisional-controls-release-40258723851 / release-evidence.json

## 動作

仕分けの「暫定A〜Eの解析結果」は初期状態で閉じ、合計件数を表示する。展開→保管内容を確認・削除・カード化→各行の削除から、対象全文を確認して1件ずつ削除できる。削除後は件数と一覧を更新し、入力途中のカード化設定と展開状態を保持する。

一覧とカード化対象から除外する論理削除とし、元のURL/コード・canonical・受付記録・監査を保持する。再送と重複受信で復活しない。物理DELETEや本番スキーマ変更は行っていない。

## 検証

ローカル構文確認、Node/Miniflare全101件、dry-run成功。削除の認証・Origin・確認文字列・対象箱・受信完了・カード化後の拒否・二重削除・同じ受付IDと新しい受付IDの再送・0件の集計を検証。Chromiumの360px幅で初期閉鎖、展開、キャンセル、削除、件数、入力保持、空表示、44px以上のタップ領域、文字列エスケープ、横はみ出しなし、再読み込み後の初期閉鎖を確認。

公開後にWorkerの実バイトがビルドと一致し、配信11ファイルをGitHubソースと照合。認証ガード、runtime設定、Cron、公開範囲、既存DB構造の維持を確認。実データの削除試験は行っていない。

最初の公開前CIではブラウザー確認用スクリプトがNodeの自動探索対象となり停止。本番変更前にcheckスクリプトへ改名して解消。今回のActionsは初回2run失敗と修正後2run成功の計4run。文書記録ではCIを再実行しない。

PWAは再読み込みまたは閉じて開き直して確認する。端末認証鍵を含むブラウザー保存データの削除は不要。
