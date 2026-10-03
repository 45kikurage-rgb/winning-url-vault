import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../public/", import.meta.url);

async function text(name) {
  return readFile(new URL(name, root), "utf8");
}

function pngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), "PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("PWA manifests expose the Android share target", async () => {
  const manifest = JSON.parse(await text("manifest.json"));
  const alternate = JSON.parse(await text("manifest.webmanifest"));
  assert.deepEqual(alternate, manifest);
  assert.equal(manifest.name, "当選URL管理");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.background_color, "#ffffff");
  assert.deepEqual(manifest.share_target, {
    action: "/share",
    method: "POST",
    enctype: "multipart/form-data",
    params: { title: "title", text: "text", url: "url" }
  });
  assert.ok(manifest.icons.some(icon => icon.sizes === "192x192" && icon.purpose === "any"));
  assert.ok(manifest.icons.some(icon => icon.sizes === "512x512" && icon.purpose === "any"));
  assert.ok(manifest.icons.some(icon => icon.sizes === "512x512" && icon.purpose === "maskable"));
});

test("PWA icon files have the declared dimensions", async () => {
  for (const [name, width] of [["icon-any-192.png", 192], ["icon-any-512.png", 512], ["icon-maskable-512.png", 512]]) {
    const size = pngSize(await readFile(new URL(name, root)));
    assert.deepEqual(size, { width, height: width });
  }
});

test("service worker handles POST shares and precaches the receiving screen", async () => {
  const worker = await text("sw.js");
  assert.match(worker, /request\.method === "POST"/);
  assert.match(worker, /url\.pathname === "\/share"/);
  assert.match(worker, /request\.formData\(\)/);
  assert.match(worker, /"\/share\.html"/);
  assert.match(worker, /"\/manifest\.json"/);
});

test("both launch pages register or reference the PWA", async () => {
  const index = await text("index.html");
  const app = await text("app.js");
  const share = await text("share.html");
  assert.match(index, /rel="manifest" href="\/manifest\.json"/);
  assert.match(app, /serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(share, /src="\/share\.js"/);
  assert.match(share, /src="\/icon-any-512\.png"/);
});

test("当選リストは未設定・処理中・完了を分離し、固定下部タブとsafe-areaを使う", async () => {
  const index = await text("index.html");
  const app = await text("app.js");
  const styles = await text("styles.css");
  assert.match(index, /class="main-tabs"/);
  assert.match(index, /id="unitPriceInput"/);
  assert.match(app, /item\.output_method === "unset" \? 0/);
  assert.match(app, /class="needs-setting">要設定/);
  assert.match(app, /未設定なので、まだ出せません/);
  assert.match(app, /unset[\s\S]*data-method-product/);
  assert.doesNotMatch(app, /\$\{unset \? "抽出方法を設定" : "抽出"\}/);
  assert.match(app, /class="winning-card \$\{unset \? "is-unset" : complete \? "is-complete"/);
  assert.match(app, /meta = `\$\{esc\(item\.redemption_place[\s\S]*\/ 期限/);
  assert.match(styles, /\.main-tabs\{position:fixed;[\s\S]*bottom:0/);
  assert.match(styles, /env\(safe-area-inset-bottom/);
  assert.match(styles, /\.winning-actions\{display:grid;grid-template-columns:1fr auto/);
  assert.match(styles, /\.winning-card\.is-complete\{opacity:/);
});

test("全タブ共通の固定ヘッダーと中央スクロール、コンパクトなURL入力欄を備える", async () => {
  const index = await text("index.html");
  const app = await text("app.js");
  const styles = await text("styles.css");
  assert.match(index, /id="headerMonthlyRevenue"/);
  assert.match(index, /id="headerDailyRevenue"/);
  assert.match(app, /api\("\/api\/revenue\/summary"\)/);
  assert.match(app, /document\.body\.dataset\.activeTab = selected/);
  assert.match(styles, /data-operation-mode="production"\]\{height:100dvh;overflow:hidden/);
  assert.match(styles, /env\(safe-area-inset-top/);
  assert.match(styles, /\.tab-page:not\(\.hidden\)\{flex:1 1 auto;min-height:0;overflow-y:auto/);
  assert.match(styles, /\.receive textarea\{height:clamp\(120px,22dvh,190px\)/);
  assert.doesNotMatch(styles, /data-active-tab="receive"\][^\{]*h1/);
});

test("受信完了表示を自動で閉じ、仕分けカードと当選リストの重複表示を省く", async () => {
  const index = await text("index.html");
  const app = await text("app.js");
  const styles = await text("styles.css");
  assert.match(app, /job\.status === "completed"[\s\S]*setTimeout/);
  assert.match(app, /state\.dismissedJobId = job\.id/);
  assert.doesNotMatch(app, /coupon-foot"><strong>\$\{Number\(card\.count/);
  assert.doesNotMatch(index, /id="refreshWinningLists"/);
  assert.match(styles, /\.receive\.panel\{margin:14px 0 0/);
});
