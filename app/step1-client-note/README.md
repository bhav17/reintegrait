# Step 1 prototype: Client Note

A clickable prototype of Step 1 from the user journey storyboard. A case manager records a client meeting, AI turns it into a standard client note, and the case manager edits and approves it. Existing clients get new voice notes or typed updates added to their case file.

**Step 2 (Matched services)** is a tab in the same prototype. See [STEP2.md](STEP2.md).

**Real AI for voice to text:** run `python3 backend/server.py` instead of `python3 -m http.server 8000` to send uploaded recordings to a real Whisper model on Hugging Face, and have Claude draft the note from that transcript. Setup, model switching and the test log are in [backend/README.md](backend/README.md).

The AI is simulated. Nothing is sent anywhere, and there is no server or login. Client records are saved in your browser only (see Records below).

## Files

| File | What it is |
|---|---|
| `index.html` | The whole prototype: screens, the record store with the sample clients, and the logic that plays back the simulated AI |
| `simulated_responses.json` | Note templates (intake key fields, update types, service types, meeting types) and every simulated AI response: processing results, transcripts, the drafted client note, flags, and the updates for existing clients. Edit it and reload |
| `acceptance-test.js` | Optional automated check of the acceptance criteria below |
| `acceptance-test-documents.js` | Automated check of Verify with a document |
| `sample-documents/` | Two made-up documents for the fictional client Andre: release papers and a state ID. Marked SAMPLE. Never put a real person's document here |

## Launch

The page loads `simulated_responses.json`, and browsers block that when you double-click an HTML file. So serve the folder:

