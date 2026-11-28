"""Small helper that runs on your laptop.

It does four things:
  1. Shows the prototype at http://localhost:8000
  2. Passes recordings to the real AI model (see ai_client.py and ai-config.json)
  3. Writes every AI request, answer, error and review click to logs/ai-log.jsonl
  4. Keeps the shared case file (data/case-file.db) that the Grant report is counted from

Start it from the step1-client-note folder with:  python3 backend/server.py
Uses only what comes with Python 3, so there is nothing to install.
"""
import json
import mimetypes
import os
import sys
import threading
import urllib.parse
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import importlib.util

from ai_client import AIError, draft_note, draft_update, read_document, transcribe
import grant_report
import report_draft
from case_store import CaseStore

HERE = Path(__file__).resolve().parent          # backend/
SITE = HERE.parent                              # step1-client-note/ (the prototype)
CONFIG = HERE / "ai-config.json"
ENV = HERE / ".env"
LOG = HERE / "logs" / "ai-log.jsonl"
PORT = int(os.environ.get("PORT", "8000"))
MAX_UPLOAD = 100 * 1024 * 1024                  # 100 MB
DEFAULT_DRAFT_MODEL = "claude-sonnet-5-5"       # typed updates, when ANTHROPIC_MODEL is blank
_log_lock = threading.Lock()
CASE_FILE = HERE / "data" / "case-file.db"
_store = None


def store():
    global _store
    if _store is None:
        _store = CaseStore(CASE_FILE)
    return _store


def shared_case_file_on():
    """The shared case file holds client records, so it is only on when the helper runs on this laptop
    (the default), or when whoever hosts it turns it on with SHARED_CASE_FILE=on."""
    host = os.environ.get("HOST", "127.0.0.1")
    return host in ("127.0.0.1", "localhost") or os.environ.get("SHARED_CASE_FILE") == "on"


