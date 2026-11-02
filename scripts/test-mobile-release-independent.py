"""Independent F gate: fail before overwriting live connection/runtime changes."""
import copy, hashlib, importlib.util, json, os, unittest
from pathlib import Path
from unittest.mock import patch

REPO=Path(__file__).resolve().parents[1]
os.chdir(REPO)
spec=importlib.util.spec_from_file_location('f_release_under_review',REPO/'scripts/release-mobile-reliability.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

def settings():
    config=json.loads((REPO/'wrangler.jsonc').read_text())
    bindings=[{'name':'AI','type':'ai'}, {'name':'ASSETS','type':'assets'},
        {'name':'DB','type':'d1','id':r.g.DB}, {'name':'ANALYSIS_QUEUE','type':'queue','queue_name':'winning-url-analysis','queue_id':'known-queue'},
        {'name':'SESSION_SECRET','type':'secret_text'}, {'name':'OPERATION_MODE','type':'plain_text','text':'production'}]
    bindings.extend({'name':service['binding'],'type':'service','service':service['service'],
                     **({'entrypoint':service['entrypoint']} if 'entrypoint' in service else {})}
                    for service in config['services'] if service['binding']!='ALIGN_SINGLE_WIN')
    return {'compatibility_date':config['compatibility_date'],'bindings':bindings,'observability':{'enabled':True}}

class IndependentVaultPublicationGate(unittest.TestCase):
    def test_changed_live_service_is_rejected_before_release_config_can_overwrite_it(self):
        live=settings();next(b for b in live['bindings'] if b['name']=='LEDGER_VAULT')['service']='externally-changed-ledger'
        config=json.loads((REPO/'wrangler.jsonc').read_text());config['services']=[s for s in config['services'] if s['binding']!='ALIGN_SINGLE_WIN']
        calls=[]
        def safe_call(path,body=None,**kwargs):
            self.assertIsNone(body,'preflight must remain read-only');calls.append(path)
            if path.endswith('/subdomain'):return {'enabled':True,'previews_enabled':False}
            if path.endswith('/time_travel/bookmark'):return {'bookmark':'safe-checkpoint'}
            if '/queues?' in path:return [{'queue_name':'winning-url-analysis','queue_id':'known-queue','consumers':[]}]
            raise AssertionError('unexpected API route')
        def git_read(args):return json.dumps(config).encode() if args[-1].endswith(':wrangler.jsonc') else b'baseline asset'
        with patch.dict(os.environ,{'GITHUB_SHA':'a'*40}), patch.object(r.g,'active',return_value=r.BASE_VERSION), \
             patch.object(r.g,'code_hashes',return_value=([r.BASE_WORKER],b'baseline')), patch.object(r.g,'get_settings',return_value=live), \
             patch.object(r.g,'public',return_value=(200,b'baseline asset')), patch.object(r.g,'schema',return_value=[]), \
             patch.object(r.g,'schedules',return_value=['*/1 * * * *']),patch.object(r.g,'call',side_effect=safe_call), \
             patch.object(r.subprocess,'check_output',side_effect=git_read),patch.object(r.Path,'chmod'),patch.object(r.Path,'write_text',autospec=True) as write:
            with self.assertRaises(RuntimeError):r.preflight()
            self.assertFalse(any(call.args[0].name=='.release-wrangler.json' for call in write.call_args_list),'connection mismatch must be caught before saving publishable config')

    def test_live_contract_accepts_only_original_service_database_queue_and_consumer_values(self):
        config=json.loads((REPO/'wrangler.jsonc').read_text());live=settings()
        queues=[{'queue_name':'winning-url-analysis','queue_id':'known-queue','consumers':[{'consumer_id':'existing-consumer','type':'worker','script':r.g.WORKER,
                 'service':None,'environment':'production','settings':{'batch_size':1,'max_wait_time_ms':1000,'max_retries':3,'max_concurrency':3},'dead_letter_queue':None}]}]
        r.validate_live_targets(config,live,queues)
        for case in ['service','database','queue','queue-id','queue-delay','batch','concurrency','consumer']:
            with self.subTest(case=case):
                changed=copy.deepcopy(live);queue=copy.deepcopy(queues)
                if case=='service':next(b for b in changed['bindings'] if b['name']=='COUPON_ANALYZER')['service']='different'
                if case=='database':next(b for b in changed['bindings'] if b['name']=='DB')['id']='different'
                if case=='queue':next(b for b in changed['bindings'] if b['name']=='ANALYSIS_QUEUE')['queue_name']='different'
                if case=='queue-id':next(b for b in changed['bindings'] if b['name']=='ANALYSIS_QUEUE')['queue_id']='different'
                if case=='queue-delay':next(b for b in changed['bindings'] if b['name']=='ANALYSIS_QUEUE')['delivery_delay']=100
                if case=='batch':queue[0]['consumers'][0]['settings']['batch_size']=10
                if case=='concurrency':queue[0]['consumers'][0]['settings']['max_concurrency']=4
                if case=='consumer':queue[0]['consumers'][0]['script']='some-other-worker'
                with self.assertRaises(RuntimeError):r.validate_live_targets(config,changed,queue)

    def test_migration_stops_if_cron_or_publication_scope_changes_after_preflight(self):
        before=r.normalized_runtime(settings());state={'baseline':r.BASE_VERSION,'settings':before,'schedules':['*/1 * * * *'],
            'subdomain':{'enabled':True,'previews_enabled':False},'schema':[],'queues':[]}
        for case in ['cron','subdomain']:
            with self.subTest(case=case):
                with patch.object(r.Path,'read_text',return_value=json.dumps(state)),patch.object(r.g,'active',return_value=r.BASE_VERSION), \
                     patch.object(r.g,'get_settings',return_value=copy.deepcopy(before)), \
                     patch.object(r.g,'schedules',return_value=['0 * * * *'] if case=='cron' else state['schedules']), \
                     patch.object(r.g,'call',return_value={'enabled':False,'previews_enabled':False}), \
                     patch.object(r.subprocess,'run',side_effect=AssertionError('Unexpected production migration')):
                    with self.assertRaises(RuntimeError):r.migrate()

    def test_rollback_refuses_same_code_with_concurrent_runtime_change(self):
        before=r.normalized_runtime(settings());current=copy.deepcopy(before);current['bindings'].append(dict(r.BINDING))
        next(b for b in current['bindings'] if b['name']=='OPERATION_MODE')['text']='concurrent-mode'
        state={'baseline':'original','settings':before,'schedules':['*/1 * * * *'],'subdomain':{'enabled':True,'previews_enabled':False}}
        def api(path,body=None,**kwargs):
            self.assertIsNone(body,'rollback must not overwrite concurrent runtime changes')
            return state['subdomain']
        with patch.object(r.Path,'read_text',return_value=json.dumps(state)),patch.object(r.Path,'read_bytes',return_value=b'candidate'), \
             patch.object(r.g,'active',return_value='candidate'),patch.object(r.g,'code_hashes',return_value=([hashlib.sha256(b'candidate').hexdigest()],b'')), \
             patch.object(r.g,'schedules',return_value=state['schedules']),patch.object(r.g,'get_settings',return_value=current),patch.object(r.g,'call',side_effect=api):
            with self.assertRaises(RuntimeError):r.rollback()

    def test_rollback_refuses_concurrent_workers_dev_change(self):
        before=r.normalized_runtime(settings());current=copy.deepcopy(before);current['bindings'].append(dict(r.BINDING))
        current['bindings'].sort(key=lambda b:b['name'])
        state={'baseline':'original','settings':before,'schedules':['*/1 * * * *'],'subdomain':{'enabled':True,'previews_enabled':False}}
        def api(path,body=None,**kwargs):
            self.assertIsNone(body,'rollback must not overwrite a changed publication scope')
            return {'enabled':False,'previews_enabled':False}
        with patch.object(r.Path,'read_text',return_value=json.dumps(state)),patch.object(r.Path,'read_bytes',return_value=b'candidate'), \
             patch.object(r.g,'active',return_value='candidate'),patch.object(r.g,'code_hashes',return_value=([hashlib.sha256(b'candidate').hexdigest()],b'')), \
             patch.object(r.g,'schedules',return_value=state['schedules']),patch.object(r.g,'get_settings',return_value=current),patch.object(r.g,'call',side_effect=api):
            with self.assertRaises(RuntimeError):r.rollback()

if __name__=='__main__':unittest.main()
