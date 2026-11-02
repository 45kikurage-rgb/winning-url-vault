# F 独立確認: Vault の本番公開と接続設定保全

判定: **PASS（ローカルの独立異常系検証。実際の本番公開結果は root の別証跡）**。

対象は root が実装した `scripts/release-mobile-reliability.py` と既存 helper、公開 workflow。F 自身が作成した単発登録本体とは別の確認ハードルとした。

## 発見して修正された点

1. preflight は binding 名と DB ID を確認していたが、同名 service の接続先が変更された場合に repo 設定で上書きし、その後の verify で気付く経路があった。root が live service/entrypoint/environment、D1、AI/assets 型、queue producer 名/ID/遅延、queue consumer 対象/バッチ/待機/再送/同時数の照合を追加した。
2. rollback が同じ候補コードと cron の一致だけで進み、他者の runtime / workers.dev 変更を上書きし得た。root が期待 runtime（元設定＋新専用 binding）、workers.dev、queue 設定一致の guard を追加した。
3. F の最終補足で migrate 直前の cron / workers.dev 不変、queue 名と ID の同時一致を追加した。

修正前に異常系が失敗することを確認し、修正後に再実行した。schema 全消去・業務 URL データの復元/削除を行う rollback はない。旧 Worker へ戻す際も異なる公開変更を上書きせず停止する。

## 再実行可能な独立試験

`python3 scripts/test-mobile-release-independent.py`: **5 親テスト PASS**。

- live service の接続先を変更した状態では、公開用 config が作られる前に停止する。
- 正常な既存契約は受理し、service / DB / queue名 / queueID / delay / batch / concurrency / consumer の **8 負例**を拒否する。
- migrate の直前に cron または workers.dev が変わる **2 負例**は、DB 変更前に停止する。
- 同じ候補コードでも runtime が同時変更されれば rollback の変更 API を呼ばない。
- workers.dev の同時変更でも rollback の変更 API を呼ばない。

既存 `scripts/test-mobile-release-guards.py` の **9 試験**も PASS。公開ソース/版固定、追加 schema だけを許可、未知 schema 拒否、破壊 SQL 拒否、Service Binding の production 環境正規化、設定差分固定、他コードへの rollback 拒否を確認した。

独立試験は repo 内へ配置し、root が候補/本番 CI から実行する。初期再現ファイル `implementation-notes/F-review-vault-release.test.py` は調査時点のコピーで、最新は repo 内を正とする。

## 制限

この gate は credentials を使用せず、異常系を合成 API 応答で注入したコード検証である。本番 Cloudflare の実設定取得、time travel bookmark、SQL 適用、配信 Worker/asset hash、認証付き named RPC、本番 UI、Pixel 10 実機操作の証拠を代替しない。

本番で未想定の service / queue / setting を見つけた場合は guard が停止する。停止を迂回して設定を上書きするのではなく、root が実状態を確認して取り扱う必要がある。