def read_env():
    """Read KEY=value lines from backend/.env. The key is never printed or logged."""
    values = {}
    if ENV.exists():
        for line in ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def read_config():
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def write_log(entry):
    """Add one line to logs/ai-log.jsonl."""
    entry = {"time": datetime.now().isoformat(timespec="seconds"), **entry}
    LOG.parent.mkdir(exist_ok=True)
    with _log_lock, LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _run(v):
    """Run number sent by the prototype: one per upload, so its log lines group together."""
    try:
        return int(v) or None
    except (TypeError, ValueError):
        return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    # ---- the prototype's files ----
    def send_head(self):
        # Never serve the helper's own folder (.env, logs) or any hidden file.
        path = urllib.parse.unquote(self.path.split("?")[0].split("#")[0]).replace("\\", "/")
        parts = [p for p in path.split("/") if p]
        if (parts and parts[0].lower() == "backend") or any(p.startswith(".") for p in parts):
            self.send_error(404)
            return None
        return super().send_head()

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet; AI calls print their own one-line summary

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            raise ValueError("too large")
        return self.rfile.read(n)

    def do_GET(self):
        if self.path.startswith("/api/status"):
            cfg = read_config()
            return self._json(200, {"helper": True, "mode": cfg.get("mode", "simulated"),
                                    "provider": cfg.get("provider"), "model": cfg.get("model"),
                                    "key_found": bool(read_env().get("HF_TOKEN")),
                                    "draft_key_found": bool(read_env().get("ANTHROPIC_API_KEY")),
                                    "draft_model": read_env().get("ANTHROPIC_MODEL") or DEFAULT_DRAFT_MODEL,
                                    "note": note_status(cfg), "document": document_status(cfg),
                                    "report": report_status(cfg), "shared_case_file": shared_case_file_on()})
        return super().do_GET()

    def do_POST(self):
        try:
            body = self._body()
        except ValueError:
            return self._json(413, {"ok": False, "error": "File is over 100 MB."})
        if self.path.startswith("/api/transcribe"):
            return self._transcribe(body)
        if self.path.startswith("/api/draft-update"):
            return self._draft_update(body)
        if self.path.startswith("/api/draft-note"):
            return self._draft_note(body)
        if self.path.startswith("/api/read-document"):
            return _read_document_handler(self, body)
        if self.path.startswith("/api/records/sync"):
            return _sync_handler(self, body)
        if self.path.startswith("/api/report/metrics"):
            return _report_metrics_handler(self, body)
        if self.path.startswith("/api/report/draft"):
            return _report_draft_handler(self, body)
        if self.path.startswith("/api/log"):
            try:
                ev = json.loads(body or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"ok": False})
            write_log({"run": _run(ev.get("run")), "type": "activity", "client": ev.get("client", ""),
                       "event": ev.get("event", ""), "detail": ev.get("detail", "")})
            return self._json(200, {"ok": True})
        self.send_error(404)

    def _draft_note(self, body):
        return _draft_note_handler(self, body)

    def _transcribe(self, audio):
        cfg = read_config()
        name = self.headers.get("X-File-Name", "recording")
        ctype = self.headers.get("Content-Type") or mimetypes.guess_type(name)[0] or "application/octet-stream"
        entry = {"run": _run(self.headers.get("X-Run")), "type": "ai_request", "step": "voice to text",
                 "input": {"file_name": name, "content_type": ctype, "size_bytes": len(audio),
                           "duration": self.headers.get("X-Audio-Duration", ""),
                           "note": "The audio itself is not stored in this log."}}
        if cfg.get("mode") != "real":
            entry.update(mode="simulated", output="Simulated mode: no model was called.")
            write_log(entry)
            return self._json(200, {"ok": False, "mode": "simulated", "error": "Simulated mode is on in ai-config.json."})
        try:
            r = transcribe(audio, ctype, cfg, read_env().get("HF_TOKEN", ""), name)
        except AIError as e:
            entry.update(mode="real", request={"endpoint": cfg.get("endpoint", "").format(provider=cfg.get("provider"), model=cfg.get("model")),
                                               "provider": cfg.get("provider"), "model": cfg.get("model"),
                                               "instructions": cfg.get("instructions", {})},
                         error={"message": str(e), "status": e.status, "detail": e.detail})
            write_log(entry)
            print(f"  ✗ AI error: {e}", flush=True)
            return self._json(200, {"ok": False, "mode": "real", "error": str(e)})
        entry.update(mode="real", request=r["request"],
                     output={"text": r["text"], "segments": r["segments"]},
                     confidence=r["confidence"] if r["confidence"] is not None else "not provided by this model",
                     attempts=r["attempts"], seconds=r["seconds"], error=None)
        write_log(entry)
        print(f"  ✓ {r['request']['model']} transcribed {name} in {r['seconds']} s "
              f"({len(r['segments'])} time-stamped pieces)", flush=True)
        return self._json(200, {"ok": True, "mode": "real", "model": r["request"]["model"],
                                "provider": r["request"]["provider"], "text": r["text"],
                                "segments": r["segments"], "seconds": r["seconds"]})

    def _draft_update(self, body):
        cfg = read_config()
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"ok": False, "error": "Invalid request body."})
        text = (payload.get("text") or "").strip()
        client = payload.get("client") or {}
        update_type = payload.get("type") or ""
        if not text:
            return self._json(400, {"ok": False, "error": "text is required."})
        entry = {"type": "ai_request", "step": "draft update",
                 "input": {"client": client.get("name", ""), "update_type": update_type,
                           "typed_notes": text}}
        if cfg.get("mode") != "real":
            entry.update(mode="simulated", output="Simulated mode: no model was called.")
            write_log(entry)
            return self._json(200, {"ok": False, "mode": "simulated", "error": "Simulated mode is on in ai-config.json."})
        model = read_env().get("ANTHROPIC_MODEL") or DEFAULT_DRAFT_MODEL
        try:
            r = draft_update(text, client, update_type, read_env().get("ANTHROPIC_API_KEY", ""), model,
                             payload.get("date") or "")
        except AIError as e:
            entry.update(mode="real", error={"message": str(e), "status": e.status, "detail": e.detail})
            write_log(entry)
            print(f"  ✗ AI error (draft update): {e}", flush=True)
            return self._json(200, {"ok": False, "mode": "real", "error": str(e)})
        entry.update(mode="real", output={"summary": r["summary"], "changes": r["changes"]},
                     model=r["model"], seconds=r["seconds"], error=None)
        write_log(entry)
        print(f"  ✓ {r['model']} drafted update for {client.get('name', '?')} in {r['seconds']} s "
              f"({len(r['changes'])} changes)", flush=True)
        return self._json(200, {"ok": True, "mode": "real", "model": r["model"],
                                "summary": r["summary"], "changes": r["changes"], "seconds": r["seconds"]})


