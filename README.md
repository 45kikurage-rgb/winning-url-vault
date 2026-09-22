# Winning URL Vault

次回抽選から運用する当選URL管理専用サイトのベースです。

## Core rules
- URL受信時に解析し、確定済みカードは後から自動再判定・自動統合しない。
- 判定は表示名ではなく product_id が参照する正規化済み判定データで行う。
- URLクーポンは必須項目の正規化後「全一致」の場合だけ既存カードへ自動振り分ける。
- 情報不足・未知パターンは未判定URLへ隔離する。
- 未判定URLだけ、解析ルール更新後に利用者が「再解析」を押して再判定できる。
- 初回カード作成は画像・表記を確認し OK / 修正 / キャンセル。
- Coke ON / Amazonギフト券 / PayPay はコード判定系としてURL解析と分離する。
- 大量URLをカード画面へ一括描画せず、DBでは個別レコードとして保持する。

## Data model
product_master: raw_name / normalized_name / display_name / redeem_place / image
cards: product_id + expiry + specification fingerprint
items: URL/code inventory
unresolved_items: unresolved queue
