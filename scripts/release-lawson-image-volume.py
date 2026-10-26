"""Lawson image-volume release guards. Private settings are never printed or uploaded.

No database mutations. Coupon images and received URL data stay unchanged by this release.
No migrations apply, data copying, account-wide operations, or auth changes.
"""
import sys,os,json,hashlib,urllib.request,urllib.error,tempfile
from pathlib import Path
from email.parser import BytesParser
from email import policy

ACCOUNT='02100d2235d6f7d7f893b4217b58b902'
WORKER='winning-url-vault'
DB='1d3e496f-3d8c-49d7-892a-d32ea5661e0c'
BASE='535a212d-586f-41d6-ae38-1949c111d56e'
ROOT='https://winning-url-vault.45kikurage.workers.dev'
API='https://api.cloudflare.com/client/v4/'
STATE=Path(os.environ.get('RUNNER_TEMP',tempfile.gettempdir()))/'vault-lawson-image-volume-private.json'
OUT=Path('lawson-image-volume-evidence.json')

def require(ok,code):
    if not ok: raise RuntimeError(code)
def digest(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def call(path,body=None,raw=False):
    req=urllib.request.Request(API+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+os.environ['CLOUDFLARE_API_TOKEN'],'Content-Type':'application/json','User-Agent':'ARUNO-Lawson-Image-Volume-Release'})
    try:
        with urllib.request.urlopen(req,timeout=40) as response:
            data=response.read(40*1024*1024);ctype=response.headers.get('content-type','')
    except urllib.error.HTTPError as error: raise RuntimeError('CF_HTTP_'+str(error.code)) from None
    if raw:return data,ctype
    payload=json.loads(data);require(payload.get('success') is True,'CF_REQUEST_FAILED');return payload['result']
def endpoint(suffix=''):return f'accounts/{ACCOUNT}/workers/scripts/{WORKER}'+suffix
def get_settings():return call(endpoint('/settings'))
def active():
    deployments=call(endpoint('/deployments'))['deployments']
    require(bool(deployments),'NO_DEPLOYMENTS')
    versions=deployments[0]['versions'];require(len(versions)==1 and versions[0]['percentage']==100,'SPLIT_DEPLOYMENT')
    return versions[0]['version_id']