def note_status(cfg):
    n = cfg.get("note") or {}
    return {"enabled": bool(n.get("enabled")) and cfg.get("mode") == "real", "model": n.get("model"),
            "key_found": bool(read_env().get("ANTHROPIC_API_KEY")),
            "sdk_installed": importlib.util.find_spec("anthropic") is not None}


def _draft_note_handler(handler, body):
    cfg = read_config()
    ncfg = cfg.get("note") or {}
    try:
        req = json.loads(body or b"{}")
    except json.JSONDecodeError:
        return handler._json(400, {"ok": False, "error": "Bad request."})
    lines, lists = req.get("lines") or [], req.get("lists") or {}
    entry = {"run": _run(req.get("run")), "type": "ai_request", "step": "draft note",
             "input": {"transcript_lines": len(lines), "note": "The full transcript sent is under request.input."}}
    if not note_status(cfg)["enabled"]:
        entry.update(mode="simulated", output="Note drafting is off in ai-config.json. The sample note was used.")
        write_log(entry)
        return handler._json(200, {"ok": False, "mode": "simulated", "error": "Note drafting is off in ai-config.json."})
    try:
        r = draft_note(lines, lists, {**ncfg, "meeting_date": req.get("meeting_date") or ""}, read_env().get("ANTHROPIC_API_KEY", ""))
    except AIError as e:
        entry.update(mode="real", request={"provider": ncfg.get("provider"), "model": ncfg.get("model"),
                                           "effort": ncfg.get("effort")},
                     error={"message": str(e), "status": e.status, "detail": e.detail})
        write_log(entry)
        print(f"  ✗ Note draft error: {e}", flush=True)
        return handler._json(200, {"ok": False, "mode": "real", "error": str(e)})
    certainty = {k: v.get("status") for k, v in (r["note"].get("key_info") or {}).items()}
    entry.update(mode="real", request=r["request"], output=r["note"],
                 confidence={"note": "No probability score. This is the model's own label for each key field.",
                             "fields": certainty},
                 stop_reason=r["stop_reason"], usage=r["usage"], request_id=r["request_id"],
                 seconds=r["seconds"], error=None)
    write_log(entry)
    print(f"  ✓ {r['request']['model']} drafted the note in {r['seconds']} s "
          f"({len(r['note'].get('immediate_needs') or [])} needs, {len(r['note'].get('next_steps') or [])} steps)", flush=True)
    return handler._json(200, {"ok": True, "model": r["request"]["model"], "note": r["note"], "seconds": r["seconds"]})


def document_config(cfg):
    """The document reader uses the "document" part of ai-config.json, or the note settings if it is missing."""
    return {**(cfg.get("note") or {}), "effort": "low", "max_tokens": 4000, **(cfg.get("document") or {})}


def document_status(cfg):
    d = document_config(cfg)
    return {"enabled": bool(d.get("enabled")) and cfg.get("mode") == "real", "model": d.get("model"),
            "key_found": bool(read_env().get("ANTHROPIC_API_KEY")),
            "sdk_installed": importlib.util.find_spec("anthropic") is not None}


