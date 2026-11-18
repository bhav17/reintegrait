# Connect the prototype to a real AI model

This folder holds a small helper program that runs on your own laptop. With it, the Step 1 prototype sends the voice recording you upload to two real AI models in a row:

1. **Voice to text:** Whisper on Hugging Face writes down the words, with time stamps.
2. **Draft the note:** Claude (Anthropic) reads that transcript and drafts the intake note: key fields, needs, next steps, who said what, and what was missing or only partly heard.

**What is real and what is still simulated**

| Part of Step 1 | Where it comes from |
| --- | --- |
| Turning the recording into text, with time stamps | **Real model** (set in `ai-config.json`) |
| Labelling who said what, and the drafted new-client note (key fields, needs, next steps, flags) | **Real model** (`note` in `ai-config.json`), if you add an Anthropic key |
| Reading a document (release papers, ID, benefits letter) to check the note against it | **Real model** (`document` in `ai-config.json`), with the same Anthropic key |
| Updates for existing clients | Still `simulated_responses.json` |
| Step 2 matched services | Still `simulated_responses.json` |

Without an Anthropic key, only the transcript is real and the note on the right stays the sample note for Andre. The prototype tells you which one you are looking at.

The instructions Claude gets are in `backend/prompts/draft-note.md`. They are plain English, and you can edit them. The most important rules: fill a field only with what was said, never complete a number or name that was only partly heard, and point every fact to the transcript line it came from.

## What you need

