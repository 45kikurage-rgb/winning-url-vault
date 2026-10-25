# 当選URL管理：スマートフォンUIの本番反映記録

2026-10-25 21:46 JST、本番反映と公開後照合が成功。利用者の実機確認は待ち。

- 本番：https://winning-url-vault.45kikurage.workers.dev/
- 公開ソース：`2b89f97f42bdcc09b1e8cde69d0b6caf27ae8b92`（main）
- UI統合PR：#14。公開済み高速化PR #13の6b76bfdを含む。
- 本番Worker version：`5cd6ded0-44ab-4b51-8776-f49e679ca279`、traffic 100%。
- CI： https://github.com/45kikurage-rgb/winning-url-vault/actions/runs/40194513592 （97件成功、構文確認成功）
- 公開： https://github.com/45kikurage-rgb/winning-url-vault/actions/runs/40194513581 （公開ガード3件・build・公開後照合成功）
- 証跡：`approved-mobile-ui-evidence-20261025.json`。

## 公開後に確認したこと

Cloudflareから再取得したWorkerのSHA-256がビルド出力と一致。配信されたHTML/CSS/JS・Service Worker・新モジュール等11ファイルがソースと全バイト一致。annotationsと変更対象assetsを除くruntime settings、Cron、workers.dev/preview公開設定は前後一致。匿名認証状態はproduction・deviceOnlyMode=true・authenticated=falseのまま。cards/winning-lists/display-namesは未認証401。

DB変更は表示名専用のui_display_namesテーブルのCREATE IF NOT EXISTSだけ。既存スキーマは一致し、既存の正式名・ID・商品・URL・単価・月収益・端末認証データを公開処理から変更していない。通常運用は継続。legacy migration全件適用・削除・データ初期化は行っていない。

初回run40194301592は、Cloudflare APIの空placementをWrangler設定へ渡して停止。Worker更新前で、専用テーブル追加だけ完了。空placementとAPI専用usage_modelの変換を修正した上記runで公開・検証した。

## 利用者の実機確認

PWAは一度閉じて開き直す。必要なら再読み込み。ブラウザーの保存データを消す操作は不要。

- 当選リスト→設定→表示名を変更。当選と仕分けは独立。全角14文字相当（半角0.5）の上限と、保存時の実際の一覧幅の両方で検査。文字拡大後はその条件で検査し直す。既存の長い名前は自動変更せず、1行で横に動かして読める。
- 単価：当選リスト→設定→商品単価（1件あたり・円）→単価を保存。未設定は0円に変換しない。
- 0/10/111/999/1000以上の未抽出、縦線、右上合計、容量等／引換先、期限、設定ボタンの見切れ。
- 4タブ、受信先、初回確認の有無、CP表示モード、キーボード、最下行・フッター、セーフエリア、PWA、フォーカス・スクロール。

360×800・375×812・390×844、通常／文字大の実機描画・タップ寸法は今回未測定。Node/Miniflareの成功や公開ハッシュ一致は実機の合格を意味しない。Museが独立確認したのは修正前の見本であり、この公開版の検証済みとは記録しない。方向性の承認と実機受入を区別し、最終合意済み／問題なしとは扱わない。
