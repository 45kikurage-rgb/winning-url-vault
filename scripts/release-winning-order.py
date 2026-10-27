"""Winning-order release guards. Private settings are never printed or uploaded.

Display-order change only. No database mutations, no migrations, no data
copying, no account-wide operations, and no auth changes in this release.
"""
import sys, os, json, re, hashlib, urllib.request, urllib.error, tempfile
from pathlib import Path
from email.parser import BytesParser
from email import policy

ACCOUNT = '02100d2235d6f7d7f893b4217b58b902'
WORKER = 'winning-url-vault'
BASE = '535a212d-586f-41d6-ae38-1949c111d56e'
ROOT = 'https://winning-url-vault.45kikurage.workers.dev'
API = 'https://api.cloudflare.com/client/v4/'
STATE = Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir())) / 'vault-winning-order-private.json'
OUT = Path('winning-order-evidence.json')
STATIC_FILES = ['index.html', 'styles.css', 'app.js', 'sw.js', 'display-name.js',
                'winning-view.js', 'winning-folders.js', 'provisional-ui.js',
                'analysis-amount.js', 'assignment-prediction.js', 'device-login.js',
                'network-read.js', 'share.html', 'share.js',
                'manifest.json', 'manifest.webmanifest']

def require(ok, code):
    if not ok:
        raise RuntimeError(code)

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def call(path, body=None, raw=False):
    req = urllib.request.Request(API + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'],
                 'Content-Type': 'application/json',
                 'User-Agent': 'ARUNO-Winning-Order-Release'})
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            data = response.read(40 * 1024 * 1024)
            ctype = response.headers.get('content-type', '')
    except urllib.error.HTTPError as error:
        raise RuntimeError('CF_HTTP_' + str(error.code)) from None
    if raw:
        return data, ctype
    payload = json.loads(data)
    require(payload.get('success') is True, 'CF_REQUEST_FAILED')
    return payload['result']

def endpoint(suffix=''):
    return f'accounts/{ACCOUNT}/workers/scripts/{WORKER}' + suffix

def get_settings():
    return call(endpoint('/settings'))

def active():
    deployments = call(endpoint('/deployments'))['deployments']
    require(bool(deployments), 'NO_DEPLOYMENTS')
    versions = deployments[0]['versions']
    require(len(versions) == 1 and versions[0]['percentage'] == 100, 'SPLIT_DEPLOYMENT')
    return versions[0]['version_id']

def runtime(settings):
    result = {k: v for k, v in settings.items()
              if k not in ('annotations', 'assets', 'main_module', 'etag', 'modified_on', 'created_on')}
    if 'bindings' in result:
        result['bindings'] = sorted(result['bindings'], key=lambda b: b['name'])
    return result

def db_id(settings):
    database = next((b for b in settings.get('bindings', []) if b['name'] == 'DB'), None)
    require(database is not None, 'DATABASE_BINDING_MISSING')
    return database.get('id') or database.get('database_id')

def schedules():
    data = call(endpoint('/schedules'))
    return sorted(row['cron'] for row in (data if isinstance(data, list) else data.get('schedules', [])))

def schema(db):
    r = call(f'accounts/{ACCOUNT}/d1/database/{db}/query',
             {'sql': "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"})
    require(all(x.get('success') for x in r), 'D1_QUERY_FAILED')
    return r[0].get('results', [])