def _read_document_handler(handler, body):
    cfg = read_config()
    dcfg = document_config(cfg)
    try:
        req = json.loads(body or b"{}")
    except json.JSONDecodeError:
        return handler._json(400, {"ok": False, "error": "Bad request."})
    data, media_type = req.get("data") or "", req.get("media_type") or ""
    entry = {"run": _run(req.get("run")), "type": "ai_request", "step": "read document",
             "input": {"file_name": req.get("file_name", ""), "content_type": media_type,
                       "size_bytes": len(data) * 3 // 4, "client": req.get("client", ""),
                       "note": "The document itself is not stored in this log."}}
    if not document_status(cfg)["enabled"]:
        entry.update(mode="simulated", output="Document reading is off in ai-config.json.")
        write_log(entry)
        return handler._json(200, {"ok": False, "mode": "simulated", "error": "Document reading is off in ai-config.json."})
    try:
        r = read_document(data, media_type, req.get("fields") or [], dcfg, read_env().get("ANTHROPIC_API_KEY", ""))
    except AIError as e:
        entry.update(mode="real", request={"provider": "anthropic", "model": dcfg.get("model"), "effort": dcfg.get("effort")},
                     error={"message": str(e), "status": e.status, "detail": e.detail})
        write_log(entry)
        print(f"  ✗ Document read error: {e}", flush=True)
        return handler._json(200, {"ok": False, "mode": "real", "error": str(e)})
    doc = r["document"]
    entry.update(mode="real", request=r["request"], output=doc,
                 confidence={"note": "No probability score. readable is the model's own judgment.", "readable": doc.get("readable")},
                 stop_reason=r["stop_reason"], usage=r["usage"], request_id=r["request_id"], seconds=r["seconds"], error=None)
    write_log(entry)
    print(f"  ✓ {r['request']['model']} read {req.get('file_name', 'a document')} in {r['seconds']} s "
          f"({doc.get('document_type')}, {len(doc.get('fields') or [])} fields)", flush=True)
    return handler._json(200, {"ok": True, "model": r["request"]["model"], "document": doc, "seconds": r["seconds"]})


# ---------------------------------------------------------------------------
# Shared case file and the live grant report
# ---------------------------------------------------------------------------
def report_status(cfg):
    r = cfg.get("report") or {}
    return {"enabled": bool(r.get("enabled")) and cfg.get("mode") == "real", "model": r.get("model"),
            "key_found": bool(read_env().get("ANTHROPIC_API_KEY")),
            "sdk_installed": importlib.util.find_spec("anthropic") is not None}


def _sync_handler(handler, body):
    if not shared_case_file_on():
        return handler._json(403, {"ok": False, "error": "The shared case file is off on this server."})
    try:
        req = json.loads(body or b"{}")
        r = store().sync(req.get("device"), req.get("label"), req.get("records"))
    except (json.JSONDecodeError, ValueError, AttributeError) as e:
        return handler._json(400, {"ok": False, "error": f"Bad sync: {e}"})
    return handler._json(200, {"ok": True, **r})


def _report_request(handler, body):
    """Read {period, funder} and count the report from the shared case file. Returns (report, records) or None."""
    if not shared_case_file_on():
        handler._json(403, {"ok": False, "error": "The shared case file is off on this server."})
        return None
    try:
        req = json.loads(body or b"{}")
        R = store().load()
        rep = grant_report.compute(R, req.get("period"), req.get("funder"))
    except (json.JSONDecodeError, ValueError, AttributeError) as e:
        handler._json(400, {"ok": False, "error": f"Bad report request: {e}"})
        return None
    return req, rep, R


def _public(rep):
    return {k: v for k, v in rep.items() if k != "_s"}


def _report_metrics_handler(handler, body):
    got = _report_request(handler, body)
    if not got:
        return
    req, rep, R = got
    return handler._json(200, {"ok": True, **_public(rep), "devices": store().devices(),
                               "as_of": datetime.now().isoformat(timespec="seconds")})


