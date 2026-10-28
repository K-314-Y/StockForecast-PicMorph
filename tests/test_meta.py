"""Sprint 9: all current allowlisted capabilities and the manual share one endpoint."""
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import urlopen

from app import Handler
from engine import PLUGIN_INFO
from challenge import public_scenarios


class MetaTests(unittest.TestCase):
    def test_live_meta_contains_manual_registry_and_scenarios(self):
        srv=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        runner=threading.Thread(target=srv.serve_forever,daemon=True)
        runner.start()
        try:
            with urlopen(f"http://127.0.0.1:{srv.server_port}/api/meta",timeout=3) as r:
                self.assertEqual(r.status,200)
                self.assertEqual(r.headers["Cache-Control"],"no-store")
                body=json.load(r)
            self.assertEqual(body["mode"],"synthetic-local-only")
            self.assertEqual(body["plugins"],list(PLUGIN_INFO))
            self.assertEqual(body["scenarios"],public_scenarios())
            self.assertIn("expected_revision",body["manual"])
            self.assertIn("株価予測",body["manual"])
        finally:
            srv.shutdown()
            runner.join(2)
            srv.server_close()


if __name__=="__main__":
    unittest.main()
