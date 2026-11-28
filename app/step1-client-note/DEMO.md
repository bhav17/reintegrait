# Class demo: how ReintegrAIt behaves when things go wrong

Start the prototype (`python3 -m http.server 8000` in this folder, or `python3 backend/server.py` for real AI) and open http://localhost:8000.
Click **Reset sample data** first. Every case starts from the **Class demo…** menu in the top bar. All of them work without the helper or an API key.

| Menu item | What it shows | Where it is built |
|---|---|---|
| Happy path (Andre, sample) | The normal flow, with the new key-facts box, confidence lines and one new-to-you card | `failure-handling.js` |
| Misheard intake (Rosa, saved real-AI run) | Note checks catch what the model saved as certain | `failure-handling.js` (`addNoteChecks`) |
| Shaky Urgent (Darius, saved real-AI run) | The Urgent rule asks before an Urgent label drives the board | `failure-handling.js` |
| Stale match (Andre, old housing listing) | Honest ranking and the call-first gate | `matched-services.js` (`msEval`, `msConf`, `msReferPanel`) |
| (Home screen, always on) | Close the loop: "Did Marcus show up?" | `failure-handling.js` (`fhOutcomesBox`) |

The Rosa and Darius notes are the real note model's output from the lab-case runs (`test-recordings/lab-cases/results/*.raw.json`), stored in `simulated_responses.json` under `demo_cases`. The prototype replays them through the same `applyDraft` code as a live run. The checks run live on top. The screen says "Saved real-AI run" so nobody mistakes the replay for a live call.

## Demo safety

- **Self-test.** `python3 backend/server.py` checks each model in the background when it starts (one tiny call each) and prints a ✓ or ✗ line per model. The grey bar then shows **Self-test passed** or **Self-test: N not ready** (hover for the reason). `python3 backend/server.py --check` runs the test and stops; `--no-check` skips it.
- **Time limit.** A live AI call that takes longer than `demo_time_limit_seconds` in `backend/ai-config.json` (75 by default) is stopped, and the screen carries on with the sample, the same way it does when a call fails. Set it to 0 for long real recordings.
- **Reset sample data** also empties the helper's shared case file, so the Grant report starts from the five sample clients. It removes every browser's records, which is fine for a demo and wrong for real use.

## Script (about 6 minutes)

### 1. Happy path (1 min)
1. Demo menu → **Happy path**. The sample recording processes.
2. Resolve the two usual flags (gender: Male, Asked client; phone: 773-555-0186). Pick a reason for the declined Housing suggestion.
3. Point at **Confirm the key facts with Andre**: name, release date, top need. Approve stays grey until all three are ticked, plus the review box.
4. On Matched services, open **Housing**. Teamwork is #1 with a green line: "Confidence: openings updated 1 day ago · based on 11 referrals". Below the cards is one **New to you** listing from the real city directory.

### 2. Failure 1: misheard intake (2 min)
1. Demo menu → **Misheard intake**. The note opens with three flags.
2. **Check · Next step "Report to probation…"**. Rosa said "Tuesday I think", but the model saved Tue Nov 17 as certain. Click **Not confirmed, leave blank**.
3. **Check · Neighborhood**. "La Villita" is not one of Chicago's 77 community areas, so matching could not place her. Click **Use Little Village (South Lawndale)**.
4. Resolve gender (Not known), tick the key facts and approve. Open **Food**: distances now come from South Lawndale.
5. Point at the Activity log: every check and how it was resolved is recorded.

**To trigger it with real AI:** run `python3 backend/server.py`, upload a recording in which the client hedges a date ("I think", "maybe", "probably", "not sure") or names a local neighborhood ("La Villita", "Inglewood").

### 3. Shaky Urgent (optional, 30 s)
Demo menu → **Shaky Urgent**. Medication is marked Urgent although Darius has "about ten days" of pills. Choose **Keep Urgent** or **Change to Soon**.
**With real AI:** any Urgent need where the client says "N days/weeks of/worth/left" with 7 days or more.

### 4. Failure 2: stale match (2 min)
1. Demo menu → **Stale match**. The bar shows "Stale-match demo on". Approve Andre's note as in the happy path.
2. Open **Housing**. Teamwork has dropped from #1. Its card says "Low confidence: openings updated 41 days ago · based on 2 referrals", and its availability says the data is 41 days old and is treated as unknown.
3. Click **Refer** on Teamwork and tick consent. **Send stays disabled**: the call-first box asks "I called, they have an opening" or "Couldn't reach them, send anyway" with a reason.
4. Choose **I called, they have an opening** and send. The listing updates to "Opening confirmed by phone", and the choice is stored on the referral.

**To trigger it without the menu:** any service whose `availability.updated` is more than `unknown_after_days` (14) before Nov 11, or with fewer than `low_conf_min_referrals` (5) referrals, in `simulated_responses.json`.

### 5. Close the loop (1 min)
1. Go **Home**. "Did they show up?" asks about Marcus's Cara Collective appointment on Tue Nov 10.
2. Click **Text Marcus to ask**. A simulated text says "Reply 1 yes, 2 no". Click **2 (no)**.
3. The no-show is recorded, a follow-up call is added, and **Matched services → Referral pipeline** shows the no-show in Cara Collective's rates.

## Rules, in one place

- **Unsure words:** "I think", "I guess", "maybe", "probably", "not sure", "something like", "or so", "I believe", "don't remember" in the line a date or due date came from.
- **Neighborhood:** the value must be one of the 77 community areas or a known alias. Suggestions come from a short list of local names plus a spelling match.
- **Urgent rule:** an Urgent need with 7 or more days of supply asks Keep Urgent / Change to Soon. "Ran out" never asks.
- **Ranking:** openings older than 14 days count as unknown. Acceptance is `(accepted + 0.6 × 5) / (total + 5)`. Rating weight is multiplied by `raters / (raters + 3)`.
- **Low confidence (call first):** openings older than 14 days, fewer than 5 referrals, or not a partner yet.

## Tests

`NODE_PATH=$(npm root -g) node acceptance-test-failures.js` runs every case above (43 checks). The five earlier suites still pass.
