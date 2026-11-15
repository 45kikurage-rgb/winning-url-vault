"""Offline tests for the audit release's fail-closed production checks."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('audit_release', 'scripts/release-full-recopy.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
CONFIG = json.loads(Path('wrangler.jsonc').read_text())

def fixtures():
    bindings = [{'name':s['binding'], 'type':'service', 'service':s['service'],
                 'entrypoint':s.get('entrypoint')} for s in CONFIG['services']]
    bindings += [{'name':'AI','type':'ai'}, {'name':'ASSETS','type':'assets'},
                 {'name':'DB','type':'d1','id':r.g.DB},
                 {'name':'ANALYSIS_QUEUE','type':'queue','queue_name':'winning-url-analysis','queue_id':'queue-id'}]
    queues = [{'queue_name':'winning-url-analysis','queue_id':'queue-id','consumers':[
        {'consumer_id':'consumer-id','type':'worker','script':r.g.WORKER,
         'settings':{'batch_size':1,'max_wait_time_ms':1000,'max_retries':3,'max_concurrency':3}}]}]
    return {'bindings':bindings}, queues

class AuditReleaseGuard(unittest.TestCase):
    def test_scope_excludes_workflows_configuration_and_database_changes(self):
        for name in r.ALLOWED:
            self.assertFalse(name.startswith(('.github/', 'migrations/')))
            self.assertNotIn(name, ('schema.sql', 'wrangler.jsonc', 'package-lock.json'))

    def test_unknown_live_worker_stops_before_settings_or_database_reads(self):
        def git(args, **kwargs):
            return 'src/index.js\n' if '--name-only' in args else Path('wrangler.jsonc').read_bytes()
        with patch.dict(os.environ, GITHUB_SHA='candidate'), patch.object(r.subprocess,'check_output',side_effect=git), \
             patch.object(r.g,'active',return_value='baseline'), patch.object(r.g,'code_hashes',return_value=(['unknown'],b'')), \
             patch.object(r.g,'get_settings',side_effect=AssertionError('Unexpected runtime access')):
            with self.assertRaisesRegex(RuntimeError,'UNEXPECTED_PRODUCTION_WORKER'):
                r.preflight()

    def test_existing_align_service_and_exact_queue_configuration_are_accepted(self):
        settings, queues = fixtures()
        r.validate_targets(CONFIG, settings, queues)

    def test_changed_service_target_or_entrypoint_is_rejected_before_deploy(self):
        for field, value in [('service','other-service'), ('entrypoint','OtherAPI'), ('environment','staging')]:
            settings, queues = fixtures()
            settings['bindings'][0][field] = value
            with self.assertRaisesRegex(RuntimeError,'LIVE_SERVICE_TARGET_CHANGED'):
                r.validate_targets(CONFIG, settings, queues)
        settings, queues = fixtures()
        next(b for b in settings['bindings'] if b['name']=='ALIGN_SINGLE_WIN')['service']='other-align'
        with self.assertRaisesRegex(RuntimeError,'LIVE_SERVICE_TARGET_CHANGED'):
            r.validate_targets(CONFIG, settings, queues)

    def test_changed_database_or_queue_is_rejected(self):
        settings, queues = fixtures()
        next(b for b in settings['bindings'] if b['name']=='DB')['id']='different'
        with self.assertRaisesRegex(RuntimeError,'LIVE_DATABASE_TARGET_CHANGED'):
            r.validate_targets(CONFIG, settings, queues)
        settings, queues = fixtures()
        queues[0]['consumers'][0]['settings']['max_concurrency']=4
        with self.assertRaisesRegex(RuntimeError,'LIVE_QUEUE_CONSUMER_SETTINGS_CHANGED'):
            r.validate_targets(CONFIG, settings, queues)

    def test_runtime_normalization_does_not_mutate_snapshot_or_hide_sensitive_changes(self):
        a={'bindings':[{'name':'READER','type':'service','service':'original','environment':'production'},
                       {'name':'SECRET','type':'secret_text'}], 'compatibility_date':'2026-09-22'}
        original=copy.deepcopy(a)
        b=copy.deepcopy(a);b['bindings'][0].pop('environment')
        self.assertEqual(r.runtime(a),r.runtime(b));self.assertEqual(a,original)
        b['bindings'][0]['service']='other'
        self.assertNotEqual(r.runtime(a),r.runtime(b))
        b=copy.deepcopy(a);b['bindings'][1]['name']='OTHER_SECRET'
        self.assertNotEqual(r.runtime(a),r.runtime(b))

    def test_all_published_files_are_verified_including_share_and_auth_modules(self):
        actual={str(p.relative_to('public')) for p in Path('public').rglob('*') if p.is_file()}
        self.assertEqual(set(r.ASSETS),actual)
        self.assertTrue({'device-login.js','network-read.js','share.html','share.js'} <= actual)

    def test_rollback_does_not_replace_a_concurrent_version_with_the_same_code(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)/'private.json';state.write_text(json.dumps({'version':'baseline'}))
            previous=os.getcwd()
            try:
                os.chdir(directory);Path('.audit-deployed-version').write_text('our-version')
                with patch.object(r.g,'STATE',state), patch.object(r.g,'active',return_value='other-version'), \
                     patch.object(r.g,'code_hashes',return_value=(['candidate'],b'')), \
                     patch.object(r,'expected_code_hash',return_value='candidate'), \
                     patch.object(r.g,'call',side_effect=AssertionError('Unexpected mutation')):
                    with self.assertRaisesRegex(RuntimeError,'ROLLBACK_REFUSED_CONCURRENT_VERSION'):
                        r.rollback()
            finally:
                os.chdir(previous)

if __name__ == '__main__':
    unittest.main()
