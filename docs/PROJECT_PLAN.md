# ReintegrAIt: project goals and MVP plan

As of Oct 25, 2026. This summarizes the [MVP build plan](https://claude.ai/artifact/JJzfobdXD9yuybfwmWkjZK), the model-building spec, the step-by-step plan and the [voice capture guide](https://claude.ai/artifact/WHWuJR9XasJ5LsdDYJYV8h). Those docs hold the detail and the sources.

## 1. What ReintegrAIt is

An AI copilot for case managers at Chicago reentry organizations. It turns a visit into a case note, then ranks the services across Chicago's ~111 reentry organizations by how likely each one is to **accept** the client this week. The case manager makes every decision about the client. ReintegrAIt never scores a client's risk and never contacts a parole agent.

Course: Building an AI Company (43120). Demo: December, assumed week of Dec 7.

## 2. Project goals

The demo shows one loop working end to end, and uses it to answer the course's three questions.

| Course goal | What the MVP shows | Evidence |
| --- | --- | --- |
| Diagnose AI fit | Acceptance depends on unwritten rules and weekly capacity, so a static directory misses it | Model vs. rules-only baseline on top-3 hit rate |
| Design the AI architecture | LLM for language (notes, rules, reasons); a small tabular model for the prediction | Working app built on the prototype |
| Design human-AI collaboration | AI ranks and explains; case manager picks, overrides, gets consent, logs the result | Sessions with 3 to 5 case managers |
| Test technical uncertainty | Can acceptance be predicted from sparse, noisy labels? | Offline evaluation, time-based split |
| Test behavioral uncertainty | Will case managers log outcomes and trust the ranking? | Logging rate and pick-the-top rate |
| Test economic uncertainty | Does time saved justify a seat price, and what does keeping 111 organizations current cost? | Time-per-referral interviews, director pricing interviews, curation hours |

## 3. MVP scope

**Built for real**

1. **Voice to case note (module 1).** Post-visit dictation, then speech-to-text with timestamps, then one LLM call that returns a DAP note as JSON where every line cites its transcript segments. Nothing saves until the case manager approves. Only the case manager's voice is recorded, never the client's.
2. **Client profile.** Extracted from the approved note: age band, gender, ZIP, supervision status, offense category, ID documents held, needs.
3. **Service directory.** ~111 organizations, each rule with a source quote and verified date; unpublished rules marked unknown.
4. **Eligibility filter.** Drops clear mismatches and flags unknown rules.
5. **Acceptance ranker.** P(accept) per service; top 3 with a Likely, Uncertain or Unlikely band and reasons.
6. **Outcome logging.** One tap: accepted, or rejected with a reason (Full, Not eligible, Number dead, Too far, Client declined). Updates the directory and the training set.
7. **Evaluation view.** Model vs. baselines.

**Reused from the prototype:** R3 report section. **Simulated:** 48-hour text confirmation to client and partner. **Out of scope:** real client records, CharityTracker or Casebook integrations, client risk scores, other cities' directories.

## 4. Architecture

```
Public sources ──> Rule extraction (LLM + human check) ──> Service directory ─┐
                                                                             ├─> Eligibility filter ─> Acceptance model ─> Top 3 + reasons
Voice memo ─> Speech-to-text ─> LLM note (DAP, cited) ─> Approved note ─> Profile + needs ─┘                                   │
                                                                                                                                v
                        Directory updates <── Outcome log (accepted / rejected + reason) <── Case manager decides
                        Model retraining  <──┘
```

Pooled across organizations: facts about services only. Client fields stay inside the organization that collected them.

## 5. Model spec

| Item | Definition |
| --- | --- |
| Job to be done | When a client needs a service after release, send them to a provider that will take them this week, without wasted trips or hours of calls |
| Decision | Which provider service to refer client *c* with need *n* to on date *t* |
| AI does | Extracts profile, applies written rules, predicts P(accept), ranks top 3 with reasons, prepares the referral packet, asks for the outcome |
| Human does | Approves the profile, checks unknown rules, picks or overrides, gets consent, sends, records the outcome. Never delegated: client risk scores, parole or court contact, sharing without consent |
| Target variable | One row per referral sent. **1** = provider took the client into intake within 14 days. **0** = provider turned them away or could not be reached. Client declined or no-show is **excluded**, not 0, so the model never learns to score clients |
| Objective | Train: minimize log loss with L2 (calibrated probabilities), using pair features plus a time-decayed per-service acceptance rate. Product: maximize top-3 hit rate, with zero rule violations and a bounded hit-rate gap across offense category, supervision status and gender |
| Metrics | Primary: top-3 hit rate and calibration (Brier, reliability by band). Guardrail: precision in the Likely band. Secondary: recall of accepting services in the top 3. Diagnostic: AUC. Accuracy reported only (about 65% of referrals succeed anyway) |
| Baselines | Random eligible service, nearest service, rules-only |
| Model sequence | Baselines, then per-service decayed rate, then logistic regression (likely demo model), then gradient-boosted trees if real data supports it |
| Two layers | General layer (need to service type) can train on multi-city data. Chicago layer (per-provider acceptance) needs Chicago outcomes |

**Voice note metrics:** invented facts per note (target zero), missed facts vs. a checklist, and edit time vs. typing from scratch.

## 6. Data

Acceptance outcomes are scarce and valuable: none of the sources reviewed record whether a provider accepted a referral. They are also perishable and local.

| Access | Source | Use |
| --- | --- | --- |
| Free, open | City reentry guide, 211 Metro Chicago, R3 grantee list | Directory and written rules |
| Free, open | IDOC exit and parole data sets; Cook County Criminal Justice Dashboard | Simulator population mix |
| Free, open | NCCARE360 study (65% connected when funded, 38% when not); Western PA and Indiana 211 data | Simulator base rate, need frequency, referral spread |
| Free, open | Chicago Health Atlas, CMAP, Census ACS and geocoder | Distance, neighborhood context |
| Free with sign-up | 211 National Data Platform API | Structured directory |
| Restricted (data agreement and IRB) | SVORI, ICPSR 27101 and 35610 | Needs vs. services received |
| Paid or partnership | Unite Us, findhelp, partner case-management exports | Real outcomes in other cities |
| Excluded | NIJ Georgia recidivism data, policing and shooting data, re-arrest cohorts, sex-offender registry | Risk-score data; breaks the no-risk-score rule |

**From interviews:** 2 to 3 case managers (3-month de-identified referral log, which is the real label; time per referral; unwritten rules; willingness to log), 5 to 10 provider intake staff (rules, how often full, text confirmation), 3 to 5 program directors (price, budget line, data-sharing policy). The interview checklist is in the project files.

The pipeline is built end to end on a simulator calibrated with the open data. Real case-manager labels replace synthetic ones when they arrive.

## 7. Plan and milestones

| Phase | Dates | Gate |
| --- | --- | --- |
| 1. Foundations | Oct 23 to Nov 8 | At least 80 organizations listed, and a confirmed source of real referral rows |
| 2. First model | Nov 9 to Nov 22 | Offline results show where the model beats rules-only, or why not |
| 3. Loop and field tests | Nov 23 to Dec 6 | Test results in hand for all seven bets |
| 4. Demo | Week of Dec 7 | Build frozen, backup video, two rehearsals |

**Red items now (Bhavya):** confirm demo date and team; email 5 to 8 Chicago reentry organizations to recruit case managers; ask the instructor about ethics review for de-identified referrals. **Next for Claude:** outreach email, interview materials and referral-log template; repo structure and data schema; organization list; voice-to-note module.

The full 37-step tracker with owners, dates, urgency and status lives in the MVP build plan doc.

## 8. Ground rules

- The AI drafts and ranks; the case manager decides.
- No client risk scores, no parole contact, no sharing without client consent.
- Synthetic data only until an organization agrees and any required review is done.
- Delete audio after transcription; vendors with a BAA and zero retention before any real data.

## 9. Open questions

- Demo date, format and audience.
- Does "accepted within 14 days, no-shows excluded" match how partners define success?
- Can the team get de-identified past referrals from case managers?
- Is synthetic data acceptable to the instructors as the main evidence if real rows are thin?
- Request the restricted SVORI data: yes or no?
