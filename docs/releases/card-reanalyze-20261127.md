# 暫定からカード化した項目の再判定

利用者の2026-11-27の指示に基づき本番公開する。
統括CURRENT Version 2026-11-08.1 を確認。

- 暫定からカード化した項目は解析されないまま provisional の印付きでカードに残っていた。仕分けタブのカードに「再判定」ボタンを追加し（再判定できる項目があるカードにだけ表示）、カード化した後にも中身を解析して再判定できるようにした（public/app.js）。
- 再判定（src/index.js の reanalyzeCardItems、POST /api/cards/:cardId/reanalyze）は、対象を「そのカードの未仕分け（キャンペーン割当なし）で provisional の印がある active 項目」に限る。通常の未判定再解析と同じ判定を通す：コード種別（Coke ON／PayPay／QUOカードPay）は正規のコードカードへ移し印を除去、URL は Analyzer で解析して確定済み商品カード／初回確認／未判定／使用済みのいずれかへ、それ以外は未判定へ。判定できたものは元のカードには残らない。
- 1回あたり上限100件。残りは応答の remaining で返し、ボタンの押し直しで続きを処理する。
- カード一覧に provisional_count（再判定できる件数）を追加した。enrichCards はテストで形が固定されているため変更せず、listCards 側で付与している。
- 物理DELETE・本番DBスキーマ・認証・収益・中央台帳・通常受信・公開URLは変更しない。migrationは実行しない。

公開対象は PR #32（マージコミット 5a3499367b5853b8be1ec8afed7348453f69aa39）を含む main。公開は専用ワークフロー card-reanalyze-release.yml で行い、公開前に check と全テストを再実行する。GitHub CI は PR #32 で成功済み。ローカルでは全215件中213件合格（残り2件は PWA アイコンのバイナリ未取得と miniflare 未導入という環境要因で、変更前も同一の2件が失敗することを確認済み）。新規テスト tests/card-reanalyze.test.mjs 5件で、コードの移動と印の除去・URL の初回確認行き・確定済み商品カードへの合流・判定不能の未判定行き・割当済みの対象外・確認文言と Origin の拒否・100件上限を検証した。

公開後は配信ファイル（app.js・styles.css・manifest 等）を本番とバイト照合する。本番公開の証跡は公開記録（card-reanalyze-publication-20261127.md）に追記する。スマートフォン実機での利用者確認は公開後に依頼する。
