"""Publish sorting removal without any production DB mutation or schema change."""
import importlib.util,os,json,subprocess,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location('release_guards',Path(__file__).with_name('release-provisional-controls.py'))
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
g.STATE=g.STATE.with_name('vault-sorting-delete-private.json')
g.OUT=Path('sorting-delete-release-evidence.json')
assets=['index.html','app.js','sw.js']

def preflight():
    settings=g.get_settings();baseline=g.active();subdomain=g.call(g.endpoint('/subdomain'))
    binding=next((b for b in settings['bindings'] if b['name']=='DB'),{})
    g.require((binding.get('id') or binding.get('database_id'))==g.DB,'DATABASE_MISMATCH')
    known={'AI','ASSETS','COUPON_ANALYZER','LEDGER_READER','LEDGER_VAULT','DB','ANALYSIS_QUEUE'}
    g.require(all(b['type'] in ('secret_text','plain_text','json') or b['name'] in known for b in settings['bindings']),'UNDECLARED_RUNTIME_BINDING')
    # Refuse to publish over an unseen frontend update from another work session.
    for name in assets:
        old=subprocess.check_output(['git','show','HEAD^:public/'+name])
        status,data=g.public('/'+name+'?preflight='+os.environ['GITHUB_SHA'])
        g.require(status==200 and data==old,'UNEXPECTED_BASELINE_'+name)
    state={'settings':g.runtime(settings),'schema':g.schema(),'schedules':g.schedules(),'subdomain':subdomain,'baseline':baseline}
    g.STATE.write_text(json.dumps(state));g.STATE.chmod(0o600)
    Path('.release-wrangler.json').write_text(json.dumps(g.deployment_config(settings,subdomain)))
    g.write({'source_sha':os.environ['GITHUB_SHA'],'baseline':baseline,'stage':'preflight_passed','database_mutations':0})
    print('Read-only preflight passed; runtime and schema preserved. No user URL data read or written.')

def verify():
    state=json.loads(g.STATE.read_text())
    g.require(g.runtime(g.get_settings())==state['settings'],'RUNTIME_CHANGED')
    g.require(g.schema()==state['schema'],'SCHEMA_CHANGED')
    g.require(g.schedules()==state['schedules'],'SCHEDULE_CHANGED')
    g.require(g.call(g.endpoint('/subdomain'))==state['subdomain'],'PUBLICATION_SCOPE_CHANGED')
    version=g.active();g.require(version!=state['baseline'],'VERSION_NOT_UPDATED')
    hashes,source=g.code_hashes()
    expected=hashlib.sha256(Path('release-bundle/index.js').read_bytes()).hexdigest()
    g.require(hashes==[expected],'LIVE_WORKER_DIFFERS_FROM_TESTED_BUILD')
    for name in assets+['styles.css']:
        status,data=g.public('/'+name+'?release='+os.environ['GITHUB_SHA'])
        g.require(status==200 and data==Path('public',name).read_bytes(),'LIVE_ASSET_MISMATCH_'+name)
    route='/api/cards/00000000-0000-0000-0000-000000000000/delete-unassigned'
    for source in ['arunomatic','chiritumo']:
        g.require(g.public(route+'?intake_source='+source)[0]==401,'ANONYMOUS_DELETE_GUARD_FAILED')
    report=json.loads(g.OUT.read_text());report.update(stage='published_verified',deployed_version=version,worker_sha256=expected,served_bytes_verified=True,runtime_preserved=True,schema_preserved=True,database_mutations=0,real_device_test='pending')
    g.write(report)
    print('Production Worker and public asset bytes match the tested source; runtime, schema and authentication retained.')

if __name__=='__main__':
    import sys
    try:{'preflight':preflight,'verify':verify}[sys.argv[1]]()
    except Exception as error:
        print('Release stopped: '+(str(error) if isinstance(error,RuntimeError) else type(error).__name__),file=sys.stderr);sys.exit(1)
