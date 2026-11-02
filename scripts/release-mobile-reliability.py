"""Typed Vault release: additive receipt table and one named Align binding only.

Existing URL rows, auth, queues, cron and other services are not mutated here.
Private runtime settings are confined to runner temp and never uploaded.
"""
import hashlib, importlib.util, json, os, re, sqlite3, subprocess, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('vault_guards', Path(__file__).with_name('release-provisional-controls.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
g.STATE = g.STATE.with_name('vault-mobile-reliability-private.json')
g.OUT = Path('mobile-reliability-release-evidence.json')
BASE_SOURCE = '4bc220e63361f140777c1ed7ea27e3271155c30c'
BASE_VERSION = '7252cd40-9bc0-492b-9fb9-76812b886b97'
BASE_WORKER = '16e33692511f3030f73f5259c1d26269bf8c2a33618ace64454d05a7c088b492'
MIGRATION = '0015_single_wins.sql'
TABLE = 'vault_single_wins'
BINDING = {'name':'ALIGN_SINGLE_WIN', 'type':'service', 'service':'arunomatic-align', 'entrypoint':'VaultCampaignAPI'}
ASSETS = ['index.html','styles.css','app.js','sw.js','display-name.js','single-win-ui.js']

def normalized_runtime(settings):
    result = g.runtime(settings)
    for binding in result.get('bindings', []):
        if binding.get('type') == 'service' and binding.get('environment') == 'production':
            binding.pop('environment', None)
    return result

def existing_schema(rows):
    return [r for r in rows if r['tbl_name'] != TABLE]

def validate_config_delta(before, candidate):
    expected = json.loads(json.dumps(before))
    expected['services'].append({'binding':'ALIGN_SINGLE_WIN','service':'arunomatic-align','entrypoint':'VaultCampaignAPI'})
    g.require(expected == candidate, 'UNREVIEWED_CONFIGURATION_CHANGE')

def queue_state(config):
    queues = []
    for name in sorted({c['queue'] for c in config['queues']['consumers']}):
        found = g.call(f'accounts/{g.ACCOUNT}/queues?page=1&name='+name)
        matches = [q for q in found if q.get('queue_name') == name]
        g.require(len(matches) == 1, 'QUEUE_IDENTITY_NOT_UNIQUE')
        queue = matches[0]
        consumers = [{k:c.get(k) for k in ('consumer_id','type','script','service','environment','settings','dead_letter_queue')}
                     for c in queue.get('consumers', [])]
        queues.append({'queue_name':name, 'queue_id':queue['queue_id'],
                       'consumers':sorted(consumers,key=lambda c:c['consumer_id'])})
    return queues

def validate_live_targets(config, settings, queues):
    rows = settings['bindings']; bindings = {b['name']:b for b in rows}
    g.require(len(rows) == len(bindings), 'DUPLICATE_RUNTIME_BINDING')
    for service in config['services']:
        if service['binding'] == 'ALIGN_SINGLE_WIN':
            g.require('ALIGN_SINGLE_WIN' not in bindings, 'SINGLE_WIN_ALREADY_BOUND')
            continue
        live = bindings.get(service['binding'], {})
        g.require(live.get('type') == 'service' and live.get('service') == service['service']
                  and live.get('entrypoint') == service.get('entrypoint')
                  and live.get('environment') in (None, 'production'), 'LIVE_SERVICE_TARGET_CHANGED')
    for key, kind in [('ai','ai'), ('assets','assets')]:
        g.require(bindings.get(config[key]['binding'], {}).get('type') == kind, 'LIVE_BINDING_TYPE_CHANGED')
    for db in config['d1_databases']:
        live = bindings.get(db['binding'], {})
        g.require(live.get('type') == 'd1' and (live.get('id') or live.get('database_id')) == db['database_id'], 'LIVE_DATABASE_TARGET_CHANGED')
    by_name = {q['queue_name']:q for q in queues}
    for producer in config['queues']['producers']:
        live = bindings.get(producer['binding'], {}); queue = by_name.get(producer['queue'], {})
        g.require(live.get('type') == 'queue' and queue, 'LIVE_QUEUE_TARGET_CHANGED')
        g.require((live.get('queue_name') == producer['queue']) or
                  (live.get('queue_name') is None and live.get('queue_id') == queue.get('queue_id')), 'LIVE_QUEUE_TARGET_CHANGED')
        g.require(live.get('queue_id') in (None, queue.get('queue_id')), 'LIVE_QUEUE_ID_CHANGED')
        g.require(live.get('delivery_delay',0) == producer.get('delivery_delay',0), 'LIVE_QUEUE_DELAY_CHANGED')
    fields = {'max_batch_size':'batch_size','max_batch_timeout':'max_wait_time_ms',
              'max_retries':'max_retries','max_concurrency':'max_concurrency'}
    for consumer in config['queues']['consumers']:
        queue = by_name.get(consumer['queue'], {})
        matches = [c for c in queue.get('consumers', []) if (c.get('script') or c.get('service')) == g.WORKER]
        g.require(len(matches) == 1, 'LIVE_QUEUE_CONSUMER_CHANGED')
        live = matches[0]
        g.require(live.get('type') == 'worker' and live.get('environment') in (None, 'production'), 'LIVE_QUEUE_CONSUMER_CHANGED')
        for option, field in fields.items():
            expected = consumer[option] * (1000 if option == 'max_batch_timeout' else 1)
            g.require(live.get('settings', {}).get(field) == expected, 'LIVE_QUEUE_CONSUMER_SETTINGS_CHANGED')
        g.require(live.get('dead_letter_queue') == consumer.get('dead_letter_queue') and
                  live.get('settings', {}).get('retry_delay',0) == consumer.get('retry_delay',0), 'LIVE_QUEUE_RETRY_SETTINGS_CHANGED')

def migration_sql():
    text = Path('migrations', MIGRATION).read_text()
    statements = [s.strip() for s in text.split(';') if s.strip()]
    g.require(len(statements) == 3, 'MIGRATION_STATEMENT_COUNT')
    g.require(statements[0].startswith('CREATE TABLE IF NOT EXISTS vault_single_wins ('), 'MIGRATION_TABLE_SCOPE')
    g.require(statements[1].startswith('CREATE INDEX IF NOT EXISTS idx_single_wins_card ON vault_single_wins('), 'MIGRATION_INDEX_SCOPE')
    g.require(statements[2] == 'CREATE UNIQUE INDEX IF NOT EXISTS idx_single_wins_snapshot ON vault_single_wins(snapshot_key) WHERE invalidated_at IS NULL', 'MIGRATION_SNAPSHOT_INDEX_SCOPE')
    g.require(not re.search(r'\b(?:DROP|ALTER|INSERT|UPDATE|DELETE|REPLACE|ATTACH)\b', text.replace('ON DELETE RESTRICT', ''), re.I), 'MIGRATION_MUTATION_SCOPE')
    return text

def validate_added_schema(before, after):
    g.require(existing_schema(before) == existing_schema(after), 'EXISTING_SCHEMA_CHANGED')
    db = sqlite3.connect(':memory:')
    # Replay existing schema and the exact additive DDL independently. No live
    # URL content is copied, and this is not represented as a full data restore.
    for row in existing_schema(before):
        if row['type'] == 'table' and row['sql']:
            db.execute(row['sql'])
    db.executescript(migration_sql())
    expected = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_%' ORDER BY type,name", (TABLE,)).fetchall()
    actual = [tuple(row[k] for k in ('type','name','tbl_name','sql')) for row in after if row['tbl_name'] == TABLE]
    def canonical(rows):
        return [(a,b,c,re.sub(r'\s+',' ',d or '').replace('IF NOT EXISTS ','')) for a,b,c,d in rows]
    g.require(canonical(expected) == canonical(actual), 'SINGLE_WIN_SCHEMA_MISMATCH')
    g.require(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'ADDITIVE_SCHEMA_CHECK_FAILED')
    db.close()

def preflight():
    g.require(g.active() == BASE_VERSION, 'UNEXPECTED_PRODUCTION_VERSION')
    hashes, _ = g.code_hashes()
    g.require(hashes == [BASE_WORKER], 'UNEXPECTED_PRODUCTION_WORKER')
    settings = g.get_settings()
    known = {'AI','ASSETS','COUPON_ANALYZER','LEDGER_READER','LEDGER_VAULT','DB','ANALYSIS_QUEUE'}
    g.require(all(b['type'] in ('secret_text','plain_text','json') or b['name'] in known for b in settings['bindings']), 'UNEXPECTED_BINDING')
    db = next((b for b in settings['bindings'] if b['name']=='DB'), {})
    g.require((db.get('id') or db.get('database_id')) == g.DB, 'DATABASE_MISMATCH')
    for name in ['index.html','app.js','styles.css','sw.js']:
        expected = subprocess.check_output(['git','show',f'{BASE_SOURCE}:public/{name}'])
        status, actual = g.public('/'+name+'?preflight='+os.environ['GITHUB_SHA'])
        g.require(status == 200 and expected == actual, 'UNEXPECTED_ASSET_'+name)
    subdomain = g.call(g.endpoint('/subdomain'))
    before_schema = g.schema()
    recovery = g.call(f'accounts/{g.ACCOUNT}/d1/database/{g.DB}/time_travel/bookmark')
    g.require(isinstance(recovery.get('bookmark'),str) and recovery['bookmark'], 'RECOVERY_BOOKMARK_MISSING')
    state = {'settings':normalized_runtime(settings), 'schema':before_schema, 'schedules':g.schedules(),
             'subdomain':subdomain, 'baseline':BASE_VERSION, 'recovery':recovery}
    g.STATE.write_text(json.dumps(state)); g.STATE.chmod(0o600)
    config = g.deployment_config(settings, subdomain)
    baseline_config = json.loads(subprocess.check_output(['git','show',f'{BASE_SOURCE}:wrangler.jsonc']))
    validate_config_delta(baseline_config, json.loads(Path('wrangler.jsonc').read_text()))
    queues = queue_state(config)
    validate_live_targets(config, settings, queues)
    g.require(sorted(config['triggers']['crons']) == state['schedules'], 'LIVE_CRON_CONFIGURATION_CHANGED')
    state['queues'] = queues
    g.STATE.write_text(json.dumps(state)); g.STATE.chmod(0o600)
    expected_service = {'binding':'ALIGN_SINGLE_WIN','service':'arunomatic-align','entrypoint':'VaultCampaignAPI'}
    g.require([b for b in config['services'] if b['binding']=='ALIGN_SINGLE_WIN'] == [expected_service], 'CANDIDATE_BINDING_MISMATCH')
    Path('.release-wrangler.json').write_text(json.dumps(config))
    migration_sql()
    g.write({'source_sha':os.environ['GITHUB_SHA'], 'stage':'preflight_passed', 'baseline':BASE_VERSION,
             'baseline_source':BASE_SOURCE, 'time_travel_bookmark':recovery['bookmark'],
             'business_row_mutations':0, 'real_device_test':'pending'})
    print('Pinned production baseline and recovery bookmark confirmed; no production mutations.')

def migrate():
    state = json.loads(g.STATE.read_text())
    g.require(g.active() == state['baseline'], 'PRODUCTION_MOVED')
    g.require(normalized_runtime(g.get_settings()) == state['settings'], 'RUNTIME_MOVED')
    g.require(g.schedules() == state['schedules'], 'SCHEDULE_MOVED')
    g.require(g.call(g.endpoint('/subdomain')) == state['subdomain'], 'PUBLICATION_SCOPE_MOVED')
    g.require(queue_state(json.loads(Path('wrangler.jsonc').read_text())) == state['queues'], 'QUEUE_CONFIGURATION_MOVED')
    g.require(existing_schema(g.schema()) == existing_schema(state['schema']), 'SCHEMA_MOVED')
    # Apply this exact file only, never all historical migrations.
    migration_sql()
    subprocess.run(['npx','wrangler','d1','execute','winning-url-vault','--remote','--file=migrations/'+MIGRATION], check=True)
    validate_added_schema(state['schema'], g.schema())
    g.db_query("INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0015_single_wins.sql')")
    report = json.loads(g.OUT.read_text())
    report.update(stage='additive_schema_ready', existing_schema_preserved=True,
                  additive_schema_replay=True, migration=MIGRATION)
    g.write(report)
    print('Only the reviewed receipt table/index and migration receipt were added. Existing tables preserved.')

def verify():
    state = json.loads(g.STATE.read_text())
    expected = state['settings']
    expected['bindings'].append(BINDING)
    expected['bindings'].sort(key=lambda b:b['name'])
    g.require(normalized_runtime(g.get_settings()) == expected, 'RUNTIME_SETTINGS_CHANGED')
    g.require(g.schedules() == state['schedules'], 'SCHEDULE_CHANGED')
    g.require(queue_state(json.loads(Path('wrangler.jsonc').read_text())) == state['queues'], 'QUEUE_CONFIGURATION_CHANGED')
    g.require(g.call(g.endpoint('/subdomain')) == state['subdomain'], 'PUBLICATION_SCOPE_CHANGED')
    validate_added_schema(state['schema'], g.schema())
    version = g.active(); g.require(version != state['baseline'], 'VERSION_NOT_UPDATED')
    hashes, _ = g.code_hashes()
    expected_hash = hashlib.sha256(Path('release-bundle/index.js').read_bytes()).hexdigest()
    g.require(hashes == [expected_hash], 'LIVE_WORKER_DIFFERS_FROM_BUILD')
    asset_hashes = {}
    for name in ASSETS:
        status, data = g.public('/'+name+'?release='+os.environ['GITHUB_SHA'])
        g.require(status == 200 and data == Path('public',name).read_bytes(), 'LIVE_ASSET_MISMATCH_'+name)
        asset_hashes[name] = hashlib.sha256(data).hexdigest()
    status, raw = g.public('/api/auth/status'); auth = json.loads(raw)
    g.require(status == 200 and auth.get('authenticated') is False and auth.get('deviceOnlyMode') is True and auth.get('mode') == 'production', 'AUTH_STATE_CHANGED')
    for path in ['/api/cards?intake_source=arunomatic','/api/cards?intake_source=chiritumo',
                 '/api/single-wins/availability','/api/cards/00000000-0000-0000-0000-000000000000/single-win-preview',
                 '/api/single-wins/00000000-0000-0000-0000-000000000000']:
        g.require(g.public(path)[0] == 401, 'ANONYMOUS_MANAGEMENT_GUARD_FAILED')
    report = json.loads(g.OUT.read_text())
    report.update(stage='published_verified', deployed_version=version, worker_sha256=expected_hash,
                  assets=asset_hashes, existing_runtime_preserved=True, added_binding=BINDING,
                  anonymous_guards_passed=True, existing_schema_preserved=True, business_row_mutations=0)
    g.write(report)
    print('Production bytes, authentication, additive schema and exact service binding verified.')

def rollback():
    state = json.loads(g.STATE.read_text())
    if g.active() == state['baseline']:
        print('Original version remains active; no rollback needed.')
        return
    expected_hash = hashlib.sha256(Path('release-bundle/index.js').read_bytes()).hexdigest()
    hashes, _ = g.code_hashes()
    g.require(hashes == [expected_hash], 'ROLLBACK_REFUSED_CONCURRENT_CODE_CHANGE')
    g.require(g.schedules() == state['schedules'], 'ROLLBACK_REFUSED_CONCURRENT_SCHEDULE_CHANGE')
    expected = json.loads(json.dumps(state['settings']))
    expected['bindings'].append(BINDING); expected['bindings'].sort(key=lambda b:b['name'])
    g.require(normalized_runtime(g.get_settings()) == expected, 'ROLLBACK_REFUSED_CONCURRENT_RUNTIME_CHANGE')
    g.require(g.call(g.endpoint('/subdomain')) == state['subdomain'], 'ROLLBACK_REFUSED_CONCURRENT_PUBLICATION_CHANGE')
    g.require(queue_state(json.loads(Path('wrangler.jsonc').read_text())) == state['queues'], 'ROLLBACK_REFUSED_CONCURRENT_QUEUE_CHANGE')
    # Same API used by the pinned Wrangler rollback implementation. Never use
    # force: a changed secret or non-deployable version must stop this action.
    g.call(g.endpoint('/deployments'), {'strategy':'percentage',
           'versions':[{'version_id':state['baseline'],'percentage':100}],
           'annotations':{'workers/message':'Restore previous version after mobile release verification failure'}})
    g.require(g.active() == state['baseline'], 'ROLLBACK_VERSION_NOT_ACTIVE')
    g.require(normalized_runtime(g.get_settings()) == state['settings'], 'ROLLBACK_RUNTIME_MISMATCH')
    g.require(g.code_hashes()[0] == [BASE_WORKER], 'ROLLBACK_WORKER_MISMATCH')
    report = json.loads(g.OUT.read_text())
    report.update(stage='rolled_back_after_verification_failure', rollback_version=state['baseline'],
                  additive_table_retained=True, business_row_mutations=0)
    g.write(report)
    print('Previous Worker version restored. Receipt table retained; business data were not restored or deleted.')

if __name__ == '__main__':
    try:
        {'preflight':preflight,'migrate':migrate,'verify':verify,'rollback':rollback}[sys.argv[1]]()
    except Exception as error:
        print('Release stopped: '+(str(error) if isinstance(error,RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
