# Boot splash publication - 2026-11-28

- 公開対象コミット: dc0820cfa8220c3e652be1722e246a8df95e3051（PR #35）
- リリース文書コミット: 71d42993350bba6a298bbc6c0689bc33b7ccc583
- ワークフロー追加コミット: 98f8b24c4718e2d4e1648cd12ea5b993117e04a0（.github/workflows/boot-splash-release.yml、内容は正本とバイト一致を確認）
- 確認結果（2026-11-28 09:32 JST頃）: 本番のトップHTMLに id="bootSplash" と初期非表示のログイン画面（login-screen hidden）があること、本番 /app.js が公開元とバイト一致し bootSplash を消す処理を含むことを直接取得して確認した。
- migration: 実行していない。
