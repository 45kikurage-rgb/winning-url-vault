"""Read-only guarded release, reused for the approved 2026-11-15 audit fixes.

No migration or business-row access. The existing full-recopy workflow is the
serialized release entry point; its production credentials remain in CI only.
"""
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from copy import deepcopy
from time import sleep
from pathlib import Path

spec = importlib.util.spec_from_file_location("vault_guard", Path(__file__).with_name("release-provisional-controls.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
g.STATE = g.STATE.with_name("vault-full-recopy-private.json")
g.OUT = Path("full-recopy-release-evidence.json")
BASE_SOURCE = "1806000c903502252200d4d3435aab7132f15c03"
BASE_WORKER = "49babf4779002e8e77d80f6152909062df47f310471e56da401b79d87b8eac71"
BASE_VERSION = "68927a28-b7ed-45c1-a9ea-3f4853208f43"
ASSETS = sorted(str(path.relative_to('public')) for path in Path('public').rglob('*') if path.is_file())
ALLOWED = {
    "docs/AUDIT_FIXES_2026-11-15.md", "public/app.js", "public/device-login.js",
    "public/index.html", "public/network-read.js", "public/share.html", "public/share.js",
    "public/styles.css", "public/sw.js", "src/extraction.js", "src/index.js",
    "src/ledger.js", "src/provisional.js", "tests/analysis-intake-regression.test.mjs",
    "tests/assignment-export-safety.test.mjs", "tests/device-pairing-recovery.test.mjs",
    "tests/network-read.test.mjs", "tests/pwa.test.mjs", "tests/share-reliability.test.mjs",
    "tests/ui-async-safety.test.mjs", "scripts/release-full-recopy.py",
    "scripts/test-audit-release-guards.py", "docs/releases/full-recopy-20261103.md"
}
spec = importlib.util.spec_from_file_location('queue_guards', Path(__file__).with_name('release-mobile-reliability.py'))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

def runtime(settings):
    return q.normalized_runtime(deepcopy(settings))

def validate_targets(config, settings, queues):
    # Reuse the established queue/service validator, omitting only its old
    # "new Align binding must be absent" rule. Align is already live here.
    existing = deepcopy(config)
    existing['services'] = [s for s in existing['services'] if s['binding'] != 'ALIGN_SINGLE_WIN']
    q.validate_live_targets(existing, settings, queues)
    for service in config['services']:
        live = next((b for b in settings['bindings'] if b['name'] == service['binding']), {})
        require(live.get('type') == 'service' and live.get('service') == service['service']
                and live.get('entrypoint') == service.get('entrypoint')
                and live.get('environment') in (None, 'production'), 'LIVE_SERVICE_TARGET_CHANGED')

def require(condition, message):
    g.require(condition, message)

def expected_code_hash():
    return hashlib.sha256(Path("release-bundle/worker.js").read_bytes()).hexdigest()

def preflight():
    changed = set(subprocess.check_output(
        ["git", "diff", "--name-only", BASE_SOURCE, os.environ["GITHUB_SHA"]], text=True).splitlines())
    require(changed and changed <= ALLOWED, "UNREVIEWED_FILE_CHANGE")
    base_config = subprocess.check_output(["git", "show", BASE_SOURCE + ":wrangler.jsonc"])
    require(base_config == Path("wrangler.jsonc").read_bytes(), "UNREVIEWED_CONFIGURATION_CHANGE")
    baseline_version = g.active()
    require(baseline_version == BASE_VERSION, 'UNEXPECTED_PRODUCTION_VERSION')
    baseline_resources = g.call(g.endpoint('/versions/' + baseline_version))['resources']
    require(bool(baseline_resources.get('script', {}).get('etag')), 'BASELINE_VERSION_HASH_MISSING')
    # The script-content API can still expose the latest uploaded candidate
    # after a version rollback. Pin the previously verified active version too;
    # only our two known builds are allowed at the content API.
    require(g.code_hashes()[0] in ([BASE_WORKER], [expected_code_hash()]), 'UNEXPECTED_PRODUCTION_WORKER')
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
    config = g.deployment_config(settings, subdomain)
    queues = q.queue_state(config)
    validate_targets(config, settings, queues)
    schedules = g.schedules()
    require(sorted(config['triggers']['crons']) == schedules, 'LIVE_CRON_CONFIGURATION_CHANGED')
    snapshot = {
        "version":baseline_version, "worker_hashes":[BASE_WORKER],
        "settings":runtime(settings), "schema":g.schema(),
        "schedules":schedules, "subdomain":subdomain, "queues":queues,
        "version_resources":baseline_resources
    }
    require(g.active() == baseline_version and
            g.call(g.endpoint('/versions/' + baseline_version))['resources'] == baseline_resources, 'PRODUCTION_MOVED')
    # Preserve private runtime state only on ephemeral runner; never upload this file.
    g.STATE.write_text(json.dumps(snapshot))
    g.STATE.chmod(0o600)
    Path(".release-wrangler.json").write_text(json.dumps(config))
    g.write({"source_sha":os.environ["GITHUB_SHA"],"stage":"preflight_passed",
             "previous_version":snapshot["version"],"database_mutations":0})
    print("Safe production preflight passed; no business rows or secrets inspected.")

def consistent(state):
    require(runtime(g.get_settings()) == state["settings"], "RUNTIME_SETTINGS_CHANGED")
    require(g.schema() == state["schema"], "DATABASE_SCHEMA_CHANGED")
    require(g.schedules() == state["schedules"], "CRON_SCHEDULE_CHANGED")
    require(g.call(g.endpoint("/subdomain")) == state["subdomain"], "PUBLICATION_SCOPE_CHANGED")
    require(q.queue_state(json.loads(Path('wrangler.jsonc').read_text())) == state['queues'], 'QUEUE_CONFIGURATION_CHANGED')

def verify_once():
    state = json.loads(g.STATE.read_text())
    version = g.active()
    require(version != state["version"], "PUBLICATION_VERSION_UNCHANGED")
    hashes, _ = g.code_hashes()
    require(hashes == [expected_code_hash()], "LIVE_WORKER_DIFFERS_FROM_REVIEWED_BUILD")
    Path('.audit-deployed-version').write_text(version)
    consistent(state)
    asset_hashes = {}
    for name in ASSETS:
        status, live = g.public("/" + name + "?verify=" + os.environ["GITHUB_SHA"])
        expected = Path("public",name).read_bytes()
        if status != 200 or live != expected:
            print(json.dumps({'asset':name,'status':status,
                              'expected_sha256':hashlib.sha256(expected).hexdigest(),
                              'actual_sha256':hashlib.sha256(live).hexdigest()}), flush=True)
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
             "runtime_preserved":True,"schema_preserved":True,"queues_preserved":True,"database_mutations":0,
             "physical_device_test":"pending"})
    print("Live source, assets, authentication and runtime state verified.")