def _report_draft_handler(handler, body):
    got = _report_request(handler, body)
    if not got:
        return
    req, rep, R = got
    cfg = read_config()
    rcfg = cfg.get("report") or {}
    funder = req.get("funder")
    facts = grant_report.facts(rep["_s"])
    entry = {"type": "ai_request", "step": "draft grant report",
             "input": {"funder": funder, "period": rep["_s"]["p"],
                       "note": "Only the counts below were sent. No names, notes or dates of birth.",
                       "placeholders": {k: v["value"] for k, v in facts.items()}}}
    if not report_status(cfg)["enabled"]:
        entry.update(mode="simulated", output="Report drafting is off in ai-config.json. The template draft was kept.")
        write_log(entry)
        return handler._json(200, {"ok": False, "mode": "simulated", "error": "Report drafting is off in ai-config.json."})
    try:
        r = report_draft.draft(rep, funder, R, rcfg, read_env().get("ANTHROPIC_API_KEY", ""))
    except AIError as e:
        entry.update(mode="real", request={"provider": "anthropic", "model": rcfg.get("model"), "effort": rcfg.get("effort")},
                     error={"message": str(e), "status": e.status, "detail": e.detail})
        write_log(entry)
        print(f"  ✗ Report draft error: {e}", flush=True)
        return handler._json(200, {"ok": False, "mode": "real", "error": str(e)})
    entry.update(mode="real", request={"model": rcfg.get("model"), "effort": rcfg.get("effort"), **r["request"]},
                 output={"raw_from_model": r["raw"], "filled": r["sections"]},
                 checks={"passed": r["ok"], "attempts": r["attempts"], "problems": r["problems"], "each_attempt": r["history"]},
                 usage=r["usage"], seconds=r["seconds"], error=None)
    write_log(entry)
    if not r["ok"]:
        print(f"  ✗ Report draft refused after {r['attempts']} tries: {'; '.join(r['problems'])}", flush=True)
        return handler._json(200, {"ok": False, "mode": "real", "model": r["model"], "problems": r["problems"],
                                   "error": "The AI draft did not pass the number and name checks, so the template draft was kept."})
    print(f"  ✓ {r['model']} drafted the grant report in {r['seconds']} s ({r['attempts']} tries, checks passed)", flush=True)
    return handler._json(200, {"ok": True, "mode": "real", "model": r["model"], "sections": r["sections"],
                               "attempts": r["attempts"], "seconds": r["seconds"]})


def main():
    cfg = read_config()
    key = bool(read_env().get("HF_TOKEN"))
    print("\nReintegrAIt prototype helper")
    print(f"  Open:     http://localhost:{PORT}")
    print(f"  AI mode:  {cfg.get('mode')}  ({cfg.get('provider')} · {cfg.get('model')})")
    print(f"  Key:      {'found in backend/.env' if key else 'NOT FOUND. Copy backend/.env.example to backend/.env and paste your key.'}")
    ns = note_status(cfg)
    if ns["enabled"]:
        problems = [m for ok, m in ((ns["key_found"], "add ANTHROPIC_API_KEY to backend/.env"),
                                    (ns["sdk_installed"], "run: python3 -m pip install anthropic")) if not ok]
        print(f"  Note:     {ns['model']} drafts the note" + (f" (to turn on: {'; '.join(problems)})" if problems else ""))
    else:
        print("  Note:     sample note (note drafting is off)")
    ds = document_status(cfg)
    if ds["enabled"]:
        problems = [m for ok, m in ((ds["key_found"], "add ANTHROPIC_API_KEY to backend/.env"),
                                    (ds["sdk_installed"], "run: python3 -m pip install anthropic")) if not ok]
        print(f"  Document: {ds['model']} reads documents" + (f" (to turn on: {'; '.join(problems)})" if problems else ""))
    else:
        print("  Document: sample documents only (document reading is off)")
    rs = report_status(cfg)
    if not shared_case_file_on():
        print("  Report:   shared case file is off on this server (set SHARED_CASE_FILE=on to turn it on)")
    elif rs["enabled"]:
        problems = [m for ok, m in ((rs["key_found"], "add ANTHROPIC_API_KEY to backend/.env"),
                                    (rs["sdk_installed"], "run: python3 -m pip install anthropic")) if not ok]
        print(f"  Report:   counted from {CASE_FILE.relative_to(SITE)}; {rs['model']} drafts the wording"
              + (f" (to turn on: {'; '.join(problems)})" if problems else ""))
    else:
        print(f"  Report:   counted from {CASE_FILE.relative_to(SITE)}; template wording (report drafting is off)")
    print(f"  Log file: {LOG.relative_to(SITE)}")
    print("  Stop:     press Control + C\n", flush=True)
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except OSError as e:
        sys.exit(f"Could not start on port {PORT} ({e}). Is another copy already running? Close it or run: PORT=8001 python3 backend/server.py")
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
