"""Release the Aruno-Ticket share screen through the existing production guard."""
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
from time import sleep

spec = importlib.util.spec_from_file_location(
    "branding_release", Path(__file__).with_name("release-full-recopy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
guard = release.g
guard.STATE = guard.STATE.with_name("vault-aruno-ticket-private.json")
guard.OUT = Path("aruno-ticket-release-evidence.json")
release.BASE_SOURCE = "95c9a7afa184b40e6a7679871151b029d33047b5"
SHARE_ASSETS = ["share.html", "share.js", "styles.css", "sw.js"]
release.ASSETS = [*SHARE_ASSETS, "index.html", "manifest.json", "manifest.webmanifest"]
release.ALLOWED = {f"public/{name}" for name in SHARE_ASSETS} | {
    "tests/pwa.test.mjs", "scripts/release-aruno-ticket.py",
    ".github/workflows/aruno-ticket-release.yml",
}
release.expected_code_hash = lambda: release.hashlib.sha256(
    Path("release-bundle/worker.js").read_bytes()).hexdigest()


def preflight():
    release.preflight()
    state = json.loads(guard.STATE.read_text())
    guard.require(state["worker_hashes"] == [release.expected_code_hash()],
                  "SHARE_RELEASE_WOULD_CHANGE_WORKER_CODE")


def publish():
    state = json.loads(guard.STATE.read_text())
    guard.require(guard.active() == state["version"], "CONCURRENT_DEPLOYMENT")
    output = subprocess.check_output([
        "npx", "wrangler", "deploy", "--config", ".release-wrangler.json",
        "--keep-vars", "--message", "Aruno-Ticket share result",
    ], text=True)
    print(output, flush=True)
    match = re.search(r"Current Version ID: ([0-9a-f-]{36})", output)
    guard.require(match is not None, "PUBLISHED_VERSION_MISSING")
    version = match.group(1)
    Path(".ticket-version").write_text(version)
    old = guard.call(guard.endpoint("/versions/" + state["version"]))["resources"]
    new = guard.call(guard.endpoint("/versions/" + version))["resources"]
    for field in ["bindings", "script_runtime"]:
        before, after = old.get(field), new.get(field)
        if field == "bindings":
            before = sorted(before or [], key=lambda entry: entry["name"])
            after = sorted(after or [], key=lambda entry: entry["name"])
        guard.require(before == after, "VERSION_RESOURCE_CHANGED_" + field)
    current = guard.active()
    guard.require(current in (state["version"], version), "CONCURRENT_DEPLOYMENT")
    if current != version:
        guard.call(guard.endpoint("/deployments"), {
            "strategy": "percentage",
            "versions": [{"version_id": version, "percentage": 100}],
            "annotations": {"workers/message": "Activate Aruno-Ticket share result"},
        })


def verify():
    for attempt in range(6):
        try:
            guard.require(guard.active() == Path(".ticket-version").read_text(),
                          "PUBLISHED_VERSION_NOT_ACTIVE")
            release.verify()
            return
        except RuntimeError:
            if attempt == 5:
                raise
            sleep(5)


def rollback():
    if not Path(".ticket-version").exists():
        return
    state = json.loads(guard.STATE.read_text())
    current = guard.active()
    if current == state["version"]:
        return
    guard.require(current == Path(".ticket-version").read_text(), "CONCURRENT_DEPLOYMENT")
    guard.call(guard.endpoint("/deployments"), {
        "strategy": "percentage",
        "versions": [{"version_id": state["version"], "percentage": 100}],
    })
    guard.require(guard.active() == state["version"], "ROLLBACK_FAILED")
    print("Previous production version restored.")


if __name__ == "__main__":
    try:
        {"preflight": preflight, "publish": publish, "verify": verify,
         "rollback": rollback}[sys.argv[1]]()
    except Exception as error:
        print("Release stopped: " + (str(error) if isinstance(error, RuntimeError)
                                     else type(error).__name__), file=sys.stderr)
        sys.exit(1)
