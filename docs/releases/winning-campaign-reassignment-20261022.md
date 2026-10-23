# 当選リスト・キャンペーン再選択 本番リリース
- 日付: 2026-10-22
- 対象: winning-url-vault
- 目的: 仕分け済み当選カードのキャンペーン再選択
- 変更: 既存product_idのキャンペーン変更を禁止し、移動先に新しいproduct_idを作るか同じ設定の既存商品へ統合する。元product_idは履歴として残す。
- 既存URL / 抽出済み状態 / 単価 / 月次収益総額を保全する。
- 終了済み、収益確定済み、抽出実行中、商品設定競合では移動しない。
- DB migration: なし。D1に対する事前確認は読み取りのみ。
- 既存の GitHub Actions Deploy は workflow_dispatch を維持。この一回限りのマーカーを含むmain更新だけ公開を起動する。

## 2026-10-23 既存の認証を維持するセッション自動更新
- ユーザーがサイトを使用し続ける間、有効な署名付き管理Cookieを期限半分以下で自動延長。
- 失効Cookie、偽造Cookie、匿名アクセス、送信専用Bearerから管理Cookieを新規発行しない。
- PWAの起動時・前面復帰・利用中の軽量チェックのみ。URL受信、当選記録、データベース構造、認証Secretは不変更。
- Miniflareの認証境界試験と既存の全npm test、node --check合格を本番反映の条件とする。
- 本番は既存Workersにコード/静的ファイルのみデプロイ。D1 preflightは参照専用で migrationを実行しない。
- Cloudflare側の正式なログインパスワード紛失は別途管理者による安全なSecret再設定が必要。復元用バックドアは導入しない。

## 2026-10-23 登録した1端末だけの自動ログイン（本番更新）
- 対象: Android PWAと管理Workerのログイン。GitHub PR #12。
- 端末内 IndexedDB に非抽出ECDSA秘密鍵を生成し、Cloudflare管理者がDEVICE_PAIRING_SHA256に利用者端末上で生成したハッシュを登録した場合だけ鍵をペアリングする。
- 端末の登録確定で従来のパスワードログイン/既存の管理Cookieを無効化し、署名付き短命チャレンジで新ログインCookieを発行する。
- ARUNOMATICのsend-only Bearer認証とURL/コード/商品の既存データは一切変更しない。
- DB migration 0009 は2テーブルと1インデックスの非破壊追加。CI全成功。Cloudflare本番はD1のread-only preflightとTime Travel情報照合後に適用。
- パスワードと署名鍵はチャット/ソース/Secretへ平文登録しない。登録ハッシュだけをCloudflare Secretへ利用者が設定する。
- **コード公開だけでは端末登録完了ではない**。CloudflareでのSecret設定と、対象端末での初回登録・ブラウザ動作確認は別作業。
- 端末鍵が失われた際はCloudflare管理者が新しいDEVICE_PAIRING_SHA256に差し替え、同じ端末を再ペアリングする。データの削除は不要。
