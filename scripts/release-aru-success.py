"""Verify the published Aru-Success branding without changing production."""
import importlib.util
import json
import sys
from time import sleep
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "recopy_release", Path(__file__).with_name("release-full-recopy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

ASSETS = [
    "index.html", "share.html", "manifest.json", "manifest.webmanifest", "sw.js",
    "icon-any-192.png", "icon-any-512.png", "icon-maskable-512.png",
]


def audit():
    guard = release.g
    previous = "22e38280-e8c4-4b06-adb1-6ee88a17227c"
    published = "29fe37a5-1cba-4728-b11e-f0c11bb12ea4"

    active = guard.active()
    print(f"Active production version: {active}", flush=True)
    release.require(active == published, "BRANDING_VERSION_NOT_ACTIVE")

    def assets_match():
        for name in ASSETS:
            status, live = guard.public("/" + name + "?branding-audit=" + published)
            if status != 200 or live != Path("public", name).read_bytes():
                print("Production asset differs: " + name, flush=True)
                return False
        return True

    for attempt in range(3):
        if assets_match():
            break
        sleep(8)
    else:
        raise RuntimeError("PRODUCTION_ASSETS_NOT_UPDATED")

    status, body = guard.public("/api/auth/status")
    auth = json.loads(body)
    release.require(status == 200 and auth.get("authenticated") is False
                    and auth.get("deviceOnlyMode") is True and auth.get("mode") == "production",
                    "AUTH_MODE_CHANGED")
    release.require(guard.public("/api/winning-lists")[0] == 401, "ANONYMOUS_WINNING_LIST")
    release.require(guard.public("/api/products/00000000-0000-0000-0000-000000000000/all-items")[0] == 401,
                    "ANONYMOUS_CODE_ACCESS")
    print("Eight production assets and anonymous access controls verified.", flush=True)

    old = guard.call(guard.endpoint("/versions/" + previous))["resources"]
    new = guard.call(guard.endpoint("/versions/" + published))["resources"]
    old_bindings = sorted(old.get("bindings", []), key=lambda entry: entry["name"])
    new_bindings = sorted(new.get("bindings", []), key=lambda entry: entry["name"])
    release.require(old_bindings and old_bindings == new_bindings, "VERSION_BINDINGS_CHANGED")
    old_runtime = old.get("script_runtime", {})
    new_runtime = new.get("script_runtime", {})
    changed = sorted(key for key in old_runtime.keys() | new_runtime.keys()
                     if old_runtime.get(key) != new_runtime.get(key))
    print("Changed version runtime fields: " + (", ".join(changed) or "none"), flush=True)
    release.require(not changed, "VERSION_RUNTIME_CHANGED")
    release.require(guard.schedules() == ["*/1 * * * *"], "CRON_SCHEDULE_CHANGED")
    print("Runtime, bindings and cron verified. No production changes during audit.", flush=True)


if __name__ == "__main__":
    try:
        audit()
    except Exception as error:
        print("Release stopped: " + (str(error) if isinstance(error, RuntimeError)
                                     else type(error).__name__), file=sys.stderr)
        sys.exit(1)
