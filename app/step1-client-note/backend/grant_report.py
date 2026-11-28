"""Grant report numbers, counted in code from the shared case file. No model touches a number here.

compute(records, period, funder) mirrors grStats() and grMetrics() in grant-report.js, so the tab shows
the same figures whether they were counted in the browser (no helper) or here (helper running).
tests/test_grant_report.py checks the two give identical results on the sample clients.

On top of the browser version it adds:
  sources       the record IDs behind each headline number, so any figure can be traced back
  completeness  how many served clients have each demographic field the funder asks for
  facts         the flat list of numbers the AI may use in the narrative, each with a placeholder name
"""
import re
from datetime import date, timedelta

AGE_BINS = [("18-25", 18, 25), ("26-35", 26, 35), ("36-45", 36, 45), ("46-55", 46, 55), ("56-64", 56, 64), ("65 and up", 65, 200)]
AGE_ORDER = [b[0] for b in AGE_BINS] + ["Unknown"]
OTHER_SERVICES = ["ID and documents", "Benefits", "Family", "Legal", "Transport", "Health"]
NT = "Not tracked"
# Below this many people, a demographic breakdown is not sent to the AI (it could point to one person).
SMALL_CELL = 5

FUNDERS = {
    "icjia": {"label": "ICJIA R3 (Illinois Restore, Reinvest, Renew), quarterly",
              "ai_sections": ["summary", "services", "referrals", "challenges", "next"]},
    "bja": {"label": "BJA Second Chance Act (federal), semiannual narrative",
            "ai_sections": ["accomplish", "barriers", "plan"]},
}
SECTION_TITLES = {
    "summary": "Summary of the quarter", "services": "Services delivered (outputs)", "referrals": "Referrals and outcomes",
    "challenges": "Challenges and barriers", "next": "Plan for next quarter",
    "accomplish": "1. What were your accomplishments during the reporting period?",
    "barriers": "3. What problems or barriers did you encounter that prevented you from reaching your goals or milestones?",
    "plan": "6. What major activities are planned for the next 6 months?",
}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _num(v):
    """Minutes and ages can arrive as numbers or typed strings. Anything unreadable counts as 0."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _int(x):
    return int(x) if float(x).is_integer() else x


def _in(d, p):
    d = d or ""
    return p["from"] <= d <= p["to"]


def _bump(d, k, n=1):
    d[k] = d.get(k, 0) + n


def _pct(a, b):
    # Math.round in JS rounds .5 up; Python's round() rounds to even, so do it by hand.
    return int(a / b * 100 + 0.5) if b else None


def _pct_text(a, b):
    return f"{_pct(a, b)}% ({a} of {b})" if b else "not yet measurable"


def check_period(period):
    if not isinstance(period, dict) or not all(ISO.match(str(period.get(k, ""))) for k in ("from", "to")):
        raise ValueError("period needs from and to as YYYY-MM-DD")
    if period["from"] > period["to"]:
        raise ValueError("period starts after it ends")
    return {"from": period["from"], "to": period["to"], "label": str(period.get("label") or f"{period['from']} to {period['to']}")}


def stats(R, p):
    """Same numbers as grStats() in grant-report.js."""
    its = [x for x in R["Interaction"] if _in(x.get("Date"), p)]
    with_min = [x for x in its if _num(x.get("Minutes")) > 0]
    meetings = list(dict.fromkeys(x["MeetingType"] for x in its if x.get("MeetingType")))
    served = list(dict.fromkeys(x.get("ClientId") for x in its))
    intakes = [c for c in R["Client"] if _in(c.get("ClientSince"), p)]
    by_type = {}
    for s in R["Service"]:
        if _in(s.get("Date"), p):
            t = by_type.setdefault(s.get("ServiceType"), {"minutes": 0, "clients": []})
            t["minutes"] += _num(s.get("Minutes"))
            if s.get("ClientId") not in t["clients"]:
                t["clients"].append(s.get("ClientId"))
    refs = [r for r in R["Referral"] if _in(r.get("SentDate"), p)]
    accepted = [r for r in refs if r.get("Status") == "Accepted" or r.get("Stage") in ("Accepted", "Attended", "No-show", "Closed")]
    declined = [r for r in refs if r.get("Status") == "Declined"]
    attended = [r for r in refs if r.get("Stage") in ("Attended", "Closed") or r.get("Attendance") == "Showed up" or r.get("AttendedDate")]
    no_show = [r for r in refs if r.get("Stage") == "No-show" or r.get("Attendance") == "No-show"]
    closed = [r for r in refs if r.get("Outcome")]
    met = [r for r in closed if r.get("Outcome") == "Goal met"]
    why = {}
    for r in declined:
        _bump(why, r.get("DeclineReason") or "Other")
    open_needs = [n for n in R["Need"] if n.get("Status") == "Open"]
    need_types = {}
    for n in open_needs:
        _bump(need_types, n.get("ServiceType") or "Other")
    answered = len(accepted) + len(declined)

    clients = {c.get("Id"): c for c in R["Client"]}
    by_age, by_gender = {}, {}
    for cid in served:
        c = clients.get(cid)
        if not c:
            continue
        _bump(by_gender, c.get("Gender") or "Unknown")
        age = _num(c.get("Age"))
        _bump(by_age, next((b[0] for b in AGE_BINS if b[1] <= age <= b[2]), "Unknown"))
    up_to = [x for x in R["Interaction"] if (x.get("Date") or "") <= p["to"]]
    cum_ids = list(dict.fromkeys(x.get("ClientId") for x in up_to))
    cut = (date.fromisoformat(p["to"]) - timedelta(days=30)).isoformat()
    recent = {x.get("ClientId") for x in up_to if (x.get("Date") or "") >= cut}
    engaged = [cid for cid in cum_ids if cid in recent]
    svc_clients = {}
    for s in R["Service"]:
        if (s.get("Date") or "") <= p["to"]:
            lst = svc_clients.setdefault(s.get("ServiceType"), [])
            if s.get("ClientId") not in lst:
                lst.append(s.get("ClientId"))

    return {
        "byAge": by_age, "byGender": by_gender, "cum": len(cum_ids), "engaged": len(engaged),
        "svcClients": {k: len(v) for k, v in svc_clients.items()},
        "p": p, "meetings": meetings, "served": len(served), "intakes": len(intakes), "contacts": len(its),
        "minutes": _int(sum(_num(x.get("Minutes")) for x in with_min)),
        "byType": {k: {"minutes": _int(v["minutes"]), "clients": len(v["clients"])} for k, v in by_type.items()},
        "refs": len(refs), "accepted": len(accepted), "declined": len(declined), "answered": answered,
        "attended": len(attended), "noShow": len(no_show), "closed": len(closed), "met": len(met), "why": why,
        "needTypes": need_types, "openNeeds": len(open_needs),
        "pendingAnswer": len(refs) - answered, "pendingShow": len(accepted) - len(attended) - len(no_show),
        "noOutcome": len(attended) - len(closed),
        # Only the server version keeps these: the records behind each number.
        "_ids": {"served": served, "intakes": [c.get("Id") for c in intakes], "contacts": [x.get("Id") for x in its],
                 "refs": [r.get("Id") for r in refs], "cum": cum_ids, "engaged": engaged,
                 "svcClients": svc_clients},
    }


def metrics(s, funder, R=None):
    """Same rows as grMetrics() in grant-report.js: [measure, value, note]."""
    def order(o, keys):
        return ", ".join(f"{k}: {o.get(k, 0)}" for k in keys)

    if funder == "icjia":
        race = _race(s, R)
        return [
            ["Total clients served this quarter (may include duplicates)", f"{s['contacts']} contacts", "Counted as one per logged contact"],
            ["Unique clients served this quarter", s["served"], ""],
            ["Clients by gender", order(s["byGender"], list(s["byGender"])) or "0", ""],
            ["Clients by age group", order(s["byAge"], AGE_ORDER), "R3 age groups"],
            ["Clients by race/ethnicity", race[0], race[1]],
            ["Types of outreach conducted", NT, "Phone, in-person, text and others. Meeting type is logged per contact"],
            ["R3-funded staff (start, end, hired, left)", NT, "Staffing is not part of the case file"],
            ["Your priority-area metric: referrals sent", s["refs"], "Reentry metrics come from your AmpliFund performance plan. Match these to the ones you chose"],
            ["Your priority-area metric: referrals accepted and attended", f"{s['accepted']} accepted, {s['attended']} attended", ""],
        ]

    def sc(k):
        return s["svcClients"].get(k, 0)

    ids = s["_ids"]["svcClients"]
    other = {cid for k in OTHER_SERVICES for cid in ids.get(k, [])}
    return [
        ["Participants served since the start (cumulative), measure 8", s["cum"], "Includes people served directly and through referrals"],
        ["Still engaged at the end of the period, measure 9A", s["engaged"], "Counted as a contact in the last 30 days. BJA lets each program define engagement"],
        ["No longer engaged, measure 9B", s["cum"] - s["engaged"], ""],
        ["Completed all program requirements, measure 10A", NT, "Needs a completion field per client"],
        ["Received employment services, measure 27", sc("Jobs"), "Service type Jobs"],
        ["Received housing services, measure 28", sc("Housing"), "Service type Housing"],
        ["Received education services, measure 26", NT, "No education service type yet"],
        ["Received other services, measure 29", len(other), "ID and documents, Benefits, Family, Legal, Transport, Health"],
        ["Obtained permanent or stable housing (6+ months), measure 31", NT, "Needs a housing outcome with a date"],
        ["Obtained employment, and kept it 6+ months, measures 35 and 36", NT, "Needs an employment outcome with dates"],
        ["Court and criminal involvement, measures 46 to 58 (closeout only)", "Not collected", "ReintegrAIt does not hold arrest or conviction data"],
    ]


def _race(s, R):
    """R3 requires race/ethnicity. Count it once a RaceEthnicity field exists on clients; until then say it is missing."""
    note = "R3 requires it. Add a race/ethnicity field to the intake note"
    if not R:
        return NT + f" (all {s['served']} Unknown)", note
    clients = {c.get("Id"): c for c in R["Client"]}
    vals = {}
    for cid in s["_ids"]["served"]:
        _bump(vals, (clients.get(cid) or {}).get("RaceEthnicity") or "Unknown")
    if set(vals) <= {"Unknown"}:
        return NT + f" (all {s['served']} Unknown)", note
    return ", ".join(f"{k}: {v}" for k, v in vals.items()), ("" if "Unknown" not in vals else "Some clients have no race/ethnicity recorded")


def completeness(s, R):
    """For each demographic the funder asks about: how many of the clients served have it filled in."""
    clients = {c.get("Id"): c for c in R["Client"]}
    served = [clients.get(cid) or {} for cid in s["_ids"]["served"]]

    def known(f, bad=("", "Unknown", "Not stated")):
        return sum(1 for c in served if str(c.get(f) or "").strip() not in bad)
    n = len(served)
    return [{"field": "Gender", "known": known("Gender"), "of": n},
            {"field": "Age", "known": sum(1 for c in served if _num(c.get("Age")) >= 18), "of": n},
            {"field": "Race/ethnicity", "known": known("RaceEthnicity"), "of": n}]


def _slug(t):
    return re.sub(r"[^a-z0-9]+", "_", str(t).lower()).strip("_") or "other"


def _fmt_date(iso):
    d = date.fromisoformat(iso)
    return f"{d.strftime('%b')} {d.day}, {d.year}"


def facts(s):
    """The numbers the AI may use, each under a placeholder name. The AI writes {name}; code puts the number in.

    Returns {name: {"value": str, "about": str}}. Demographic breakdowns are left out on purpose: with small
    groups they can point to one person, and the funder table already carries them.
    """
    f = {}

    def add(name, value, about):
        f[name] = {"value": str(value), "about": about}

    add("period_from", _fmt_date(s["p"]["from"]), "first day of the reporting period")
    add("period_to", _fmt_date(s["p"]["to"]), "last day of the reporting period")
    add("served", s["served"], "unique clients served in the period")
    add("intakes", s["intakes"], "new clients (intakes) in the period")
    add("contacts", s["contacts"], "contacts logged (calls, visits, texts)")
    add("hours", str(int(s["minutes"] / 6 + 0.5) / 10).removesuffix(".0"), "hours of direct service")
    add("referrals_sent", s["refs"], "referrals sent to partner organizations")
    add("referrals_answered", s["answered"], "referrals a partner has answered")
    add("referrals_accepted", s["accepted"], "referrals a partner accepted")
    add("referrals_declined", s["declined"], "referrals a partner declined")
    add("referrals_waiting", s["pendingAnswer"], "referrals still waiting for a partner answer")
    add("accept_rate", _pct_text(s["accepted"], s["answered"]), "share of answered referrals that were accepted, with counts")
    add("referrals_attended", s["attended"], "accepted referrals the client attended")
    add("referrals_no_show", s["noShow"], "accepted referrals the client did not show up to")
    add("attend_rate", _pct_text(s["attended"], s["accepted"]), "share of accepted referrals attended, with counts")
    add("referrals_closed", s["closed"], "referrals closed with an outcome")
    add("referrals_goal_met", s["met"], "closed referrals that met the client's goal")
    add("open_needs", s["openNeeds"], "open needs across all caseloads today")
    add("participants_cumulative", s["cum"], "people served since the program started, up to the period end")
    add("still_engaged", s["engaged"], "people with a contact in the last 30 days of the period")
    add("service_type_count", len(s["byType"]), "number of different service types delivered")
    for t, v in s["byType"].items():
        add(f"svc_{_slug(t)}_clients", v["clients"], f"clients who received {t} services")
        add(f"svc_{_slug(t)}_minutes", v["minutes"], f"minutes of {t} services")
    for t, n in s["why"].items():
        add(f"declined_{_slug(t)}", n, f"referrals declined for this reason: {t}")
    for t, n in s["needTypes"].items():
        add(f"open_need_{_slug(t)}", n, f"open needs of type {t}")
    return f


def ai_context(s):
    """Everything the AI sees, all counts and labels, no names or notes."""
    return {
        "period": s["p"]["label"],
        "service_types_by_minutes": [t for t, _ in sorted(s["byType"].items(), key=lambda kv: -kv[1]["minutes"])],
        "contact_types": s["meetings"],
        "decline_reasons": list(s["why"]),
        "open_need_types": [t for t, _ in sorted(s["needTypes"].items(), key=lambda kv: -kv[1])],
    }


def compute(R, period, funder):
    if funder not in FUNDERS:
        raise ValueError("unknown funder")
    p = check_period(period)
    s = stats(R, p)
    out = {k: v for k, v in s.items() if k != "_ids"}
    return {
        "stats": out,
        "metrics": metrics(s, funder, R),
        "completeness": completeness(s, R),
        "sources": {k: v for k, v in s["_ids"].items() if k != "svcClients"},
        "_s": s,
    }
