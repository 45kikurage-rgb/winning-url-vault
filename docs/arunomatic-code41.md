# ARUNOMATIC code41 接続手順

この接続には、端末トークン対応版のVaultと migration `0005_device_intake.sql` の本番反映が必要です。

1. メイン端末で当選URL管理にログインし、「URL受信」→「ARUNOMATIC 送信端末設定」を開きます。
2. ARUNOMATICを使う端末の番号を2〜4桁（例：03）で入力し、トークンを発行します。端末ごとに別の番号を使ってください。
3. 表示された送信先URLとトークンをコピーします。トークンは画面を閉じると再表示できません。
4. ARUNOMATICの「当選URL・コードの送信状況／再送」→「送信専用API設定」に登録します。
   送信先は `https://winning-url-vault.45kikurage.workers.dev/api/receive` です。
5. 保留データを再送し、メイン端末の仕分け待ち・未判定を確認します。

管理者パスワードやCookie、中央台帳のトークンは登録しません。
同じ端末番号で発行・更新すると古いトークンは失効します。同じ受付IDの再送は更新後も続行できます。
端末を廃止した場合は、送信端末設定からそのトークンを失効してください。

## 受付契約

- `POST /api/receive`、JSON、`Authorization: Bearer <送信専用トークン>`。
- `values` は文字列配列。`clientRequestId` は端末で生成したUUIDを再送時にも維持します。
- 初回202、同じ端末・受付ID・内容の再送200。同一IDに異なる内容は409。
- `ok:true`、`stored:true`、一致する `clientRequestId`、`job.id`、`receiving` 以外の `job.status` をすべて確認して送信済みにします。
- 元の共有文字列を保存し、全件の保管または既登録の照合が終わった後に成功を返します。解析は後続処理です。
- 不明なURL・コード・テキストも受け付け、解析不能な入力は未判定に残します。
- 通信切断時は同じ受付IDと内容で再送します。保存途中の受付は残りから再開します。定期処理も未完了の受付と解析キュー投入を再試行します。
- 上限は1リクエスト512KiB、解析対象4,999件、端末ごと毎分120回です。
- トークンは送信専用で、一覧取得・管理・抽出・削除には使えません。サーバーにはトークンのSHA-256ハッシュのみ保存します。

エラーコード：400 `INVALID_REQUEST`、401 `TOKEN_INVALID`、403 `SCOPE_DENIED`、409 `REQUEST_ID_CONFLICT`、413 `PAYLOAD_TOO_LARGE`、429 `RATE_LIMITED`、503 `INTAKE_INCOMPLETE`、500 `SERVER_ERROR`。
失敗時は端末側の共有データを保持します。自動の無限再送は行いません。

## 公開と確認

既存のGitHub Actions「Deploy」をmainに対して実行します。テスト成功後、追加migrationを適用してWorkerを更新します。
既存の商品・当選URLを削除する操作は不要です。
公開後は管理画面の送信端末設定と、未知テキスト1件の送信・同一ID再送・未判定表示を確認します。
