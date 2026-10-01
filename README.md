# Winning URL Vault

次回抽選から運用する、新しい当選URL管理Workerです。旧当選管理サイトの在庫や配置換え機能には触れません。

## アクセス保護と正式運用

- すべての管理APIはログイン必須です。
- アクセスパスワードのSHA-256値を `ACCESS_PASSWORD_SHA256`、署名用乱数を `SESSION_SECRET` としてWorker Secretへ登録します。
- 5回連続でログインに失敗した接続元は15分間停止します。接続元情報はハッシュ化してD1へ保存します。
- 本番は `OPERATION_MODE=production` で画面に「正式運用中」と表示します。
- 試用中は画面の「URLデータ完全削除」または `npm run db:reset-trial` でURL、解析ジョブ、未判定、確認待ち、操作履歴を削除します。確認済み商品マスターとカード定義は残ります。画面操作は「完全削除」の入力確認が必要で、正式運用モードでは利用できません。
- 初期化後に `OPERATION_MODE` を `production` へ変更して再デプロイします。

## 画面と抽出運用

- 画面は「URL受信」「仕分け待ち」「当選リスト」の3タブです。
- キャンペーンへ振り分けた商品は、キャンペーン＋`product_id`単位の当選カードとして「当選リスト」へ表示します。
- カードごとに「通常URL／コークオン／えらべるPay／PayPay／文字列」の抽出方法を設定します。
- 未抽出データは「1件ずつ」または「一括コピー」で処理します。一括コピーは貼り付けが終わるまで確定せず、「抽出済みにする」で確定します。
- 一括処理は中断、再コピー、直前確定の取消に対応します。1000件を超える1カードの抽出も全件を固定して処理します。
- 抽出方法を変更しても、既に抽出済みのデータを再び未抽出には戻しません。
- 当選0件のキャンペーンも、終了確認前に総当選数0件を中央台帳へ同期してから終了プレビューを取得します。

## 実装済みフロー

1. `POST /api/receive` で全URL・コードを先にD1へ保存し、貼付内重複と既登録を分離
2. Cloudflare Queueから40件単位、最大3バッチを並列で取り出し、Service Binding経由で `coupon-analyzer-api /api/analyze-detail` を呼び出す
3. 各バッチの解析結果を `analysis_staging` に一時保存し、全バッチ完了後だけ確定処理へ進む
4. 正式商品名、容量・規格、利用先、必要条件を正規化し、全一致キー＋期限でグループ化
5. 初回の商品・期限だけ代表URLから公式商品画像を1枚取得し、解析内容と共に `pending_confirmations` へ保存してグループ単位でOK / 修正 / キャンセル待ち
6. 必須情報不足、未知URL、汎用名は既存カードへ入れず `unresolved_items` に隔離
7. `POST /api/unresolved/retry` は未判定だけを再解析。確定済みカードは対象外
   - `https://br.quocardpay.jp/card/英数字16桁` はCoupon Analyzerへ送らず、QUOカードPayカードへ直接保管します。複数キャンペーンが同時進行する場合は、キャンペーンごとの送信後にカードの未仕分け分を振り分けてから次のキャンペーン分を送信します。
8. カード内容は50件ずつ取得し、2,000件以上でも全件DOM描画しない
9. `GET /api/jobs/latest` と `GET /api/jobs/:id` で画面を閉じた後も解析進捗を復元

## PWA・Android共有

- ホーム画面へインストールすると「当選URL管理」として起動します。通常起動は管理トップ、Androidの共有先から起動した場合は共有専用画面を開きます。
- 共有されたURL・コードは、ログイン中なら自動で `POST /api/receive` へ受付します。ログインが切れている場合は端末内へ24時間保持し、管理画面でログイン後に自動受付します。
- `manifest.json` と `manifest.webmanifest` は同一内容です。`sw.js` がShare TargetのPOSTを受け、`share.html` へ転送します。
- PWAアイコンは茶色い手の図柄を2つ斜めに配置した専用画像です。通常用192/512pxとAndroidマスカブル用512pxを用意しています。起動画面の背景色は白です。

## 判定事故の防止

- `display_name` は画面表示専用で、照合キーには使用しない
- 「セブン-イレブン クーポン」などの汎用名は失敗扱い
- 近似一致、部分一致、店舗名だけの一致は行わない
- 一度確定したURLはAnalyzer更新後も自動で再判定・統合しない
- URLは受信前チェックに加えてD1の一意制約でも重複を排除し、同時受信時も二重登録しない
- 一時解析結果がすべて揃うまではカードへ登録せず、再試行時も確定処理を重複実行しない
- Amazonギフト券は現行データ確認前のため自動判定しない

## D1作成と反映

```sh
npx wrangler d1 create winning-url-vault
# 表示された database_id を wrangler.jsonc に設定
npm run db:remote
npm run deploy
```

ローカル確認は `npm run db:local`、テストは `npm test` を使用します。

## 主なAPI

- `POST /api/receive` `{ "text": "URLまたはコードを1行1件" }`
- `GET /api/cards`
- `GET /api/cards/:id/items?limit=50&cursor=...`
- `GET /api/pending`
- `POST /api/pending/:id/confirm` `{ "action": "ok|edit|cancel" }`
- `GET /api/unresolved`
- `POST /api/unresolved/retry`

## 中央管理台帳連携

- `LEDGER_READER` は `aruno-consolidated-ledger-api#ReaderAPI`、`LEDGER_VAULT` は同Workerの `VaultAPI` へ接続します。ブラウザーは中央台帳へ直接アクセスしません。
- UIはキャンペーン名と抽選開始日を表示し、内部では不変の `campaign_id` を使用します。
- `product_master.id` は解析用の内部IDのままです。正式 `product_id` はカードをキャンペーンへ初めて割り当てた時だけ `ledger_products` に発行します。
- 商品・キャンペーン総数の現在値は、元データ変更と同じD1 batchで `ledger_outbox` に凍結します。送信失敗後もURLデータと仕分けは残り、毎分cronが60 / 120 / 300 / 900 / 3600秒、以後1時間間隔で再送します。
- URL、コード、`canonical_value` は中央台帳payloadへ含めません。
- `closing` は遅着URLを仕分け可能、`closed` は新規仕分け禁止、`correcting` は訂正中の更新を許可します。
- 仕分け済みURLがある場合、試用データ完全削除は拒否し、終了後訂正フローで処理します。

既存本番DBへの追加migrationは次を使用します。

```sh
npm run db:migrate:ledger
```
