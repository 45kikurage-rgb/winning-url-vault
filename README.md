# Winning URL Vault

次回抽選から運用する、新しい当選URL管理Workerです。旧当選管理サイトの在庫や配置換え機能には触れません。

## アクセス保護と試用運用

- すべての管理APIはログイン必須です。
- アクセスパスワードのSHA-256値を `ACCESS_PASSWORD_SHA256`、署名用乱数を `SESSION_SECRET` としてWorker Secretへ登録します。
- 5回連続でログインに失敗した接続元は15分間停止します。接続元情報はハッシュ化してD1へ保存します。
- `OPERATION_MODE` が `trial` の間は画面に「試用運用中」と表示します。
- 試用中は画面の「URLデータ完全削除」または `npm run db:reset-trial` でURL、解析ジョブ、未判定、確認待ち、操作履歴を削除します。確認済み商品マスターとカード定義は残ります。画面操作は「完全削除」の入力確認が必要で、正式運用モードでは利用できません。
- 初期化後に `OPERATION_MODE` を `production` へ変更して再デプロイします。

## 実装済みフロー

1. `POST /api/receive` で全URL・コードを先にD1へ保存し、貼付内重複と既登録を分離
2. Cloudflare Queueから40件単位、最大3バッチを並列で取り出し、Service Binding経由で `coupon-analyzer-api /api/analyze-detail` を呼び出す
3. 各バッチの解析結果を `analysis_staging` に一時保存し、全バッチ完了後だけ確定処理へ進む
4. 正式商品名、容量・規格、利用先、必要条件を正規化し、全一致キー＋期限でグループ化
5. 初回の商品・期限だけ代表URLから公式商品画像を1枚取得し、解析内容と共に `pending_confirmations` へ保存してグループ単位でOK / 修正 / キャンセル待ち
6. 必須情報不足、未知URL、汎用名は既存カードへ入れず `unresolved_items` に隔離
7. `POST /api/unresolved/retry` は未判定だけを再解析。確定済みカードは対象外
8. カード内容は50件ずつ取得し、2,000件以上でも全件DOM描画しない
9. `GET /api/jobs/latest` と `GET /api/jobs/:id` で画面を閉じた後も解析進捗を復元

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