def verify():
    # Version activation and edge asset routing do not become visible together.
    # Require exact bytes throughout; allow a bounded propagation window.
    for attempt in range(12):
        try:
            return verify_once()
        except RuntimeError as error:
            retryable = str(error).startswith(('PUBLIC_ASSET_MISMATCH_', 'LIVE_WORKER_DIFFERS_',
                                              'PUBLICATION_VERSION_UNCHANGED'))
            if not retryable or attempt == 11:
                raise
            print('Waiting for exact production bytes: ' + str(error), flush=True)
            sleep(5)

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
    require(Path('.audit-deployed-version').exists() and
            g.active() == Path('.audit-deployed-version').read_text(), 'ROLLBACK_REFUSED_CONCURRENT_VERSION')
    consistent(state)
    g.call(g.endpoint("/deployments"), {
        "strategy":"percentage",
        "versions":[{"version_id":state["version"],"percentage":100}],
        "annotations":{"workers/message":"Restore prior version after full-recopy verification failure"}
    })
    require(g.active() == state["version"], "ROLLBACK_NOT_APPLIED")
    require(g.call(g.endpoint('/versions/' + state['version']))['resources'] == state['version_resources'],
            'ROLLBACK_VERSION_RESOURCES_MISMATCH')
    consistent(state)
    g.write({"source_sha":os.environ["GITHUB_SHA"],"stage":"rolled_back",
             "previous_version":state["version"],"database_mutations":0})
    print("Prior Worker version restored; no data or schema writes.")

if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ("preflight","verify","rollback"), "USAGE")
        if sys.argv[1] == 'preflight':
            subprocess.run([sys.executable, 'scripts/test-audit-release-guards.py'], check=True)
        {"preflight":preflight,"verify":verify,"rollback":rollback}[sys.argv[1]]()
    except Exception as e:
        print("Release stopped: " + (str(e) if isinstance(e,RuntimeError) else type(e).__name__), file=sys.stderr)
        sys.exit(1)
