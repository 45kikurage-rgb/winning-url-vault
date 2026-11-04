"""Guard the Aru-Success read-only Worker release."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, "scripts")
import importlib
g = importlib.import_module("release-provisional-controls")
g.STATE = g.STATE.with_name("vault-mybest-daily-private.json")

def saved():
    return json.loads(g.STATE.read_text())

def module_hash():
    return hashlib.sha256(Path("release-bundle/worker.js").read_bytes()).hexdigest()

def runtime(settings):
    return g.runtime(settings)

def preflight():
    base = "95a16a1d1b7cd47405bcd265d7c76c2811570f93"
    changes = set(subprocess.check_output(["git","diff","--name-only",base,"HEAD"],text=True).splitlines())
    allowed = {"wrangler.jsonc","src/worker.js","src/mybest-daily-revenue.js",
      "tests/mybest-daily-revenue.test.js","scripts/release-mybest-daily.py",".github/workflows/mybest-daily-release.yml"}
    g.require(changes <= allowed,"UNREVIEWED_VAULT_CHANGE")
    before = json.loads(subprocess.check_output(["git","show",base+":wrangler.jsonc"]))
    after = json.loads(Path("wrangler.jsonc").read_text())
    before["main"] = "src/worker.js"
    g.require(before == after,"UNEXPECTED_CONFIG")
    settings = g.get_settings()
    db = next((x for x in settings["bindings"] if x["name"]=="DB"),{})
    g.require((db.get("id") or db.get("database_id"))==g.DB,"D1_BINDING_CHANGED")
    subdomain = g.call(g.endpoint("/subdomain"))
    state = {"version":g.active(),"code":g.code_hashes()[0],"settings":runtime(settings),
             "subdomain":subdomain,"schema":g.schema(),"schedules":g.schedules()}
    g.STATE.write_text(json.dumps(state))
    g.STATE.chmod(0o600)
    Path(".release-wrangler.json").write_text(json.dumps(g.deployment_config(settings,subdomain)))
    print("Existing Vault runtime, D1 and rollback version verified")

def verify():
    s=saved()
    g.require(g.active()!=s["version"],"VERSION_UNCHANGED")
    hashes, code=g.code_hashes()
    g.require(hashes==[module_hash()] and b"MyBestRevenueAPI" in code,"UNEXPECTED_LIVE_CODE")
    g.require(runtime(g.get_settings())==s["settings"],"RUNTIME_CHANGED")
    g.require(g.schema()==s["schema"] and g.schedules()==s["schedules"],"DB_OR_SCHEDULE_CHANGED")
    g.require(g.call(g.endpoint("/subdomain"))==s["subdomain"],"SUBDOMAIN_CHANGED")
    status, data=g.public("/api/auth/status")
    g.require(status==200 and json.loads(data).get("authenticated") is False,"AUTH_MODE_CHANGED")
    g.require(g.public("/api/winning-lists")[0]==401,"ANONYMOUS_ACCESS_CHANGED")
    g.require(g.public("/api/revenue/daily")[0] in (401,404),"INTERNAL_ROUTE_PUBLIC")
    print("Vault internal reader live, public auth and database schema unchanged")

def rollback():
    s=saved()
    if g.active()==s["version"]:return
    g.require(g.code_hashes()[0]==[module_hash()],"ROLLBACK_REFUSED_OTHER_DEPLOYMENT")
    g.call(g.endpoint("/deployments"),{"strategy":"percentage","versions":[{"version_id":s["version"],"percentage":100}]})
    g.require(g.active()==s["version"] and g.code_hashes()[0]==s["code"],"ROLLBACK_FAILED")
    print("Previous Vault worker restored")

try:
    {"preflight":preflight,"verify":verify,"rollback":rollback}[sys.argv[1]]()
except Exception as e:
    print("Release stopped: "+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr)
    sys.exit(1)
