"""Checks for the live grant report. Run from the step1-client-note folder:

    python3 -m unittest discover -s backend/tests -v

Needs nothing installed: the AI call is replaced by a stand-in that returns fixed drafts.

sample-case-file.json was made by loading index.html in a browser and running the tab's own
grStats() and grMetrics() on two case files: the five sample clients, and a busier copy with
every referral stage, a decline, outcomes and a missing gender. The Python counts must match
the browser's to the last digit, for every period and both funders.
"""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import grant_report as gr  # noqa: E402
import report_draft as rd  # noqa: E402
from case_store import CaseStore  # noqa: E402

FIXTURE = json.loads((HERE / "sample-case-file.json").read_text(encoding="utf-8"))


class SameNumbersAsTheBrowser(unittest.TestCase):
    def test_every_period_and_funder(self):
        for case in ("sample", "busy"):
            R = FIXTURE[case]["records"]
            for pk, exp in FIXTURE[case]["expected"].items():
                for funder in ("icjia", "bja"):
                    with self.subTest(case=case, period=pk, funder=funder):
                        out = gr.compute(R, exp["period"], funder)
                        self.assertEqual(out["stats"], exp["stats"])
                        # Race/ethnicity is the one row the server counts better than the browser,
                        # once clients carry a RaceEthnicity field (the busy case has one).
                        got, want = out["metrics"], exp["metrics"][funder]
                        if case == "busy" and funder == "icjia":
                            got, want = [r for r in got if "race" not in r[0]], [r for r in want if "race" not in r[0]]
                        self.assertEqual(got, want)

    def test_race_counted_when_recorded(self):
        R = FIXTURE["busy"]["records"]
        row = next(r for r in gr.compute(R, FIXTURE["busy"]["expected"]["q4"]["period"], "icjia")["metrics"] if "race" in r[0])
        self.assertIn("Black or African American: 1", row[1])
        self.assertIn("Unknown: 5", row[1])

    def test_numbers_trace_back_to_records(self):
        R = FIXTURE["sample"]["records"]
        out = gr.compute(R, FIXTURE["sample"]["expected"]["q4"]["period"], "icjia")
        self.assertEqual(len(out["sources"]["served"]), out["stats"]["served"])
        self.assertEqual(len(out["sources"]["contacts"]), out["stats"]["contacts"])
        ids = {x["Id"] for x in R["Interaction"]}
        self.assertTrue(set(out["sources"]["contacts"]) <= ids)

    def test_completeness(self):
        R = FIXTURE["busy"]["records"]
        c = {x["field"]: x for x in gr.compute(R, FIXTURE["busy"]["expected"]["q4"]["period"], "icjia")["completeness"]}
        self.assertEqual((c["Gender"]["known"], c["Gender"]["of"]), (5, 6))
        self.assertEqual(c["Race/ethnicity"]["known"], 1)

    def test_bad_period_refused(self):
        with self.assertRaises(ValueError):
            gr.compute(FIXTURE["sample"]["records"], {"from": "2026-11-11", "to": "2026-10-01"}, "icjia")
        with self.assertRaises(ValueError):
            gr.compute(FIXTURE["sample"]["records"], {"from": "Oct 1", "to": "2026-10-01"}, "icjia")


class SharedCaseFile(unittest.TestCase):
    def test_each_browser_owns_what_it_sent(self):
        st = CaseStore(":memory:")
        st.sync("laptop-a", "Denise", {"Client": [{"Id": "c1", "Name": "A"}, {"Id": "a-2", "Name": "B"}]})
        st.sync("laptop-b", "Sam", {"Client": [{"Id": "b-1", "Name": "C"}]})
        self.assertEqual(sorted(c["Id"] for c in st.load()["Client"]), ["a-2", "b-1", "c1"])
        # Laptop A resets: its own extra record goes, laptop B's stays.
        st.sync("laptop-a", "Denise", {"Client": [{"Id": "c1", "Name": "A"}]})
        self.assertEqual(sorted(c["Id"] for c in st.load()["Client"]), ["b-1", "c1"])
        self.assertEqual({d["device"] for d in st.devices()}, {"laptop-a", "laptop-b"})

    def test_bad_sync_refused(self):
        st = CaseStore(":memory:")
        with self.assertRaises(ValueError):
            st.sync("", "", {})
        with self.assertRaises(ValueError):
            st.sync("x", "", {"Client": "nope"})


def _fake_model(*drafts):
    """Stand-in for the Claude call: returns each draft in turn."""
    calls = []

    def call(system, user, config, api_key):
        calls.append(user)
        d = drafts[min(len(calls) - 1, len(drafts) - 1)]
        return {"sections": d, "model": "test-model", "usage": {}, "request_id": "", "stop_reason": "end_turn", "seconds": 0}
    call.calls = calls
    return call


class NarrativeChecks(unittest.TestCase):
    def setUp(self):
        self.R = FIXTURE["sample"]["records"]
        self.rep = gr.compute(self.R, FIXTURE["sample"]["expected"]["q4"]["period"], "icjia")

    def good(self):
        return [{"key": k, "text": f"From {{period_from}} to {{period_to}}, staff served {{served}} clients ({k})."} for k in gr.FUNDERS["icjia"]["ai_sections"]]

    def test_placeholders_filled_by_code(self):
        r = rd.draft(self.rep, "icjia", self.R, {}, "", call=_fake_model(self.good()))
        self.assertTrue(r["ok"])
        self.assertEqual(r["sections"]["summary"], "From Oct 1, 2026 to Nov 11, 2026, staff served 5 clients (summary).")

    def test_typed_number_rejected_then_redrafted(self):
        bad = self.good()
        bad[0]["text"] = "Staff served 42 clients."
        model = _fake_model(bad, self.good())
        r = rd.draft(self.rep, "icjia", self.R, {}, "", call=model)
        self.assertTrue(r["ok"])
        self.assertEqual(r["attempts"], 2)
        self.assertIn("42", model.calls[1])  # the second try is told what was wrong

    def test_spelled_out_number_and_unknown_placeholder_rejected(self):
        bad = self.good()
        bad[1]["text"] = "We served forty clients and {made_up} more."
        r = rd.draft(self.rep, "icjia", self.R, {}, "", call=_fake_model(bad, bad))
        self.assertFalse(r["ok"])
        joined = " ".join(r["problems"])
        self.assertIn("forty", joined)
        self.assertIn("made_up", joined)

    def test_client_name_rejected(self):
        bad = self.good()
        bad[2]["text"] = "Marcus started a job program."
        r = rd.draft(self.rep, "icjia", self.R, {}, "", call=_fake_model(bad, bad))
        self.assertFalse(r["ok"])
        self.assertTrue(any("name" in p for p in r["problems"]))

    def test_missing_section_rejected(self):
        r = rd.draft(self.rep, "icjia", self.R, {}, "", call=_fake_model(self.good()[:2], self.good()[:2]))
        self.assertFalse(r["ok"])

    def test_model_sees_no_names_or_notes(self):
        model = _fake_model(self.good())
        rd.draft(self.rep, "icjia", self.R, {}, "", call=model)
        sent = model.calls[0]
        for c in self.R["Client"]:
            for part in c["Name"].split():
                self.assertNotIn(part, sent)
        for x in self.R["Interaction"]:
            self.assertNotIn(x["Summary"], sent)


if __name__ == "__main__":
    unittest.main()