```
cd prototype/step1-client-note
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Try the happy path (about 2 minutes)

1. **Home.** You see "Welcome back, Denise", the **New client** and **Existing client** buttons, and the reminders due.
2. **New client.** Click it. The pop-up asks for the voice note and shows the limits (up to 3 hours, 500 MB, MP3/M4A/WAV/AAC). Choose any audio file or click **Use the sample recording**. You can type notes instead.
3. **Process with AI.** Four steps run: quality check, voice to text, errors and missing information, template match.
4. **Review the note.** Key information (name, age, gender, neighborhood, contact), immediate needs, next steps. Click a time stamp to see the transcript line it came from.
5. **Edit and review check.** Click **Edit note** to change any field or add and remove needs and steps. Resolve the two flags (gender not stated, phone cut off), tick the review box, then **Approve and save to case file**.
6. **Clients.** Andre Williams is now in the database with the note in his case file and a Friday reminder.
7. **Existing client.** Select Marcus Reed, click **Upload new information** (or **Log response** on his reminder), pick the update type (referral check, second visit, weekly phone check or weekly message check), use the sample, process it, review the changes, tick the box, and **Add to case file**. His status, needs, case file and next reminder update.

Changes are saved in your browser and survive a reload. Click **Reset sample data** at the top of any screen to start over with the five sample clients.

## Acceptance criteria and test

| # | Criterion (from the Step 1 spec) |
|---|---|
| 1 | Home says welcome back and shows New client and Existing client |
| 2 | New client opens a pop-up to upload a voice note and states the size limit for long files |
| 3 | AI checks quality, turns voice into text, looks for errors and missing information, and matches a template |
| 4 | Output is a client note in a standard template: age, gender, locality, contact, immediate needs, next steps |
| 5 | The user can edit the note and must complete a review check before saving |
| 6 | Existing client opens the client database. Selecting a client shows a button to upload new information (referral check response, second visit, weekly phone or message check), which is added to the case file. Reminders are tracked per client |
| 7 | All simulated AI output comes from `simulated_responses.json` |
| 8 | Works at phone width; no script errors |
| 9 | Records: every screen reads and writes the seven record types below; a reload keeps them; each approval is logged; reset restores the samples; templates come from the JSON file |
| 10 | Step 1 spec (`Step 1 spec - Client Note.docx`): reminders due today and this week with Log response on home; "Type notes instead"; files in other formats or over 500 MB refused with a reason; flags at the top of the note with icon and text; consent shown in the transcript; need priority can be changed; review box reads "I reviewed this note against the conversation"; new clients start as "New intake"; an on-screen Activity log records each edit (before and after), need and step added or removed, priority change, flag resolution, review tick, reminder created, update type, accepted or removed changes, time stamps opened, and time from upload to approval |
| 11 | Next steps rules (`docs/specs/step1-next-steps.md`): agreed steps and AI suggestions shown separately (agreed ticked, suggestions not); each step has owner, due (only if said), the need it addresses and evidence; suggestions name no provider, are capped at 5 in need-priority order and skip needs an agreed step covers; only ticked steps are saved; a reminder is created only from a ticked dated step; with no agreed steps, approval needs a confirmation; the activity log records suggestions accepted and declined |
| 12 | Dosage: each need has a service type; each note and update logs meeting type, minutes and services covered, and can't be saved without them; saving writes Service records; each client shows contacts, minutes, service types and referrals |

To run the automated check (needs Node and Playwright):

```
npm i -D playwright && npx playwright install chromium
python3 -m http.server 8000        # in this folder, in one terminal
node acceptance-test.js            # in another terminal
```

It prints PASS or FAIL for each criterion and saves a screenshot of each screen to `screenshots/`.

## Records

The screens read and write eight record types, kept in `localStorage` under `reintegrait.records.v2`. Their names follow Salesforce Nonprofit Cloud so an export maps cleanly later.

| Record | What it holds | Salesforce equivalent |
|---|---|---|
| Client | Name, age, gender, neighborhood, phone, status, client since | Account / Contact |
| Interaction | Each intake note, visit, call or text: date, type, summary, voice or typed, meeting type, minutes | Interaction, InteractionSummary |
| Need | Each open need from a note, with priority and service type | Care plan need |
| Service | One per service type covered in an interaction, with minutes (the interaction's minutes split evenly) | BenefitDisbursement |
| Goal | Next steps, and reminders (a reminder is an open goal with a due date) | GoalAssignment |
| Referral | Referrals sent to partners (statuses grow in step 4) | Referral |
| Approval | Who approved which note or update, and when | Audit log |
| Document | A document on a client's file: type, number, date added, who added it, a note, and the file name. When it was checked against a new client's note, also which fields matched, which differed and which value Denise chose, which were added or left out. The file itself is kept only if Denise asked, in this browser's IndexedDB, under `FileKey` | DocumentChecklistItem |

**Documents.** Each client's case file has a Documents list. **+ Add document** takes a photo or PDF (up to 20 MB), a document type (release papers, state ID, birth certificate, Social Security card, benefits letter, signed consent form, release of information, other), an optional number and note. The file is saved in this browser only (IndexedDB, not localStorage, because files are large). **View** opens it and **Remove** deletes the record and the file after a second click. Adding, opening and removing are in the activity log. Reset sample data also clears the files.

**Verify with a document.** On a new client's note, **Verify with a document** reads a photo or PDF of release papers, a state ID or a benefits letter. It checks name, date of birth (and age from it), neighborhood, release date, facility, supervision, officer and conditions. Gender is never read from a document. A match gets a green "Verified · Release papers" tag, which goes away if the field is edited by hand. A difference is a flag that shows both values, and the note can't be saved until Denise picks one. A value found only on the document is offered with **Add to note** or **Leave out**. Tick **Keep a copy in the client's documents** to also keep the file. Saving writes a Document record, lists the verified fields on the Client record (`VerifiedFields`), and adds "Checked against: …" to the intake note. Every match, difference and choice goes to the activity log. In Simulated mode only the two sample documents work; reading your own needs the laptop helper (see `backend/README.md`).

Logging a response on a client closes their open reminders, and the update's own reminder, if kept, becomes the next one.

**Dosage.** Service types are Housing, ID and documents, Jobs, Benefits, Health, Family, Legal and Transport (edit them in the JSON file). Each need gets one. Before a note or update is saved, the review panel's service log asks for the meeting type, the minutes (filled from the recording length when there is one) and the services covered. Saving writes one Service record per type covered. Each client's page shows contacts, minutes, service types and referrals, which are the dosage measures ESTTA says reentry funders ask for.

## Replacing the simulated AI later

Each block in `simulated_responses.json` matches one AI job: `processing` (the four checks), `transcript`, `note` (key info, needs, next steps, flags) and `client_update` (summary and case file changes per update type). A real model only has to return JSON in the same shape. In `index.html`, the `fetch("simulated_responses.json")` at the bottom is the one place to swap.
