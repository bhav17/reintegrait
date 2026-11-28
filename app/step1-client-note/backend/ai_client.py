"""The one place the prototype talks to a real AI model.

transcribe() sends one audio recording to the speech-to-text model named in
ai-config.json and returns the text with time stamps. To try another model or
provider, edit ai-config.json. Nothing here needs to change for that.

draft_update() sends a case manager's typed notes for an existing client to a
real language model and gets back a summary and a list of case-file changes,
so the output is grounded in what was actually typed instead of a canned
sample. It flags anything said by someone other than the client, or anything
unclear, instead of writing it in as a confirmed fact.
"""
import base64
import datetime
import json
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

FRIENDLY_HTTP_ERRORS = {
    400: "The model could not read this request. The audio format may not be supported. Try MP3 or WAV.",
    401: "Hugging Face did not accept the key. Check HF_TOKEN in backend/.env.",
    403: "The key is missing the 'Make calls to Inference Providers' permission. Create a new token with it ticked.",
    404: "Hugging Face does not know this provider or model. Check provider and model in ai-config.json.",
    402: "Your Hugging Face account is out of credits for this month.",
    413: "The recording is too large for this model. Try a shorter clip.",
    429: "Too many requests. Wait a minute and try again.",
    503: "The model is starting up or busy. Wait a minute and try again.",
}


# Whisper on Hugging Face takes WAV, FLAC, MP3, OGG and WebM, but not the .m4a/.mp4/.aac files
# that iPhone voice memos and the Mac `say` command make. Those are converted to 16 kHz mono WAV first.
NEEDS_CONVERSION = {"audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/x-aac", "video/mp4",
                    "audio/quicktime", "video/quicktime", "audio/x-caf", "audio/3gpp", "audio/amr"}
CONVERT_EXTENSIONS = (".m4a", ".mp4", ".aac", ".caf", ".mov", ".3gp", ".amr")


def needs_conversion(content_type, file_name=""):
    ctype = (content_type or "").split(";")[0].strip().lower()
    return ctype in NEEDS_CONVERSION or (ctype in ("", "application/octet-stream") and
                                          (file_name or "").lower().endswith(CONVERT_EXTENSIONS))


def to_wav(audio_bytes, file_name="recording.m4a"):
    """Convert a recording to 16 kHz mono WAV with afconvert (built into macOS) or ffmpeg."""
    suffix = Path(file_name).suffix or ".m4a"
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / f"in{suffix}", Path(tmp) / "out.wav"
        src.write_bytes(audio_bytes)
        if shutil.which("afconvert"):
            cmd = ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(src), str(dst)]
        elif shutil.which("ffmpeg"):
            cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", str(dst)]
        else:
            raise AIError("This recording is .m4a, which Whisper can't read, and there is no converter on this "
                          "computer. On a Mac this works without installing anything; elsewhere install ffmpeg, "
                          "or upload MP3 or WAV.")
        try:
            subprocess.run(cmd, capture_output=True, check=True, timeout=120)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            raise AIError("The recording could not be converted to WAV for Whisper.", None,
                          (getattr(e, "stderr", b"") or b"").decode("utf-8", "replace")[:300])
        return dst.read_bytes()


def calendar_lines(today, days_back=35, days_ahead=21):
    """A short calendar around the meeting date, so weekdays and dates can be checked against each other."""
    start = today - datetime.timedelta(days=days_back)
    return ", ".join(f"{(start + datetime.timedelta(days=i)).strftime('%a %Y-%m-%d')}"
                     for i in range(days_back + days_ahead + 1))


def meeting_date(value=None):
    """The meeting date as a date: the value given (YYYY-MM-DD) or today."""
    try:
        return datetime.date.fromisoformat(str(value)[:10]) if value else datetime.date.today()
    except ValueError:
        return datetime.date.today()


class AIError(Exception):
    """A failed AI call, with a message a non-technical tester can act on."""

    def __init__(self, message, status=None, detail=""):
        super().__init__(message)
        self.status = status
        self.detail = detail


