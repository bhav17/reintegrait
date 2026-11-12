# Step 1 spec addendum: Next steps

Extends `Step 1 spec - Client Note.docx`. It fixes a specification failure: the original spec said "next steps" but didn't say where they come from, so the AI could mix steps the client agreed to with steps it made up, and both looked the same in the note.

Decided with Bhav, Nov 11, 2026.

## Rules

### 1. Two kinds of next step, shown separately

- **Agreed in meeting**: the case manager or client commits to it in the recording ("I'll call you Friday", "we'll start your state ID"). These are ticked by default.
- **AI suggested**: the AI proposes a step for a need nobody acted on in the meeting. These are unticked by default.

The case manager decides on every suggestion. A step is saved to the case file only if it's ticked. The case manager can also untick an agreed step or add her own step (shown as "Added by case manager", ticked).

### 2. Evidence

- An agreed step must link to the transcript line where someone committed to it. If there's no such line, the step can't be marked agreed and is shown as a suggestion instead.
- A suggested step must link to the need it addresses, and through that to the need's transcript line. If there's no need, the AI can't suggest it.

Example from Andre's intake:

- Agreed: "Start the Illinois state ID application" → 00:46:50, *"So this week we start your state ID, get your pills refilled, and I'll call you Friday."*
- Suggested: "Help apply for SNAP" → Food need → 00:21:47, *"I'm not on food stamps or nothing."* Nobody agreed to act on it, so it's a suggestion.

### 3. What each step contains

| Field | Rule |
|---|---|
| Action | Required. Starts with a verb. |
| Owner | Required: Case manager, Client or Both. Taken from who said it. |
| Due | Only if a time was said in the meeting ("this week", "Friday"). Otherwise blank. The AI never makes up a date. |
| Addresses | Required. The immediate need or needs the step serves. |
| Evidence | Agreed: the commitment line. Suggested: the need's line. |
| Status | Agreed in meeting, AI suggested, or Added by case manager. |

### 4. No named providers in suggestions

Suggestions stay generic ("Find a food assistance program", "Help apply for SNAP"). They never name a specific organization. Matching a need to a real provider happens in Step 2 (Matched services) and the referral request. An agreed step may name a provider only if the case manager or client named it in the recording.

### 5. Limit

At most 5 AI suggestions, ordered by the priority of the need they address (Urgent, then Soon, then Later). A need already covered by an agreed step gets no suggestion.

### 6. Reminders

A step with a due date creates a reminder, but only when the note is approved and only if the step is ticked. Unticked suggestions never create reminders.

### 7. Nothing agreed

If the meeting has no agreed steps, the note shows "No next steps agreed". The case manager must tick "I confirm no next steps were agreed in this meeting" before she can approve the note.

## Acceptance checks

- The note shows "Agreed in meeting" and "AI suggested" as separate groups. Agreed steps are ticked, suggestions are not.
- Each step shows owner, due (or nothing), the need it addresses, and a time stamp.
- No suggestion names an organization.
- There are no more than 5 suggestions, in need-priority order, and none for a need an agreed step covers.
- Only ticked steps are saved. Ticking a suggestion saves it; leaving it unticked doesn't.
- The follow-up reminder is created only if the follow-up call step is ticked.
- With no agreed steps, approval needs the "no next steps agreed" confirmation.
- The activity log records each suggestion accepted or declined.
