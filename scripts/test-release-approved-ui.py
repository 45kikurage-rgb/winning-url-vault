import importlib.util,unittest
spec=importlib.util.spec_from_file_location('release','scripts/release-approved-ui.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class ReleaseGuard(unittest.TestCase):
    def test_empty_api_placement_is_not_an_invalid_wrangler_placement(self):
        config=r.deployment_config({'compatibility_date':'2026-09-22','placement':{},'usage_model':'standard','observability':{'enabled':True}},{'enabled':True,'previews_enabled':False})
        self.assertNotIn('placement',config)
        self.assertNotIn('usage_model',config)
        self.assertNotIn('vars',config)
        self.assertEqual(config['observability'],{'enabled':True})
        self.assertIs(config['workers_dev'],True)
        self.assertIs(config['preview_urls'],False)
    def test_unknown_live_version_stops_before_api_or_database(self):
        old_active,old_call=r.active,r.call
        try:
            r.active=lambda:'another-version'
            r.call=lambda *args,**kwargs:self.fail('Unexpected cloud operation')
            with self.assertRaisesRegex(RuntimeError,'UNEXPECTED_PRODUCTION_VERSION'):r.preflight()
        finally:r.active,r.call=old_active,old_call
    def test_runtime_comparison_keeps_secrets_bindings_and_config_sensitive(self):
        a={'bindings':[{'name':'DB','id':'a'},{'name':'SECRET','type':'secret_text'}],'compatibility_date':'2026-09-22','annotations':{'message':'old'}}
        b={'bindings':list(reversed(a['bindings'])),'compatibility_date':a['compatibility_date'],'annotations':{'message':'new'}}
        self.assertEqual(r.runtime(a),r.runtime(b))
        b['bindings']=[{'name':'DB','id':'different'},{'name':'SECRET','type':'secret_text'}]
        self.assertNotEqual(r.runtime(a),r.runtime(b))
        b['bindings']=a['bindings'];b['compatibility_date']='different'
        self.assertNotEqual(r.runtime(a),r.runtime(b))
if __name__=='__main__':unittest.main()