- A Mac or Windows laptop with **Python 3.9 or newer**. Macs usually have it. To check, open Terminal and type `python3 --version`. If it says "command not found", install it from [python.org/downloads](https://www.python.org/downloads/).
- A **Hugging Face account** and your own key (step 2 below). The free monthly credit is small and can run out. If it does, add a few dollars of pre-paid credit at [huggingface.co/settings/billing](https://huggingface.co/settings/billing). Each transcription of a short recording costs a fraction of a cent.
- For the note drafting: an **Anthropic account** with API credit and your own key (step 2b). Without it, everything still works with the sample note.
- For voice to text alone there is nothing to install. Note drafting needs one package (step 3b).

## Step-by-step setup (about 10 minutes)

### 1. Get the project onto your laptop

On the GitHub page for the project, click the green **Code** button, then **Download ZIP**. Unzip it. (If you use git: `git clone` the repository instead.)

### 2. Create your own Hugging Face key

1. Sign in at [huggingface.co](https://huggingface.co).
2. Go to [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) and click **Create new token**.
3. Choose **Fine-grained**. Give it a name, such as `reintegrait-prototype`.
4. Under **Inference**, tick **Make calls to Inference Providers**. Leave everything else unticked.
5. Click **Create token** and copy the key. It starts with `hf_`. Hugging Face shows it only once.

Use your own key. Never send it to teammates, never paste it into chat, and never put it in any file other than `.env`.

### 2b. Create your own Anthropic key (for note drafting)

1. Sign in at [console.anthropic.com](https://console.anthropic.com) and add a small amount of credit under **Billing**.
2. Go to **API keys** and click **Create key**. Copy it. It starts with `sk-ant-`.

The same rules apply: your own key, never shared, only in `.env`.

### 3. Put your keys in a `.env` file

1. Open the folder `app/step1-client-note/backend`.
2. Make a copy of `.env.example` and name the copy `.env` (dot first, nothing after `env`).
   - On a Mac, Finder hides files that start with a dot. Press **Command + Shift + .** to show them. Or in Terminal, from the `step1-client-note` folder: `cp backend/.env.example backend/.env` then `open -e backend/.env`.
3. In `.env`, paste your Hugging Face key right after `HF_TOKEN=` and your Anthropic key right after `ANTHROPIC_API_KEY=`, with no spaces. Save.

### 3b. Install the Anthropic package (for note drafting)

In Terminal, run once:

```
python3 -m pip install anthropic
```

If it says your Python is too old, install the newest Python from [python.org/downloads](https://www.python.org/downloads/) and run the command again.

Git is told to ignore `.env` (see `backend/.gitignore`), so it never gets uploaded. The helper also refuses to show anything in the `backend` folder to a browser.

### 4. Start the helper

Open Terminal (Mac) or Command Prompt (Windows). Go to the prototype folder and start the helper:

```
cd path/to/reintegrait/app/step1-client-note
python3 backend/server.py
```

Tip: type `cd ` with a space, then drag the `step1-client-note` folder into the Terminal window to fill in the path. On Windows, type `python` instead of `python3` if `python3` is not found.

You should see:

```
ReintegrAIt prototype helper
  Open:     http://localhost:8000
  AI mode:  real  (hf-inference · openai/whisper-large-v3)
  Key:      found in backend/.env
  Note:     claude-opus-5-5 drafts the note
  Log file: backend/logs/ai-log.jsonl
  Stop:     press Control + C
```

If it says **Key: NOT FOUND**, go back to step 3. If the **Note** line says what to do to turn it on, do that and restart the helper. Leave this window open while you test.

### 5. Try it

1. Open [http://localhost:8000](http://localhost:8000) in your browser. The grey bar at the top should say **Voice to text uses the real model openai/whisper-large-v3** and show a button **AI: Real · switch**.
2. Click **New client**, then drop in a real recording (MP3, M4A, WAV or AAC). The **Use the sample recording** button always stays simulated, because there is no real audio behind it.
3. Click **Process with AI**. The step **Turn voice into text** waits for the real model. A short clip takes a few seconds. The first call of the day can take up to a minute while Hugging Face wakes the model.
4. The steps **Look for errors and missing information** and **Match to the template** wait for the note model. That usually takes under a minute.
5. Click **Review the note**. The transcript has a green **Real AI** tag and speaker labels, and a line above the note says which model drafted it. Tap a time stamp in the note to jump to the line it came from. The Terminal prints one line per model, such as `✓ claude-opus-5-5 drafted the note in 21.4 s`.

6. On the note, click **Verify with a document**. Take a photo or choose a JPG, PNG or PDF, or click **Sample release papers** (a made-up document for Andre, sent to the real model too). Click **Read document**. After 10 to 30 seconds, matching fields get a green **Verified** tag, a different value becomes a flag where you pick which one is right, and values found only on the document are offered with **Add to note** or **Leave out**. The document itself is not saved anywhere, only what was read from it. The Terminal prints a line such as `✓ claude-opus-5-5 read andre-release-papers.png in 8.2 s`.

If anything goes wrong (wrong key, no credits, no internet), the prototype says so in that step, shows a yellow banner on the note saying the sample is being shown, and writes the error to the log. Nothing breaks.

## Switching between real and simulated

- **In the prototype:** click **AI: Real · switch** in the grey bar. It flips between Real and Simulated for this browser tab.
- **For everyone who runs your copy:** open `backend/ai-config.json` and set `"mode"` to `"simulated"` or `"real"`. Reload the page.
- **Without the helper:** run `python3 -m http.server 8000` instead. The prototype then works exactly as before, fully simulated.

## Switching models in class

Each AI step goes through one function in `backend/ai_client.py`: `transcribe()` for voice to text and `draft_note()` for the note. You never need to edit them to change models. Edit `backend/ai-config.json` instead:

```json
"provider": "hf-inference",
"model": "openai/whisper-large-v3",
```

The helper rereads this file on every request, so no restart is needed. Examples to try:

| Try | provider | model |
| --- | --- | --- |
| Faster, cheaper Whisper | `hf-inference` | `openai/whisper-large-v3-turbo` |

To see which providers host a model, open the model's page on Hugging Face and look at **Inference Providers** on the right. The helper is built for the `hf-inference` provider. Other providers (such as fal-ai) use a different address and request shape, so they need a small change in `ai_client.py`. If a provider refuses, the error appears in the prototype and in the log.

`"instructions"` holds the settings sent with each recording. `"return_timestamps": true` asks the model for time-stamped pieces. Remove it to get one block of text.

The note model lives under `"note"`:

```json
"note": { "enabled": true, "model": "claude-opus-5-5", "effort": "medium" }
```

Try `"model": "claude-sonnet-5-5"` or `"claude-haiku-5-5"` for faster, cheaper drafts, or `"effort": "high"` for more careful ones. Set `"enabled": false` to keep the sample note. To change what the model is asked to do, edit `backend/prompts/draft-note.md`.

`"location"` (set to `"Chicago, Illinois"`) tells the model where the agency works, so a misheard place such as "Enelwood" is written as Englewood. The note then shows a small **Heard as "Enelwood"** under the field, so the case manager can see what was changed. People's names are never corrected.

The key fields come from the note template in `simulated_responses.json` (`templates` → `intake_notes`). Fields marked `"required": true` become a flag when they are missing. The others (date of birth, release date, facility, supervision, referral source, consent forms and so on) are filled only when they were said. If they weren't, the note lists them under **Not mentioned**, and the case manager can add them by hand.

## The test log

Every AI request adds one line to `backend/logs/ai-log.jsonl`. Open it in any text editor (TextEdit, Notepad, VS Code). Each line is one event. The newest is at the bottom. Every line carries a `run` number: each upload starts a new run, so all the lines from one test share the same number.

**An AI request** (`"type": "ai_request"`) has a `step`: `"voice to text"` or `"draft note"`.

For **voice to text**:

- `input`: file name, type, size and length of the recording. The audio itself is not copied into the log.
- `request`: the address called, provider, model, and the instructions sent (for example `return_timestamps`).
- `output`: the full transcript and each time-stamped piece.
- `confidence`: Whisper does not return a confidence score, so this says `"not provided by this model"`.
- `error`: `null` when it worked. Otherwise the plain-language message and Hugging Face's own error text.
- `seconds` and `attempts`: how long the model took, and whether a second try was needed.

For **draft note**:

- `request`: model, effort, the full instructions (from `prompts/draft-note.md`), and the full input sent: the lists and every transcript line.
- `output`: the model's whole answer: the transcript split into speaker turns, key fields (each with an optional comment), needs, next steps.
- `confidence`: Claude gives no probability score. Instead, for each key field, the model labels itself `heard`, `partly heard` or `not said`. Those labels are listed here and are what turn into flags.
- `stop_reason`, `usage` (tokens in and out), `request_id`, `seconds`, and `error`.

**Review clicks** (`"type": "activity"`): every click the prototype already tracks in its Activity panel also lands here, with the client name and details. That covers uploads, flag fixes, field edits, need and step changes, suggestions accepted or declined, the review box, note approvals, update changes accepted or removed, Step 2 referrals, and the Real/Simulated switch.

This is not an agent. It makes two fixed calls per recording (voice to text, then the note), so there are no tool steps to record.

To start a fresh log, stop the helper, delete `ai-log.jsonl`, and start again. The `logs` folder is never uploaded to GitHub.

## Common problems

| You see | What to do |
| --- | --- |
| `Key: NOT FOUND` | The file must be named exactly `.env` and sit in the `backend` folder. Check the line starts with `HF_TOKEN=`. |
| "Hugging Face did not accept the key" | Copy the key again from Hugging Face. No spaces or quotes around it. |
| "The key is missing the … Inference Providers permission" | Create a new fine-grained token with that box ticked. |
| "out of credits" | Wait for next month's free credit or add billing at huggingface.co/settings/billing. |
| "The model is starting up or busy" | Wait a minute and try again. |
| "Note drafting failed: No Anthropic key" or "package is not installed" | Do steps 2b and 3b, then restart the helper. |
| "Your Anthropic account is out of credit" | Add credit at console.anthropic.com under Billing. |
| `Address already in use` | Another copy is running. Close that Terminal window, or run `PORT=8001 python3 backend/server.py` and open http://localhost:8001. |
| No **AI: Real** button in the grey bar | The page was opened without the helper. Start it as in step 4 and use http://localhost:8000. |

## Files in this folder

| File | What it is | Shared on GitHub? |
| --- | --- | --- |
| `server.py` | The helper. Shows the prototype, passes recordings to the model, writes the log. | Yes |
| `ai_client.py` | The functions that call the AI models: `transcribe()`, `draft_note()` and `read_document()`. | Yes |
| `prompts/draft-note.md` | The instructions the note model gets. | Yes |
| `prompts/read-document.md` | The instructions the document reader gets. It only copies what is printed; the prototype does the comparing. | Yes |
| `ai-config.json` | Providers, models, instructions, and the real/simulated setting. | Yes |
| `.env.example` | Shows teammates what to put in their own `.env`. | Yes |
| `.env` | Your keys. | **Never** |
| `logs/ai-log.jsonl` | Your test log. | No |
