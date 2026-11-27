# カード再判定：緊急修正の公開記録（D1過負荷の復旧）

2026-11-27 23:41 JST、本番公開に成功。利用者の実機での復旧確認は未確認。

- 本番：https://winning-url-vault.45kikurage.workers.dev/
- 公開ソース：1126c86（緊急修正本体は PR #33 のマージコミット ff0aabd714bb73a0476135465edb0c89e0ec4b82）
- Worker version：7375c3c6-75f6-4243-9613-9caebdf0ca2e（100%）
- 公開成功：https://github.com/45kikurage-rgb/winning-url-vault/actions/runs/46017737100 （Release card reanalyze #2、全ステップ成功、1分5秒）

## 障害の経緯

2026-11-27 23:26 のカード再判定の公開（Worker version ba37b2d1）直後から、ログイン画面と仕分けタブで D1_ERROR「D1 DB is overloaded. Too many resources consumed within a 10 second window.」が発生し、ログイン確認とカード読み込みが進まなくなった。データの破損はない。

## 原因

PR #32 でカード一覧（listCards）に追加した provisional_count の集計が、カードで絞らず items 全件を走査し、1行ごとに analysis_json を JSON 解析していた。アプリはカード一覧を8秒ごとに再取得するため、この重い走査が繰り返し実行され、D1 の10秒あたりの資源上限を超えた。

## 修正

集計対象を「その応答で返すカードだけ」に限定した（card_id の IN リスト、90件ずつ分割）。items の idx_items_card（card_id, status, received_at, id）を使うため、対象カードの行だけを読む。再判定の本体（reanalyzeCardItems、カード単位で絞る）と enrichCards は変更していない。

## 検証

PR #33 の GitHub CI 成功。公開ワークフロー内でも構文確認・全テスト・配信ファイル照合が成功した。実機での復旧確認（カードが通常の速さで読み込めること、暫定カードの「再判定」が動くこと）は利用者に依頼する。
