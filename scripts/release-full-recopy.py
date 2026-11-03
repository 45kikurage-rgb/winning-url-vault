"""One-time read-only full-copy release guard. Never accesses or mutates coupon values."""
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("vault_guard", Path(__file__).with_name("release-provisional-controls.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
g.STATE = g.STATE.with_name("vault-full-recopy-private.json")
g.OUT = Path("full-recopy-release-evidence.json")
BASE_SOURCE = "8de9e93c8c6d4c9ba4bc3fbc7de3f3be324d72f6"
ASSETS = ["index.html", "app.js", "styles.css", "sw.js", "winning-view.js", "single-win-ui.js"]
ALLOWED = {
    "src/extraction.js", "src/index.js", "public/app.js", "public/index.html",
    "public/styles.css", "public/sw.js", "tests/integration.test.mjs",
    "scripts/release-full-recopy.py", ".github/workflows/full-recopy-release.yml",
    "docs/releases/full-recopy-20261103.md"
}

def require(condition, message):
    g.require(condition, message)

def expected_code_hash():
    return hashlib.sha256(Path("release-bundle/index.js").read_bytes()).hexdigest()

def preflight():
    changed = set(subprocess.check_output(
        ["git", "diff", "--name-only", BASE_SOURCE, os.environ["GITHUB_SHA"]], text=True).splitlines())
    require(changed and changed <= ALLOWED, "UNREVIEWED_FILE_CHANGE")
    base_config = subprocess.check_output(["git", "show", BASE_SOURCE + ":wrangler.jsonc"])
    require(base_config == Path("wrangler.jsonc").read_bytes(), "UNREVIEWED_CONFIGURATION_CHANGE")
    settings = g.get_settings()
    bindings = settings.get("bindings", [])
    known = {"AI","ASSETS","COUPON_ANALYZER","LEDGER_READER","LEDGER_VAULT","ALIGN_SINGLE_WIN","DB","ANALYSIS_QUEUE"}
    require(all(x.get("type") in ("secret_text","plain_text","json") or x["name"] in known for x in bindings),
            "UNREVIEWED_RUNTIME_BINDING")
    db = next((x for x in bindings if x["name"] == "DB"), {})
    require((db.get("id") or db.get("database_id")) == g.DB, "DATABASE_BINDING_CHANGED")
    # Reject publishing on top of any previously unseen live frontend update.
    for name in ASSETS:
        old = subprocess.check_output(["git","show",BASE_SOURCE + ":public/" + name])
        status, live = g.public("/" + name + "?preflight=" + os.environ["GITHUB_SHA"])
        require(status == 200 and live == old, "UNEXPECTED_LIVE_BASELINE_" + name)
    subdomain = g.call(g.endpoint("/subdomain"))
    snapshot = {
        "version":g.active(), "worker_hashes":g.code_hashes()[0],
        "settings":g.runtime(settings), "schema":g.schema(),
        "schedules":g.schedules(), "subdomain":subdomain
    }
    # Preserve private runtime state only on ephemeral runner; never upload this file.
    g.STATE.write_text(json.dumps(snapshot))
    g.STATE.chmod(0o600)
    Path(".release-wrangler.json").write_text(json.dumps(g.deployment_config(settings,subdomain)))
    g.write({"source_sha":os.environ["GITHUB_SHA"],"stage":"preflight_passed",
             "previous_version":snapshot["version"],"database_mutations":0})
    print("Safe production preflight passed; no business rows or secrets inspected.")

def consistent(state):
    require(g.runtime(g.get_settings()) == state["settings"], "RUNTIME_SETTINGS_CHANGED")
    require(g.schema() == state["schema"], "DATABASE_SCHEMA_CHANGED")
    require(g.schedules() == state["schedules"], "CRON_SCHEDULE_CHANGED")
    require(g.call(g.endpoint("/subdomain")) == state["subdomain"], "PUBLICATION_SCOPE_CHANGED")

def verify():
    state = json.loads(g.STATE.read_text())
    consistent(state)
    version = g.active()
    require(version != state["version"], "PUBLICATION_VERSION_UNCHANGED")
    hashes, _ = g.code_hashes()
    require(hashes == [expected_code_hash()], "LIVE_WORKER_DIFFERS_FROM_REVIEWED_BUILD")
    asset_hashes = {}
    for name in ASSETS:
        status, live = g.public("/" + name + "?verify=" + os.environ["GITHUB_SHA"])
        expected = Path("public",name).read_bytes()
        require(status == 200 and live == expected, "PUBLIC_ASSET_MISMATCH_" + name)
        asset_hashes[name] = hashlib.sha256(live).hexdigest()
    code_path="/api/products/00000000-0000-0000-0000-000000000000/all-items"
    require(g.public(code_path)[0] == 401, "ANONYMOUS_CODE_ACCESS")
    require(g.public("/api/winning-lists")[0] == 401, "ANONYMOUS_WINNING_LIST")
    status, response = g.public("/api/auth/status")
    auth = json.loads(response)
    require(status == 200 and auth.get("authenticated") is False and
            auth.get("deviceOnlyMode") is True and auth.get("mode") == "production", "AUTH_MODE_CHANGED")
    g.write({"source_sha":os.environ["GITHUB_SHA"],"stage":"published_verified",
             "previous_version":state["version"],"current_version":version,
             "worker_sha256":expected_code_hash(),"assets_sha256":asset_hashes,
             "runtime_preserved":True,"schema_preserved":True,"database_mutations":0,
             "physical_device_test":"pending"})
    print("Live source, assets, authentication and runtime state verified.")

def rollback():
    if not g.STATE.exists():
        print("No preflight state, no deployment to reverse.")
        return
    state = json.loads(g.STATE.read_text())
    if g.active() == state["version"]:
        print("Original version is still running.")
        return
    # Do not rollback a concurrent different deployment.
    require(g.code_hashes()[0] == [expected_code_hash()], "ROLLBACK_REFUSED_OTHER_DEPLOYMENT")
    consistent(state)
    g.call(g.endpoint("/deployments"), {
        "strategy":"percentage",
        "versions":[{"version_id":state["version"],"percentage":100}],
        "annotations":{"workers/message":"Restore prior version after full-recopy verification failure"}
    })
    require(g.active() == state["version"], "ROLLBACK_NOT_APPLIED")
    require(g.code_hashes()[0] == state["worker_hashes"], "ROLLBACK_CODE_MISMATCH")
    consistent(state)
    g.write({"source_sha":os.environ["GITHUB_SHA"],"stage":"rolled_back",
             "previous_version":state["version"],"database_mutations":0})
    print("Prior Worker version restored; no data or schema writes.")

if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ("preflight","verify","rollback"), "USAGE")
        {"preflight":preflight,"verify":verify,"rollback":rollback}[sys.argv[1]]()
    except Exception as e:
        print("Release stopped: " + (str(e) if isinstance(e,RuntimeError) else type(e).__name__), file=sys.stderr)
        sys.exit(1)
