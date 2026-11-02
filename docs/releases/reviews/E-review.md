# E 独立 gate: F 単発当選の連携・整合性

## 判定

PASS。追加した ACK/名称/商品投影の境界で 3 分類の不整合を発見し、F に修正を依頼。修正後のソースを E が読み直し、独立 14 件すべて PASS を確認した。修正前記録は `E-review-single-wins-before.log`、修正後は `E-review-single-wins-after.log`。本番/実機の限界は末尾に記載。

## 実装担当と異なる検証方法

F のモック RPC を受理する試験だけを追認せず、Vault・Align・Ledger をそれぞれ独立した実 SQLite DB に接続した。各 DB は実際の schema/migration を使用し、各書込 batch は SQLite transaction として実行する。

- Vault: 今回改修中の `single-wins.js` と `ledger.js`。
- Align: 今回改修中の `vault-single-wins.js` と既存 `AlignService`。
- Ledger: 読取専用 GitHub 取得で固定した main `5bd3f4b73cfb6942410662c1203f3e5112fe99fb` の `core.mjs`、`validation.mjs`、`revenue.mjs`、初期/収益 migration。`ledger-contract/` に記録。
- ハーネス: `E-review-single-wins.test.mjs`。実 Ledger の検証・依存関係・revision・収益算出・終了処理が動くため、任意 payload を成功扱いするスタブとは異なる。

本 gate はサービス間 SQL/プロトコル/原本保全を判定する。Cloudflare の実 RPC binding、実本番 D1、ネットワーク性能、Pixel 10 実機表示を検証したとは扱わない。

## 独立シナリオ

| シナリオ | 検査内容 | 初回結果 |
| --- | --- | --- |
| 1 枚の単発当選 | 実 3 系統結合、6 同時送信、異なる受付 ID の同一 snapshot、後着/別 source の除外 | PASS |
| 5 枚の単発当選 | 同上。金額 137 円×5 枚、1 商品/1 campaign を確認 | PASS |
| 依存順序を逆転 | 商品と収益を campaign より先に Ledger へ送信。DEPENDENCY_NOT_READY 後に Align を同期し同一 payload を再送 | PASS |
| Ledger 保存後の ACK 消失 | 実 Ledger が保存した直後に fetch を reject。商品/収益を duplicate として回復し二重計上しない | PASS |
| 通常仕分けとの競合 | Align RPC の応答前に通常 assignCardToCampaign を実行。単発側を needs_review にして通常仕分け 5 件/収益/原本を保持 | PASS |
| Vault 確定直後の応答消失 | transaction commit 後の receipt 読取だけに DB 障害を注入。同 ID/別 ID 再送・status 照合で確定済みを返し outbox revision を増やさない | PASS |
| 既存の終了/訂正 | Align の実 end、Ledger closing、Vault の実 close、Ledger closed、Vault correction を順に実行。配置対象外/原本/5 件/母数150を維持 | PASS |
| 不正な成功 ACK | ok が文字列 'true' の応答を成功扱いしない | FAIL → 修正後 PASS |
| 表示名に URL | 正式商品名は正常、表示名だけに URL を含む。生成名で Ledger が拒否しない。RPC に送るラベルは正常な正式名、元の表示名は保存したまま | FAIL → 修正後 PASS |
| 投影不可の商品情報 5 境界 | 正式名201文字/URL入り、規格201文字、利用先URL、非実在日付を原本保持のまま外部 campaign 作成前に止める | FAIL → 修正後 PASS |
| 契約内の限界値 | 正式商品名200文字、利用先/規格/期限空欄を許容し、実 Ledger へ正常同期 | PASS |

## 発見した問題と依頼した修正

1. `result.ok` が truthy 判定だった。`ok:'true'` でも local assignment を確定できたため、明示 boolean true を要求するよう修正済み。
2. 表示名 `お茶 https://shop.example` を自動キャンペーン名へそのまま組み込むと、実 Ledger が `INVALID_REQUEST` を返し Align outbox が blocked になる。Vault は completed を返し、その商品/合計は依存待ちに残っていた。原本を変更せず、単発用の生成ラベルを安全な正式名へフォールバックするよう修正済み。RPC に送る前にも適用し、Align 側にも URL/制御文字拒否を追加。
3. 通常カード確認の既存入力には長さや日付の実在性を制限しない経路がある。単発側は campaign 作成前に Ledger 投影契約を確認し、商品情報の修正を促すよう修正済み。正式商品名・規格・利用先を勝手に短縮/改変しない。

## 修正後の回帰

- 独立 14 件 + F 本体 Vault 14 件 + Align 6 件、計 34 件 PASS。
- receive/outbox の E 実装・C 独立境界を合わせた関連 37 件 PASS (`E-review-related-regression.log`)。
- `npm run check` によるソース構文確認 PASS。
- 既存 Miniflare 統合 40 件の最終回帰 PASS（約40.8秒）。完了結果は `E-review-integration-regression.log`。

## 保全確認と限界

単発登録は receipt で保存結果を確認でき、同じ snapshot の別 request ID が canonical receipt に収束する。後着 URL と別 source は対象外に残り、原本 item 行は登録/終了を通じて不変。単価未設定では収益を 0 と断定せず、単価入力後に元の当選数から算出する。Ledger への payload に元の当選 URL が含まれないことを検査した。

Align 保存後に対象変更が起きた場合、空の campaign が Align に残ることがある。既存情報と副作用を安全に取り消せないため自動削除せず、単発 receipt を needs_review にし再確認させる仕様。通信/一時 DB 障害では pending と同じ受付 ID を保持する。

本担当の遠隔書込・本番データ変更・Actions 起動は 0。実機や本番性能は未測定。実本番公開後の疎通・認証・read-only availability は root/G の release gate で別途確認する。
