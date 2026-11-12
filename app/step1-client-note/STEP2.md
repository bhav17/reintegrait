# Step 2 prototype: Matched services

Built from `prototype/step2-matched-services/SPEC.md` (storyboard Step 2, "Identify / bucket immediate needs", and the first part of Step 3, "Referral request"). It is a **Matched services** tab added to the Step 1 prototype in this folder, so it uses the same case manager (Denise), client (Andre Williams) and approved note.

Nothing is sent anywhere. Provider replies come from a **Simulate provider reply** button, the client's text is shown in a phone-style preview, and there is no server or login.

## Files

| File | What it is |
|---|---|
| `matched-services.js` | The Matched services screens, the eligibility rules (✓ ✗ ?), the ranking, and the referral and answer flow |
| `matched-services.css` | Styles for the tab. Reuses the Step 1 colors and components |
| `simulated_responses.json` → `matched_services` | Everything the simulated AI "knows": client facts from the note, the service directory per need (Medication, Housing, ID, Food, Work, Transportation), eligibility rules with their source, openings with update dates, referral history, ranking weights, the referral draft, call script, provider replies and the client text. Edit it and reload |
| `acceptance-test-step2.js` | Automated check of the Step 2 acceptance criteria |

`index.html` only gained a stylesheet and script tag, a **Case file | Matched services** tab strip, and a jump to Matched services after a note is approved.

## Launch

```
cd app/step1-client-note
python3 -m http.server 8000
```

Open http://localhost:8000. If you used the prototype before, click **Reset sample data** first.

## Try the happy path (about 3 minutes)

1. **Approve Andre's note.** New client → **Use the sample recording** → **Process with AI** → **Review the note**. Resolve the two flags, tick the review box, **Approve and save**. His case file opens on **Matched services**.
2. **Needs board.** Five buckets in priority order: Medication, Housing (Urgent), ID, Food (Soon), Work (Later). Each shows the need, **From note 00:02:40** (click to see the line), and how many services were found. Try ↑ ↓, **Handled in-house / not needed**, or add a missed need at the bottom.
3. **Open Housing.** Three ranked cards: Teamwork Englewood CRSC (External, real listing), Southside Men's Transitional House (✗ needs state ID, kept because Andre is getting his ID) and the in-house housing workshop (Internal). Each card shows availability with its update date, the eligibility check with sources, credibility (External only) and why it's suggested. **Not a match (2)** lists the women-only and young-adult programs; **Refer anyway** needs a note.
4. **Turn one down.** **Not this one** on Southside → pick a reason. 211 Metro Chicago moves up.
5. **Refer.** **Refer** on Teamwork. Edit the draft if you like. **Send message** stays disabled until you tick "Andre agreed to share this information with Teamwork Englewood CRSC". Choose **Call** to see the number and a call script.
6. **Provider answer.** The bucket says "Pending: Teamwork Englewood CRSC". Click **Simulate provider reply → Yes**, then **Save answer**. The bucket turns green: "Referred, appt Thu Nov 19, 10:00".
7. **Text Andre.** Edit the drafted text, **Approve and send text**. Two reminders appear (text Andre on Nov 18, check attendance on Nov 20). Rate the provider 1 to 5.
8. **Try a No.** Open Medication, refer the top card, send, **Simulate provider reply → No**, **Save answer**. The reason is recorded, the clinic shows as turned down by the provider, and the next service is on top.
9. **Activity log.** Open the panel at the bottom. Every action is there with time and detail. The **Case file** tab shows the referral entries.

## How matching works

- **Eligibility:** each rule in the JSON names a client fact (`age`, `gender`, `has_state_id`…). ✓ if the fact meets it, ✗ if not, ? if the fact is unknown (ask). Facts come from `client_facts`, with the note line they came from.
- **Not a match:** any ✗ moves a service there, unless every ✗ is a document the client is getting (an open ID need).
- **Ranking:** availability points + credibility (share accepted, rating) − distance − penalties for document gaps and unknown rules. The weights are in `matched_services.ranking`. Up to 3 cards show; services Denise adds are always shown and tagged "Added by Denise".
- **Provider answers feed back:** a Yes or No updates the provider's credibility on later cards (Teamwork also serves ID and Work), and a No with "Full" or "Program closed" changes its availability. This is pooled as facts about services, never about clients.

## Real and simulated data

Real public listings (marked **Real listing**): Teamwork Englewood and Centers for New Horizons CRSCs (City of Chicago reentry page), 211 Metro Chicago, Illinois ABE, Illinois Secretary of State. Everything else is simulated: openings, credibility numbers, ratings, and the clinic, shelter, residence, pantry and staffing listings. Distances are approximate.

## Records

Saving writes to the Step 1 record store: a **Referral** (NeedId, Partner, ServiceId, Status Sent / Accepted / Declined, Method, Consent, Draft, Rank, Appointment, DeclineReason, ClientText, Rating), **Interactions** for the case file (Referral sent, accepted, declined, Text to client), two dated **Goals** for the reminders, and Need fields `BoardRank`, `Category`, `AddedBy` and Status `Handled`. Turn-downs, added services and provider history changes last until reload.

## Acceptance criteria (from the spec)

| Criterion | Checked by |
|---|---|
| Open Andre's needs board, see 5 bucketed needs, open one to see up to 3 ranked cards with Internal/External, availability, eligibility and (External) credibility | checks 1 and 2 |
| Turn a service down with a reason, then refer another. Send is disabled until consent is ticked | checks 2 and 3 |
| Provider Yes → client text drafted and two reminders; No → reason logged and the next service moves up | check 4 |
| Every action appears in the on-screen activity log | check 5 |
| Data from `simulated_responses.json`, phone width, keyboard, no script errors | checks 6 and 7 |

```
python3 -m http.server 8000        # in this folder
node acceptance-test-step2.js      # in another terminal
```

40 of 40 checks pass. The Step 1 test (`acceptance-test.js`) still passes too.
