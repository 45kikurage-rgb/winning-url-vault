"""Publish the PWA branding through the existing zero-migration release guard."""
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "recopy_release", Path(__file__).with_name("release-full-recopy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

release.g.STATE = release.g.STATE.with_name("vault-aru-success-private.json")
release.g.OUT = Path("aru-success-release-evidence.json")
release.BASE_SOURCE = "388d2891ad1f2358be44c31d0a4ad96a9a79e13a"
release.ASSETS = [
    "index.html", "share.html", "manifest.json", "manifest.webmanifest", "sw.js",
    "icon-any-192.png", "icon-any-512.png", "icon-maskable-512.png",
]
release.ALLOWED = {f"public/{name}" for name in release.ASSETS} | {
    "README.md", "tests/pwa.test.mjs", "scripts/release-aru-success.py",
    ".github/workflows/aru-success-release.yml",
}


def preflight():
    release.preflight()
    baseline = json.loads(release.g.STATE.read_text())
    release.require(baseline["worker_hashes"] == [release.expected_code_hash()],
                    "BRANDING_RELEASE_WOULD_CHANGE_WORKER_CODE")


if __name__ == "__main__":
    stages = {"preflight": preflight, "verify": release.verify, "rollback": release.rollback}
    try:
        release.require(len(sys.argv) == 2 and sys.argv[1] in stages, "USAGE")
        stages[sys.argv[1]]()
    except Exception as error:
        print("Release stopped: " + (str(error) if isinstance(error, RuntimeError)
                                     else type(error).__name__), file=sys.stderr)
        sys.exit(1)
