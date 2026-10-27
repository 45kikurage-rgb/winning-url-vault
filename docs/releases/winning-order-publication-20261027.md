# 当選リスト標準並び順：本番公開記録（2026-10-27）

2026-10-27 20:20 JST、本番公開と公開後の自動照合に成功。スマートフォン実機での利用者確認は未確認。

- 本番：https://winning-url-vault.45kikurage.workers.dev/
- 対象機能：当選リスト標準順。未抽出数の多い順 → 同数ならキャンペーン抽選開始日（lottery_start_date）が新しい順 → 商品名 → product_id
- 変更PR（Muse）：https://github.com/45kikurage-rgb/winning-url-vault/pull/16
- 本番リリースPR（ChatGPT 引き継ぎ）：https://github.com/45kikurage-rgb/winning-url-vault/pull/17
- 本番公開ソース：`18f709440dd9bc5f7f559f01a7c6ef976b39543c`
- 本番Worker version：`fb7c27cb-7a54-48e1-b81f-aa0c760d4df2`
- 直前の確認済み version：`6953e0aa-32a2-4c8d-b9df-d7ef13c2f6c2`（Lawson 公開run 40310035775）
- main CI：https://github.com/45kikurage-rgb/winning-url-vault/actions/runs/40495305147 （success）
- 公開・後検証：https://github.com/45kikurage-rgb/winning-url-vault/actions/runs/40495305130 （success）
- 公開証跡artifact：`winning-order-release-40495305130` / `winning-order-evidence.json`（artifact ID 12729723623）

## 検証

- PR #17 CI成功、mainの同一SHAに対するCI成功ゲート通過。
- `node --check public/winning-view.js` と `node --test tests/winning-view.test.mjs` 成功。
- `npx wrangler deploy --dry-run` 成功。
- 認証付き本番事前確認で、直前Worker version一致、既存配信ソース確認、D1構造・runtime設定・Cron・公開範囲のスナップショット取得。
- `npx wrangler deploy --config .release-wrangler.json --keep-vars` のみを使用し、**D1 migrationや本番DB書き込みを実行せず**公開。
- 公開後にWorkerビルドバイト一致、配信静的ファイル一致、新しい並び順ロジックの配信、D1構造・runtime設定・Cron・公開範囲の維持、無認証アクセスガードを検証。すべてPASS。
- Actionsログの新version: `fb7c27cb-7a54-48e1-b81f-aa0c760d4df2`。公開workflow結果: success。
- リリース文書・検証スクリプトの本番基準とJSON読み込み不具合を公開前に修正済み。

## 補足

- 表示ロジックの変更であり、既存URL・商品ID・収益・使用済み記録を更新しない。
- 「キャンペーン作成日」ではなく既存実装の「抽選開始日」で同数時の順序を決める。両者は別概念のため、作成日を使う必要があれば追加仕様確認が必要。
- 実機ブラウザーでの並び順確認は未実施。必要に応じてPWAを閉じて開き直すか画面を再読み込みし、「標準」で並び順を確認する。
