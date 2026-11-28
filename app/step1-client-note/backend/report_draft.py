"""The AI step of the grant report: Claude writes the words, code supplies every number.

How a number reaches the report:
  1. grant_report.facts() counts it from the case file and gives it a name, e.g. served = 24.
  2. Claude sees the names and values and writes "{served} clients", never "24 clients".
  3. fill() swaps each {name} for its value.
  4. check() refuses the draft if Claude typed any number itself (digits or words like "forty"),
     used a name that does not exist, left out a section, or wrote a client's name.
A refused draft is sent back once with the problems listed. If the second draft fails too, the tab
keeps its template draft, which is built from the same numbers.

Claude only ever sees counts and category labels: no client names, notes or dates of birth.
"""
import json
import re
from pathlib import Path

import grant_report as gr

PROMPT = Path(__file__).resolve().parent / "prompts" / "grant-report.md"
PLACEHOLDER = re.compile(r"\{([a-z0-9_]+)\}")
NUMBER_WORDS = re.compile(
    r"\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|"
    r"eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen|dozens|"
    r"percent|per cent|half|quarter of|third of|majority|most clients|all clients|every client|single)\b"
    r"|(?<!no )\bone\s+(?!of\b|another\b|or\b|by\b|at\b|way\b)[a-z]+", re.I)
# Names that contain a digit but are not amounts ("R3", "Q4", "9A") may appear when the input itself uses them.
CODE_WORD = re.compile(r"\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]+\b")
# Words that can sit in a Name field without being a name ("New client" is the default for a blank name).
NOT_NAMES = {"new", "client", "person", "unknown", "not", "stated", "sample", "test"}


def client_names(R):
    out = set()
    for c in R.get("Client", []):
        for part in re.split(r"[\s,.'-]+", str(c.get("Name") or "")):
            if len(part) >= 3 and part.lower() not in NOT_NAMES:
                out.add(part.lower())
    return out


def fill(text, facts):
    return PLACEHOLDER.sub(lambda m: facts[m.group(1)]["value"] if m.group(1) in facts else m.group(0), text)


def check(sections, keys, facts, names, codes=()):
    """Return (filled {key: text}, problems [str]). No problems means the draft can be shown.

    codes: words like "R3" that hold a digit but name something; they are allowed only if the input used them.
    """
    problems, filled = [], {}
    by_key = {}
    for s in sections or []:
        if isinstance(s, dict) and s.get("key") in keys and isinstance(s.get("text"), str):
            by_key[s["key"]] = s["text"].strip()
    for k in keys:
        raw = by_key.get(k, "")
        if not raw:
            problems.append(f"Section '{k}' is missing or empty.")
            continue
        unknown = sorted({m for m in PLACEHOLDER.findall(raw) if m not in facts})
        if unknown:
            problems.append(f"Section '{k}' uses placeholders that do not exist: {', '.join('{' + u + '}' for u in unknown)}.")
        bare = PLACEHOLDER.sub(" ", raw)
        bare = CODE_WORD.sub(lambda m: " " if m.group(0) in codes else m.group(0), bare)
        typed = re.findall(r"\d[\d,.:%]*", bare)
        if typed:
            problems.append(f"Section '{k}' types numbers instead of using placeholders: {', '.join(typed[:5])}.")
        words = sorted({m.group(0).lower() for m in NUMBER_WORDS.finditer(bare)})
        if words:
            problems.append(f"Section '{k}' states amounts in words ({', '.join(words)}). Use a placeholder, or leave the amount out.")
        if "{" in bare or "}" in bare:
            problems.append(f"Section '{k}' has a broken placeholder.")
        text = fill(raw, facts)
        hit = sorted({n for n in names if re.search(rf"\b{re.escape(n)}\b", text, re.I)})
        if hit:
            problems.append(f"Section '{k}' contains a client's name. Reports to funders must not name clients.")
        filled[k] = text
    return filled, problems


def _plain(measure):
    m = re.sub(r"\([^)]*\)", "", measure)
    m = re.sub(r",? (and kept it )?\d+\+ months", "", m)
    m = re.sub(r",? measures? \d.*$", "", m)
    return re.sub(r"\s+", " ", m).strip(" ,")


def build_request(rep, funder, problems=None):
    s = rep["_s"]
    facts = gr.facts(s)
    keys = gr.FUNDERS[funder]["ai_sections"]
    payload = {
        "funder": gr.FUNDERS[funder]["label"],
        "sections_to_write": [{"key": k, "title": gr.SECTION_TITLES[k]} for k in keys],
        "placeholders": {k: {"value": v["value"], "means": v["about"]} for k, v in facts.items()},
        "context": gr.ai_context(s),
        # Measure names without numbers ("measure 26", "6+ months"), which would read as amounts.
        "not_tracked": [_plain(m[0]) for m in rep["metrics"] if str(m[1]).startswith("Not")],
    }
    codes = set(CODE_WORD.findall(json.dumps({k: v for k, v in payload.items() if k != "placeholders"}, ensure_ascii=False)))
    user = "Write the narrative sections for this grant report.\n\n" + json.dumps(payload, indent=1, ensure_ascii=False)
    if problems:
        user += ("\n\nYour last draft was refused for these reasons. Fix every one and write all sections again:\n- "
                 + "\n- ".join(problems))
    return facts, keys, user, codes


def draft(rep, funder, R, config, api_key, call=None):
    """Draft, check, and redraft once if needed.

    call(system, user, config, api_key) -> {sections, model, usage, request_id, stop_reason, seconds}
    defaults to ai_client.draft_report_call; tests pass a stand-in.
    Returns {ok, sections {key: text}, problems, attempts, model, usage, seconds, request}.
    """
    if call is None:
        from ai_client import draft_report_call as call
    system = PROMPT.read_text(encoding="utf-8")
    names = client_names(R)
    problems, last, total, history = None, None, 0.0, []
    for attempt in (1, 2):
        facts, keys, user, codes = build_request(rep, funder, problems)
        last = call(system, user, config, api_key)
        total += float(last.get("seconds") or 0)
        filled, problems = check(last.get("sections"), keys, facts, names, codes)
        history.append({"attempt": attempt, "problems": problems, "usage": last.get("usage")})
        if not problems:
            break
    return {"ok": not problems, "sections": filled if not problems else {}, "problems": problems or [],
            "attempts": attempt, "history": history, "model": last.get("model"), "usage": last.get("usage"),
            "seconds": round(total, 1), "request": {"system": "prompts/grant-report.md", "input": user},
            "raw": last.get("sections")}