def _post(url, token, body, content_type, timeout):
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise AIError(FRIENDLY_HTTP_ERRORS.get(e.code, f"Hugging Face returned error {e.code}."), e.code, detail)
    except urllib.error.URLError as e:
        raise AIError("Could not reach Hugging Face. Check the internet connection.", None, str(e.reason))
    except TimeoutError:
        raise AIError(f"The model took longer than {timeout} seconds. Try a shorter clip.", None, "timeout")
    except json.JSONDecodeError:
        raise AIError("Hugging Face sent back something that is not JSON.", None, "")


def transcribe(audio_bytes, content_type, config, token, file_name=""):
    """Send one recording to the configured model.

    Returns a dict:
      request  what was sent (endpoint, provider, model, instructions), without the audio itself
      text     the full transcript
      segments [{start, end, text}] time-stamped pieces (empty if the model gave none)
      confidence  the model's confidence score, or None (Whisper does not return one)
      attempts how many calls were made (a second one happens only if timestamps were refused)
      seconds  how long the model took
    Raises AIError on failure.
    """
    if not token:
        raise AIError("No key found. Copy backend/.env.example to backend/.env and paste your Hugging Face key.")
    provider, model = config["provider"], config["model"]
    url = config["endpoint"].format(provider=provider, model=model)
    instructions = config.get("instructions", {})
    timeout = int(config.get("timeout_seconds", 180))
    request = {"endpoint": url, "provider": provider, "model": model, "instructions": instructions}
    if needs_conversion(content_type, file_name):
        audio_bytes = to_wav(audio_bytes, file_name or "recording.m4a")
        request["converted"] = f"{content_type or 'unknown type'} converted to 16 kHz mono WAV before sending"
        content_type = "audio/wav"

    started = time.time()
    attempts = 1
    if instructions:
        # JSON form: the audio as base64 text, plus the instructions (e.g. return_timestamps).
        body = json.dumps({"inputs": base64.b64encode(audio_bytes).decode("ascii"), "parameters": instructions}).encode()
        try:
            out = _post(url, token, body, "application/json", timeout)
        except AIError as e:
            if e.status not in (400, 415, 422):
                raise
            # Some providers only take plain audio. Try once more without instructions.
            attempts = 2
            request["retried_without_instructions"] = f"first try refused ({e.status}): {e.detail[:200]}"
            out = _post(url, token, audio_bytes, content_type, timeout)
    else:
        out = _post(url, token, audio_bytes, content_type, timeout)

    if not isinstance(out, dict) or "text" not in out:
        raise AIError("The model answered, but without a transcript.", None, json.dumps(out)[:500])
    segments = []
    for c in out.get("chunks") or []:
        ts = c.get("timestamp") or [None, None]
        segments.append({"start": ts[0], "end": ts[1], "text": (c.get("text") or "").strip()})
    return {
        "request": request,
        "text": out["text"].strip(),
        "segments": segments,
        "confidence": out.get("score") or out.get("confidence"),
        "attempts": attempts,
        "seconds": round(time.time() - started, 1),
    }


# ---------------------------------------------------------------------------
# Step 2 of the AI: draft the note from the transcript (Claude, Anthropic API).
# Needs the Anthropic Python SDK:  python3 -m pip install anthropic
# The instructions live in prompts/draft-note.md so the class can read and edit them.
# ---------------------------------------------------------------------------
PROMPTS = Path(__file__).resolve().parent / "prompts"

FIELD_STATUS = ["heard", "partly heard", "not said"]
SPEAKERS = ["Case manager", "Client", "Other", "Unclear"]


def _key(f):
    """A key field is either a plain key ("age") or {key, label, type, options} from the template."""
    return f["key"] if isinstance(f, dict) else f


def _describe(f):
    if not isinstance(f, dict):
        return f"- {f}"
    line = f"- {f['key']}: {f.get('label', f['key'])}"
    if f.get("type") == "date":
        line += " (a date, written YYYY-MM-DD)"
    if f.get("options"):
        line += f" (one of: {', '.join(f['options'])})"
    return line


