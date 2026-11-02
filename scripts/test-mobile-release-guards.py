import copy, importlib.util, sqlite3, unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', 'scripts/release-mobile-reliability.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

def schema(db):
    db.row_factory = sqlite3.Row
    return [dict(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]

class ReleaseGuard(unittest.TestCase):
    def test_unknown_version_stops_before_other_access(self):
        with patch.object(r.g,'active',return_value='other-version'), patch.object(r.g,'code_hashes',side_effect=AssertionError('Unexpected read')):
            with self.assertRaisesRegex(RuntimeError,'UNEXPECTED_PRODUCTION_VERSION'): r.preflight()

    def test_unknown_code_stops_before_settings_or_db(self):
        with patch.object(r.g,'active',return_value=r.BASE_VERSION), patch.object(r.g,'code_hashes',return_value=(['unexpected'],b'')), patch.object(r.g,'get_settings',side_effect=AssertionError('Unexpected read')):
            with self.assertRaisesRegex(RuntimeError,'UNEXPECTED_PRODUCTION_WORKER'): r.preflight()

    def test_additive_schema_and_only_it_is_accepted(self):
        db=sqlite3.connect(':memory:')
        db.executescript('CREATE TABLE cards(id TEXT PRIMARY KEY); CREATE TABLE items(id TEXT PRIMARY KEY, value TEXT NOT NULL);')
        before=schema(db)
        db.executescript(r.migration_sql())
        r.validate_added_schema(before,schema(db))
        db.executescript('ALTER TABLE items ADD COLUMN unexpected TEXT;')
        with self.assertRaisesRegex(RuntimeError,'EXISTING_SCHEMA_CHANGED'): r.validate_added_schema(before,schema(db))

    def test_existing_bad_receipt_table_fails(self):
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE cards(id TEXT PRIMARY KEY)')
        before=schema(db)
        db.executescript('CREATE TABLE vault_single_wins(request_id TEXT);')
        with self.assertRaisesRegex(RuntimeError,'SINGLE_WIN_SCHEMA_MISMATCH'): r.validate_added_schema(before,schema(db))

    def test_destructive_sql_is_rejected(self):
        good=r.migration_sql()
        for bad in [good+'DELETE FROM items;', good.replace('CREATE INDEX','DROP INDEX'), good.replace('DEFAULT 0','DEFAULT 0 /* UPDATE items */')]:
            with patch.object(r.Path,'read_text',return_value=bad):
                with self.assertRaises(RuntimeError): r.migration_sql()

    def test_only_default_service_environment_is_normalized(self):
        before={'bindings':[{'name':'DB','type':'d1','id':'original'}, {'name':'SECRET','type':'secret_text'}, dict(r.BINDING)], 'compatibility_date':'2026-09-22'}
        after=copy.deepcopy(before);after['bindings'][-1]['environment']='production'
        self.assertEqual(r.normalized_runtime(copy.deepcopy(before)),r.normalized_runtime(copy.deepcopy(after)))
        after['bindings'][-1]['environment']='staging'
        self.assertNotEqual(r.normalized_runtime(copy.deepcopy(before)),r.normalized_runtime(copy.deepcopy(after)))
        after=copy.deepcopy(before);after['bindings'][0]['id']='other'
        self.assertNotEqual(r.normalized_runtime(copy.deepcopy(before)),r.normalized_runtime(copy.deepcopy(after)))

    def test_new_receipt_schema_replay_is_idempotent(self):
        db=sqlite3.connect(':memory:');db.execute('CREATE TABLE cards(id TEXT PRIMARY KEY)')
        db.executescript(r.migration_sql());before=schema(db)
        db.executescript(r.migration_sql());r.validate_added_schema(before,schema(db))

    def test_config_accepts_only_named_service_addition(self):
        before={'services':[],'queues':{'consumers':[{'max_concurrency':3}]},'d1_databases':[{'database_id':'existing'}]}
        after=copy.deepcopy(before);after['services'].append({'binding':'ALIGN_SINGLE_WIN','service':'arunomatic-align','entrypoint':'VaultCampaignAPI'})
        r.validate_config_delta(before,after)
        after['queues']['consumers'][0]['max_concurrency']=4
        with self.assertRaisesRegex(RuntimeError,'UNREVIEWED_CONFIGURATION_CHANGE'): r.validate_config_delta(before,after)

    def test_rollback_never_overwrites_different_code(self):
        state='{"baseline":"original"}'
        with patch.object(r.Path,'read_text',return_value=state), patch.object(r.Path,'read_bytes',return_value=b'candidate'), patch.object(r.g,'active',return_value='concurrent'), patch.object(r.g,'code_hashes',return_value=(['different'],b'')), patch.object(r.g,'call',side_effect=AssertionError('Unexpected mutation')):
            with self.assertRaisesRegex(RuntimeError,'ROLLBACK_REFUSED_CONCURRENT_CODE_CHANGE'): r.rollback()

if __name__=='__main__': unittest.main()