def code_hashes():
    data,mime=call(endpoint(),raw=True)
    if mime.startswith('multipart/'):
        msg=BytesParser(policy=policy.default).parsebytes(('Content-Type: '+mime+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+data)
        parts=[p.get_payload(decode=True) for p in msg.walk() if not p.is_multipart() and (p.get_filename() or p.get_param('name',header='content-disposition')) not in ('metadata','metadata.json')]
    else:parts=[data]
    return [hashlib.sha256(p).hexdigest() for p in parts],b'\n'.join(parts)
def runtime(settings):
    result={k:v for k,v in settings.items() if k not in ('annotations','assets','main_module','etag','modified_on','created_on')}
    if 'bindings' in result:result['bindings']=sorted(result['bindings'],key=lambda b:b['name'])
    return result
def schedules():
    data=call(endpoint('/schedules'))
    return sorted(row['cron'] for row in (data if isinstance(data,list) else data.get('schedules',[])))
def db_query(sql):
    r=call(f'accounts/{ACCOUNT}/d1/database/{DB}/query',{'sql':sql});require(all(x.get('success') for x in r),'D1_QUERY_FAILED');return r[0].get('results',[])
def schema():return db_query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
def public(path):
    req=urllib.request.Request(ROOT+path,headers={'User-Agent':'ARUNO-Approved-UI-Release','Cache-Control':'no-cache'})
    try:
        with urllib.request.urlopen(req,timeout=30) as r:return r.status,r.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
def write(report):OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')

def deployment_config(settings,subdomain):
    config=json.loads(Path('wrangler.jsonc').read_text())
    require(settings.get('compatibility_date')==config['compatibility_date'],'COMPATIBILITY_DATE_MISMATCH')
    for key in ('compatibility_flags','observability','limits','logpush','tail_consumers'):
        if key in settings and settings[key] is not None:config[key]=settings[key]
    # The API represents default placement as {}. Wrangler requires a mode if
    # placement is present. usage_model is API metadata, not a Wrangler option.
    placement=settings.get('placement') or {}
    if placement.get('mode'):config['placement']=placement
    config.pop('vars',None)
    config['workers_dev']=subdomain['enabled']
    config['preview_urls']=subdomain.get('previews_enabled',False)
    return config

def preflight():
    require(active()==BASE,'UNEXPECTED_PRODUCTION_VERSION')
    settings=get_settings()
    bindings=settings.get('bindings',[])
    known={'AI','ASSETS','COUPON_ANALYZER','LEDGER_READER','LEDGER_VAULT','DB','ANALYSIS_QUEUE'}
    require(all(b['type'] in ('secret_text','plain_text','json') or b['name'] in known for b in bindings),'UNDECLARED_RUNTIME_BINDING')
    database=next((b for b in bindings if b['name']=='DB'),{})
    require((database.get('id') or database.get('database_id'))==DB,'DATABASE_MISMATCH')
    subdomain=call(endpoint('/subdomain'))
    config=deployment_config(settings,subdomain)
    Path('.release-wrangler.json').write_text(json.dumps(config))
    hashes,source=code_hashes()
    require(b'const unitPrice = value' in source and b'INVALID_UNIT_PRICE' in source,'LIVE_PRICE_SOURCE_NOT_CONFIRMED')
    before_schema=schema()
    state={'settings':runtime(settings),'before_schema':before_schema,'schedules':schedules(),'subdomain':subdomain,'base_version':BASE}
    STATE.write_text(json.dumps(state));STATE.chmod(0o600)
    write({'source_sha':os.environ['GITHUB_SHA'],'base_version':BASE,'strict_price_source_confirmed':True,'before_code_sha256':hashes,'stage':'preflight_passed','before_schema_sha256':digest(before_schema),'real_device_test':'pending'})
    print('Preflight passed; original runtime snapshot retained privately.')

def verify():
    state=json.loads(STATE.read_text());settings=get_settings()
    require(runtime(settings)==state['settings'],'RUNTIME_SETTINGS_CHANGED')
    require(schedules()==state['schedules'],'CRON_CHANGED')
    require(call(endpoint('/subdomain'))==state['subdomain'],'PUBLICATION_SCOPE_CHANGED')
    require(schema()==state['before_schema'],'EXISTING_SCHEMA_CHANGED')
    version=active();require(version!=BASE,'VERSION_NOT_UPDATED')
    hashes,source=code_hashes();require(b'const unitPrice = Number(value)' not in source and b'INVALID_LIST_STATE' in source and b'inspectUnexportedItems' in source and b'provisional_deleted' in source and b'deleteProvisionalItem' in source and b'coupon_title' in source and b'printedVolume' in source,'NEW_WORKER_CODE_MISMATCH')
    require(len(hashes)==1,'UNEXPECTED_MODULE_COUNT')
    expected=hashlib.sha256(Path('release-bundle/index.js').read_bytes()).hexdigest()
    require(hashes==[expected],'DOWNLOADED_WORKER_DIFFERS_FROM_BUILD')
    files=['index.html','styles.css','app.js','sw.js','display-name.js','winning-view.js','provisional-ui.js','device-login.js','network-read.js','share.js','manifest.json']
    assets=[]
    for name in files:
        status,data=public('/'+name+'?release='+os.environ['GITHUB_SHA'])
        require(status==200,'ASSET_HTTP_'+name)
        require(data==Path('public',name).read_bytes(),'ASSET_HASH_'+name)
        assets.append({'path':'/'+name,'sha256':hashlib.sha256(data).hexdigest()})
    status,data=public('/api/auth/status');auth=json.loads(data)
    require(status==200 and auth.get('authenticated') is False and auth.get('deviceOnlyMode') is True and auth.get('mode')=='production','AUTH_STATE_CHANGED')
    for path in ('/api/cards','/api/winning-lists','/api/display-names','/api/provisional','/api/provisional/A/items/00000000-0000-0000-0000-000000000000','/api/products/00000000-0000-0000-0000-000000000000/unexported-items','/api/products/00000000-0000-0000-0000-000000000000/list-state'):
        require(public(path)[0]==401,'AUTH_GUARD_FAILED')
    report=json.loads(OUT.read_text());report.update(stage='published_verified',version=version,traffic_percent=100,runtime_settings_unchanged=True,cron_unchanged=True,publication_scope_unchanged=True,downloaded_worker_matches_build=True,after_code_sha256=hashes,assets=assets,anonymous_guards_passed=True,real_device_test='pending');write(report)
    print('Production Worker bytes, assets, authentication guards, and runtime preservation verified.')

if __name__ == '__main__':
  try:
    {'preflight':preflight,'verify':verify}[sys.argv[1]]()
  except Exception as error:
    # Never include API bodies, private settings, tokens, or raw exception text.
    code=str(error) if isinstance(error,RuntimeError) else type(error).__name__
    print('Release stopped: '+code,file=sys.stderr);sys.exit(1)