def note_schema(lists):
    """JSON schema the model's answer must follow. Lists come from simulated_responses.json templates."""
    def obj(props):
        return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}
    # One list entry per key field (not one property per field): a schema with many fields
    # otherwise becomes too large for the API ("compiled grammar is too large").
    field = obj({"key": {"type": "string", "enum": [_key(k) for k in lists["key_fields"]]},
                 "value": {"type": "string"}, "status": {"type": "string", "enum": FIELD_STATUS},
                 "heard_as": {"type": "string"}, "comment": {"type": "string"}, "source_line": {"type": "string"}})
    return obj({
        "turns": {"type": "array", "items": obj({"id": {"type": "string"}, "line_id": {"type": "string"},
                                                  "speaker": {"type": "string", "enum": SPEAKERS},
                                                  "text": {"type": "string"}})},
        "key_info": {"type": "array", "items": field},
        "meeting_type": {"type": "string", "enum": lists["meeting_types"]},
        "immediate_needs": {"type": "array", "items": obj({
            "category": {"type": "string", "enum": lists["categories"]},
            "detail": {"type": "string"},
            "priority": {"type": "string", "enum": ["Urgent", "Soon", "Later"]},
            "service_type": {"type": "string", "enum": lists["service_types"]},
            "source_line": {"type": "string"}})},
        "next_steps": {"type": "array", "items": obj({
            "kind": {"type": "string", "enum": ["agreed", "suggested"]},
            "action": {"type": "string"},
            "owner": {"type": "string", "enum": ["Case manager", "Client", "Both"]},
            "due": {"type": "string"},
            "addresses": {"type": "array", "items": {"type": "string", "enum": lists["categories"]}},
            "source_line": {"type": "string"}})},
    })


def _cause_chain(e):
    """The underlying reasons behind a connection error, e.g. a certificate or proxy problem."""
    parts, seen = [], set()
    while e is not None and id(e) not in seen:
        seen.add(id(e))
        parts.append(f"{type(e).__name__}: {e}")
        e = e.__cause__ or e.__context__
    return " <- ".join(parts)[:800]


def _create(anthropic, client, model_setting, timeout_setting, **kw):
    """One call to Claude, with every failure turned into a message a tester can act on."""
    try:
        return client.beta.messages.create(
            # If a safety check declines the request, the API retries it on another model in the same call.
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kw)
    except anthropic.AuthenticationError as e:
        raise AIError("Anthropic did not accept the key. Check ANTHROPIC_API_KEY in backend/.env.", 401, str(e)[:300])
    except anthropic.PermissionDeniedError as e:
        raise AIError("This Anthropic key is not allowed to use this model.", 403, str(e)[:300])
    except anthropic.NotFoundError as e:
        raise AIError(f"Anthropic does not know this model. Check {model_setting} in ai-config.json.", 404, str(e)[:300])
    except anthropic.RateLimitError as e:
        raise AIError("Too many requests, or the account is out of credit. Wait a minute or check billing.", 429, str(e)[:300])
    except anthropic.BadRequestError as e:
        msg = "Anthropic could not read the request."
        if "credit" in str(e).lower():
            msg = "Your Anthropic account is out of credit. Add credit at console.anthropic.com."
        raise AIError(msg, 400, str(e)[:300])
    except anthropic.APIStatusError as e:
        raise AIError(f"Anthropic returned error {e.status_code}. Try again in a minute.", e.status_code, str(e)[:300])
    except anthropic.APIConnectionError as e:
        cause = _cause_chain(e)
        msg = "Could not reach Anthropic. Check the internet connection."
        if "CERTIFICATE_VERIFY_FAILED" in cause:
            msg = ("Python could not check Anthropic's security certificate. On a Mac, open Finder > Applications > "
                   "Python 3.x and double-click 'Install Certificates.command', then restart the helper.")
        elif "timed out" in cause.lower() or "timeout" in cause.lower():
            msg = f"Anthropic took too long to answer. Try again, or raise {timeout_setting} in ai-config.json."
        raise AIError(msg, None, cause)


def _client(anthropic, api_key, config):
    # Ask for gzip only: some Python installs (e.g. Anaconda) carry an old brotli package that
    # breaks reading brotli-compressed answers ("unexpected keyword argument 'output_buffer_limit'").
    return anthropic.Anthropic(api_key=api_key, timeout=float(config.get("timeout_seconds", 180)),
                               default_headers={"Accept-Encoding": "gzip, deflate"})


def _anthropic(api_key):
    if not api_key:
        raise AIError("No Anthropic key found. Add ANTHROPIC_API_KEY to backend/.env, then restart the helper.")
    try:
        import anthropic
    except ImportError:
        raise AIError("The Anthropic package is not installed. In Terminal run: python3 -m pip install anthropic")
    return anthropic