def code_hashes():
    data, mime = call(endpoint(), raw=True)
    if mime.startswith('multipart/'):
        msg = BytesParser(policy=policy.default).parsebytes(
            ('Content-Type: ' + mime + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + data)
        parts = [p.get_payload(decode=True) for p in msg.walk()
                 if not p.is_multipart()
                 and (p.get_filename() or p.get_param('name', header='content-disposition')) not in ('metadata', 'metadata.json')]
    else:
        parts = [data]
    return [hashlib.sha256(p).hexdigest() for p in parts]

def public(path):
    req = urllib.request.Request(ROOT + path, headers={'User-Agent': 'ARUNO-Winning-Order-Release', 'Cache-Control': 'no-cache'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def write(report):
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

def load_wrangler_config():
    text = Path('wrangler.jsonc').read_text()
    text = re.sub(r'//[^\n]*', '', text)
    text = re.sub(r',(\s*[}\]])', r'\1', text)
    return json.loads(text)

def deployment_config(settings, subdomain):
    config = load_wrangler_config()
    require(settings.get('compatibility_date') == config['compatibility_date'], 'COMPATIBILITY_DATE_MISMATCH')
    for key in ('compatibility_flags', 'observability', 'limits', 'logpush', 'tail_consumers'):
        if key in settings and settings[key] is not None:
            config[key] = settings[key]
    placement = settings.get('placement') or {}
    if placement.get('mode'):
        config['placement'] = placement
    config.pop('vars', None)
    config['workers_dev'] = subdomain['enabled']
    config['preview_urls'] = subdomain.get('previews_enabled', False)
    return config

def preflight():
    require(active() == BASE, 'UNEXPECTED_PRODUCTION_VERSION')
    settings = get_settings()
    db = db_id(settings)
    subdomain = call(endpoint('/subdomain'))
    Path('.release-wrangler.json').write_text(json.dumps(deployment_config(settings, subdomain)))
    status, served = public('/winning-view.js')
    require(status == 200, 'LIVE_WINNING_VIEW_UNREACHABLE')
    require(b'recommendedRank' in served and b'campaignDate' not in served, 'LIVE_ORDER_SOURCE_NOT_PRE_RELEASE')
    before_schema = schema(db)
    state = {'settings': runtime(settings), 'before_schema': before_schema,
             'schedules': schedules(), 'subdomain': subdomain, 'base_version': BASE, 'db': db}
    STATE.write_text(json.dumps(state))
    STATE.chmod(0o600)
    write({'source_sha': os.environ['GITHUB_SHA'], 'base_version': BASE,
           'live_order_source_confirmed': 'pre_release', 'before_code_sha256': code_hashes(),
           'stage': 'preflight_passed', 'before_schema_sha256': digest(before_schema),
           'real_device_test': 'pending'})
    print('Preflight passed; original runtime snapshot retained privately.')

def verify():
    state = json.loads(STATE.read_text())
    settings = get_settings()
    require(runtime(settings) == state['settings'], 'RUNTIME_SETTINGS_CHANGED')
    require(schedules() == state['schedules'], 'CRON_CHANGED')
    require(call(endpoint('/subdomain')) == state['subdomain'], 'PUBLICATION_SCOPE_CHANGED')
    require(schema(state['db']) == state['before_schema'], 'EXISTING_SCHEMA_CHANGED')
    version = active()
    require(version != BASE, 'VERSION_NOT_UPDATED')
    hashes = code_hashes()
    require(len(hashes) == 1, 'UNEXPECTED_MODULE_COUNT')
    expected = hashlib.sha256(Path('release-bundle/index.js').read_bytes()).hexdigest()
    require(hashes == [expected], 'DOWNLOADED_WORKER_DIFFERS_FROM_BUILD')
    for name in STATIC_FILES:
        status, served = public('/' + name)
        require(status == 200, 'STATIC_NOT_SERVED_' + name)
        require(served == Path('public', name).read_bytes(), 'STATIC_DIFFERS_' + name)
    status, served = public('/winning-view.js')
    require(b'campaignDate' in served and b'recommendedRank' not in served, 'NEW_ORDER_NOT_LIVE')
    write({'source_sha': os.environ['GITHUB_SHA'], 'base_version': BASE, 'new_version': version,
           'stage': 'verified', 'after_code_sha256': hashes, 'real_device_test': 'pending'})
    print('Verify passed; production bytes match the reviewed build.')

if __name__ == '__main__':
    require(len(sys.argv) == 2 and sys.argv[1] in ('preflight', 'verify'), 'USAGE')
    {'preflight': preflight, 'verify': verify}[sys.argv[1]]()
