"""Run: python -m unittest test_app   (from the trading_desk folder)"""
import json
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.mkdtemp()
os.environ["TRADING_DESK_HOME"] = TMP

import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class DeskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP)
        skills = root / "skills"
        (skills / "trader-risk" / "scripts").mkdir(parents=True)
        (skills / "trader-risk" / "tests").mkdir()
        (skills / "trader-risk" / "SKILL.md").write_text(
            "---\nname: trader-risk\ndescription: >\n  Sizing and\n  risk checks.\n---\n# Body\n", encoding="utf-8")
        (skills / "trader-risk" / "scripts" / "size.py").write_text("import sys; print('args', sys.argv[1:])", encoding="utf-8")
        (skills / "trader-risk" / "tests" / "test_size.py").write_text("", encoding="utf-8")
        (skills / "other-skill").mkdir()
        (root / "td" / "trader").mkdir(parents=True)
        (root / "td" / "trader" / "config.json").write_text(json.dumps({"paper": True}), encoding="utf-8")
        app.save_settings({"skills_dir": str(skills), "trading_dir": str(root / "td")})
        cls.client = TestClient(app.app)

    def test_frontmatter(self):
        fm = app.parse_frontmatter("---\nname: x\ndescription: >\n  a\n  b\n---\nbody")
        self.assertEqual(fm, {"name": "x", "description": "a b"})
        self.assertEqual(app.parse_frontmatter("no frontmatter"), {})

    def test_discovery_filters_prefix_and_tests(self):
        skills = self.client.get("/api/skills").json()
        self.assertEqual([s["name"] for s in skills], ["trader-risk"])
        self.assertEqual(skills[0]["tools"], ["scripts/size.py"])
        self.assertEqual(skills[0]["description"], "Sizing and risk checks.")

    def test_run_tool_and_reject_unknown(self):
        r = self.client.post("/api/skills/run", json={"folder": "trader-risk", "script": "scripts/size.py", "args": 'SPY "a b"'})
        self.assertIn("args ['SPY', 'a b']", r.text)
        r = self.client.post("/api/skills/run", json={"folder": "trader-risk", "script": "../../x.py", "args": ""})
        self.assertEqual(r.status_code, 404)

    def test_status_reads_paper_flag(self):
        self.assertTrue(self.client.get("/api/status").json()["paper"])

    def test_journal_pnl_and_r(self):
        t = self.client.post("/api/journal", json={"trade": {"symbol": "NVDA", "side": "short", "qty": "10",
                                                             "entry": "100", "stop": "101", "exit": "98", "fees": "1"}}).json()
        self.assertEqual((t["pnl"], t["r"]), (19.0, 2.0))
        self.client.delete(f"/api/journal/{t['id']}")
        self.assertEqual(self.client.get("/api/journal").json(), [])

    def test_claude_event_translation(self):
        lines = [json.dumps({"type": "system", "subtype": "init", "session_id": "abc12345"}),
                 json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"},
                                                                          {"type": "tool_use", "name": "Bash", "input": {"command": "python x.py"}}]}}),
                 json.dumps({"type": "result", "session_id": "abc12345", "total_cost_usd": 0.01,
                             "permission_denials": [{"tool_name": "mcp__broker__order"}]})]
        evs = [json.loads(e) for e in app.claude_events(iter(lines))]
        self.assertEqual([e["kind"] for e in evs], ["init", "text", "tool", "done"])
        self.assertEqual(evs[2]["detail"], "python x.py")
        self.assertEqual(evs[3]["denials"], ["mcp__broker__order"])

    def test_claude_cmd_never_skips_permissions(self):
        cmd = app.claude_cmd(app.load_settings(), "abc12345-ff")
        self.assertNotIn("--dangerously-skip-permissions", cmd)
        self.assertIn("--resume", cmd)
        self.assertNotIn("mcp", " ".join(cmd))

    def test_bad_symbol(self):
        self.assertEqual(self.client.get("/api/quotes?symbols=SPY;rm").status_code, 400)


if __name__ == "__main__":
    unittest.main()