def draft_note(lines, lists, config, api_key):
    """Ask Claude to draft the intake note from a transcript.

    lines  [{id, time, text}] from transcribe()
    lists  {key_fields, categories, service_types, meeting_types}
    Returns {request, note, stop_reason, usage, request_id, seconds}. Raises AIError on failure.
    """
    anthropic = _anthropic(api_key)
    instructions = (PROMPTS / "draft-note.md").read_text(encoding="utf-8")
    transcript = "\n".join(f"[{l['id']} {l['time']}] {l['text']}" for l in lines)
    location = config.get("location", "")
    day = meeting_date(config.get("meeting_date"))
    user = ((f"The agency works in: {location}\n" if location else "") +
            f"Meeting date (today, unless the recording says otherwise): {day.strftime('%A %Y-%m-%d')}\n"
            f"Calendar around it: {calendar_lines(day)}\n" +
            "Key fields:\n" + "\n".join(_describe(f) for f in lists["key_fields"]) + "\n"
            f"Need categories: {', '.join(lists['categories'])}\n"
            f"Service types: {', '.join(lists['service_types'])}\n\n"
            f"Transcript:\n{transcript}")
    model, effort = config["model"], config.get("effort", "medium")
    request = {"provider": "anthropic", "model": model, "effort": effort,
               "instructions": instructions, "input": user}

    client = _client(anthropic, api_key, config)
    started = time.time()
    resp = _create(anthropic, client, "note.model", "note.timeout_seconds",
                   model=model,
                   max_tokens=int(config.get("max_tokens", 16000)),
                   system=instructions,
                   messages=[{"role": "user", "content": user}],
                   output_config={"effort": effort, "format": {"type": "json_schema", "schema": note_schema(lists)}})
    seconds = round(time.time() - started, 1)
    usage = {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
    if resp.stop_reason == "refusal":
        raise AIError("The model declined to draft this note.", None, str(getattr(resp, "stop_details", "")))
    if resp.stop_reason == "max_tokens":
        raise AIError("The note was cut off before it finished. Raise note.max_tokens in ai-config.json.", None, "")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        note = json.loads(text)
    except json.JSONDecodeError:
        raise AIError("The model's answer was not valid JSON.", None, text[:300])
    # Turn the key field list back into {key: {...}}, the shape the prototype and the log use.
    if isinstance(note.get("key_info"), list):
        note["key_info"] = {f.pop("key"): f for f in note["key_info"] if isinstance(f, dict) and f.get("key")}
    return {"request": request, "note": note, "stop_reason": resp.stop_reason, "usage": usage,
            "request_id": getattr(resp, "_request_id", None), "seconds": seconds}


# ---------------------------------------------------------------------------
# Verify with a document: read a photo or PDF of release papers, an ID or a letter.
# The instructions live in prompts/read-document.md. The prototype compares the values
# with the note itself, so the model only reads; it never decides what is right.
# ---------------------------------------------------------------------------
DOCUMENT_TYPES = ["Release papers", "State ID", "Birth certificate", "Social Security card", "Benefits letter",
                  "Signed consent form", "Release of information", "Other"]
IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]


def document_schema(fields):
    def obj(props):
        return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}
    return obj({
        "readable": {"type": "boolean"},
        "document_type": {"type": "string", "enum": DOCUMENT_TYPES},
        "document_number": {"type": "string"},
        "issued_by": {"type": "string"},
        "fields": {"type": "array", "items": obj({
            "key": {"type": "string", "enum": [_key(f) for f in fields]},
            "value": {"type": "string"},
            "printed_as": {"type": "string"}})},
        "comment": {"type": "string"},
    })


def read_document(data_b64, media_type, fields, config, api_key):
    """Ask Claude to read one document.

    data_b64    the file as base64 (a photo or a PDF)
    media_type  image/jpeg, image/png, image/webp, image/gif or application/pdf
    fields      [{key, label, type, options}] the key fields to look for
    Returns {request, document, stop_reason, usage, request_id, seconds}. Raises AIError on failure.
    """
    anthropic = _anthropic(api_key)
    if media_type == "application/pdf":
        block = {"type": "document", "source": {"type": "base64", "media_type": media_type, "data": data_b64}}
    elif media_type in IMAGE_TYPES:
        block = {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data_b64}}
    else:
        raise AIError("This file type can't be read. Use a photo (JPG or PNG) or a PDF.")
    instructions = (PROMPTS / "read-document.md").read_text(encoding="utf-8")
    ask = ("Key fields to look for:\n" + "\n".join(_describe(f) for f in fields) +
           f"\nDocument types: {', '.join(DOCUMENT_TYPES)}")
    model, effort = config["model"], config.get("effort", "low")
    request = {"provider": "anthropic", "model": model, "effort": effort, "instructions": instructions,
               "input": ask, "file": {"media_type": media_type, "note": "The document itself is not stored in this log."}}

    client = _client(anthropic, api_key, config)
    started = time.time()
    resp = _create(anthropic, client, "document.model", "document.timeout_seconds",
                   model=model,
                   max_tokens=int(config.get("max_tokens", 4000)),
                   system=instructions,
                   messages=[{"role": "user", "content": [block, {"type": "text", "text": ask}]}],
                   output_config={"effort": effort, "format": {"type": "json_schema", "schema": document_schema(fields)}})
    seconds = round(time.time() - started, 1)
    usage = {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
    if resp.stop_reason == "refusal":
        raise AIError("The model declined to read this document.", None, str(getattr(resp, "stop_details", "")))
    if resp.stop_reason == "max_tokens":
        raise AIError("The answer was cut off. Raise document.max_tokens in ai-config.json.", None, "")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        doc = json.loads(text)
    except json.JSONDecodeError:
        raise AIError("The model's answer was not valid JSON.", None, text[:300])
    return {"request": request, "document": doc, "stop_reason": resp.stop_reason, "usage": usage,
            "request_id": getattr(resp, "_request_id", None), "seconds": seconds}


# ---------------------------------------------------------------------------
# Grant report narrative. report_draft.py builds the request and checks the answer;
# this function only makes the call. The instructions live in prompts/grant-report.md.
# ---------------------------------------------------------------------------
def report_schema():
    return {"type": "object", "additionalProperties": False, "required": ["sections"],
            "properties": {"sections": {"type": "array", "items": {
                "type": "object", "additionalProperties": False, "required": ["key", "text"],
                "properties": {"key": {"type": "string"}, "text": {"type": "string"}}}}}}


def draft_report_call(system, user, config, api_key):
    """One call to Claude for the report narrative. Returns {sections, model, usage, request_id, stop_reason, seconds}."""
    anthropic = _anthropic(api_key)
    model, effort = config.get("model") or "claude-sonnet-5-5", config.get("effort", "medium")
    client = _client(anthropic, api_key, config)
    started = time.time()
    resp = _create(anthropic, client, "report.model", "report.timeout_seconds",
                   model=model,
                   max_tokens=int(config.get("max_tokens", 8000)),
                   system=system,
                   messages=[{"role": "user", "content": user}],
                   output_config={"effort": effort, "format": {"type": "json_schema", "schema": report_schema()}})
    seconds = round(time.time() - started, 1)
    usage = {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
    if resp.stop_reason == "refusal":
        raise AIError("The model declined to draft the report.", None, str(getattr(resp, "stop_details", "")))
    if resp.stop_reason == "max_tokens":
        raise AIError("The draft was cut off. Raise report.max_tokens in ai-config.json.", None, "")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        out = json.loads(text)
    except json.JSONDecodeError:
        raise AIError("The model's answer was not valid JSON.", None, text[:300])
    return {"sections": out.get("sections") or [], "model": getattr(resp, "model", model), "usage": usage,
            "request_id": getattr(resp, "_request_id", None), "stop_reason": resp.stop_reason, "seconds": seconds}


ANTHROPIC_HTTP_ERRORS = {
    400: "The model could not read this request.",
    401: "Anthropic did not accept the key. Check ANTHROPIC_API_KEY in backend/.env.",
    403: "This key does not have access to that model.",
    404: "Unknown model. Check ANTHROPIC_MODEL in backend/.env.",
    413: "The notes are too long for one request.",
    429: "Too many requests. Wait a minute and try again.",
    529: "Anthropic is overloaded. Wait a minute and try again.",
}

DRAFT_SYSTEM_PROMPT = """You are helping a case manager at a reentry organization keep a client's case file accurate. You are given the case manager's own typed notes from a check-in call or visit, plus the client's current open needs. Summarize only what is in the notes. You never invent facts that are not in the notes.

List the changes this update makes to the case file. For each change: if it updates an existing open need, set "from" to that need's exact current text (match it from the list given) and "to" to the new text; if it's a new need or a next step, leave "from" empty.

If a sentence is clearly said by someone other than the client (a family member, someone overheard in the background) or is unclear or inaudible, set "flagged": true on that change and give a one-phrase "flag_reason" explaining why it needs confirming, instead of writing it in as a confirmed fact about the client. Never flag something as true that is only hearsay.

Dates: the message gives the date of this update and a calendar. Work out dates such as "Thursday" or "this Sunday" from it and write them as dates (for example "Thu Nov 19"). If a weekday and a date said together do not match the calendar (for example "Sunday the 30th" when the 30th is a Monday), set "flagged": true and say so in "flag_reason".

A next step the case manager says they will do ("I'll call the shelter line") is a next step even if the client only says "okay".

Respond with ONLY valid JSON (no markdown fences, no commentary), matching exactly this shape:
{
  "summary": "one or two plain sentences summarizing the update",
  "changes": [
    {
      "kind": "add" | "change",
      "field": "need" | "note",
      "label": "short label, e.g. Medication or Next step",
      "from": "",
      "to": "the new value",
      "flagged": false,
      "flag_reason": ""
    }
  ]
}
If nothing changed, return an empty changes array."""


def draft_update(text, client, update_type, token, model, meeting=None):
    """Send a case manager's typed update to a real language model.

    Returns a dict: model, summary, changes (list of dicts matching the
    shape in DRAFT_SYSTEM_PROMPT), seconds. Raises AIError on failure.
    """
    if not token:
        raise AIError("No key found. Copy backend/.env.example to backend/.env and paste your Anthropic key.")
    needs = client.get("openNeeds") or []
    day = meeting_date(meeting)
    user_content = (
        f"Date of this update: {day.strftime('%A %Y-%m-%d')}. Calendar around it: {calendar_lines(day, 14, 21)}\n"
        f"Client: {client.get('name', 'Unknown')}, age {client.get('age', 'unknown')}. "
        f"Update type: {update_type}.\n"
        f"Current open needs: {', '.join(needs) if needs else 'none on file'}.\n\n"
        f"Case manager's typed notes:\n{text}"
    )
    body = json.dumps({
        "model": model,
        "max_tokens": 4096,
        "system": DRAFT_SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_content}],
    }).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST", headers={
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Accept": "application/json",
    })
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise AIError(ANTHROPIC_HTTP_ERRORS.get(e.code, f"Anthropic returned error {e.code}."), e.code, detail)
    except urllib.error.URLError as e:
        raise AIError("Could not reach Anthropic. Check the internet connection.", None, str(e.reason))
    except TimeoutError:
        raise AIError("The model took longer than 120 seconds.", None, "timeout")
    except json.JSONDecodeError:
        raise AIError("Anthropic sent back something that is not JSON.", None, "")

    if out.get("stop_reason") == "max_tokens":
        raise AIError("The update was cut off before it finished. The notes may be too long for one update.", None, "")
    raw = "".join(b.get("text", "") for b in out.get("content", []) if b.get("type") == "text")
    candidate = raw.split("```")[1] if "```" in raw else raw
    if candidate.lstrip().startswith("json"):
        candidate = candidate.lstrip()[4:]
    try:
        parsed = json.loads(candidate.strip())
    except json.JSONDecodeError:
        raise AIError("The model answered, but not in the expected format.", None, raw[:500])

    if not isinstance(parsed, dict) or not isinstance(parsed.get("summary"), str) \
            or not isinstance(parsed.get("changes"), list):
        raise AIError("The model's answer was missing summary or changes.", None, json.dumps(parsed)[:500])

    return {
        "model": model,
        "summary": parsed["summary"],
        "changes": [c for c in parsed["changes"] if isinstance(c, dict)],
        "seconds": round(time.time() - started, 1),
    }
