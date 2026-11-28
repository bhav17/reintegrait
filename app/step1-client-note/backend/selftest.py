"""Start-up self-test: one tiny call to each AI model the helper is set to use.

It runs in the background when the helper starts, so a missing key, an empty account or a cold
speech model shows up in the Terminal before the demo, not in front of the room. It also warms up
the speech model, which can take a minute to start on Hugging Face.

    python3 backend/server.py            runs it in the background and prints the results
    python3 backend/server.py --check    runs it, prints the results and stops

Cost: one second of silence to the speech model, and a one-word request (a few hundred tokens with
thinking) to each Claude model in ai-config.json. The results are also at /api/status under "selftest"
and in the grey bar of the prototype.
"""
import io
import time
import wave
from datetime import datetime

import ai_client

LAST = {"state": "not run", "results": []}


def _silence_wav(seconds=1, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * rate * seconds)
    return buf.getvalue()


def _claude_ping(model, api_key, config):
    anthropic = ai_client._anthropic(api_key)
    client = ai_client._client(anthropic, api_key, {**config, "timeout_seconds": 60})
    resp = ai_client._create(anthropic, client, "the model setting", "timeout_seconds",
                             model=model, max_tokens=2000,
                             messages=[{"role": "user", "content": "Reply with the single word: ready"}],
                             output_config={"effort": "low"})
    if resp.stop_reason == "refusal":
        raise ai_client.AIError("The model declined the test request.")


def run(cfg, env, report=print):
    """Check each model. Returns [{step, model, ok, message, seconds}]."""
    LAST.update(state="running", results=[], started=datetime.now().isoformat(timespec="seconds"))
    results = []

    def record(step, model, fn):
        t = time.time()
        try:
            fn()
            r = {"step": step, "model": model, "ok": True, "message": "ready"}
        except ai_client.AIError as e:
            r = {"step": step, "model": model, "ok": False, "message": str(e)}
        except Exception as e:  # anything unexpected still gets reported, never crashes the helper
            r = {"step": step, "model": model, "ok": False, "message": f"{type(e).__name__}: {e}"}
        r["seconds"] = round(time.time() - t, 1)
        results.append(r)
        report(f"  {'✓' if r['ok'] else '✗'} Self-test, {step} ({model}): {r['message']} [{r['seconds']} s]")

    if cfg.get("mode") != "real":
        LAST.update(state="skipped", results=[], note="Simulated mode: no model is called.")
        report("  Self-test skipped: ai-config.json is in simulated mode.")
        return []

    record("voice to text", cfg.get("model"),
           lambda: ai_client.transcribe(_silence_wav(), "audio/wav", cfg, env.get("HF_TOKEN", ""), "selftest.wav"))

    # One ping per distinct Claude model among the steps that are turned on.
    steps = {}
    for key, label in (("note", "note"), ("document", "document reading"), ("report", "grant report")):
        part = cfg.get(key) or {}
        if part.get("enabled") and part.get("model"):
            steps.setdefault(part["model"], []).append(label)
    for model, labels in steps.items():
        record(", ".join(labels), model, lambda m=model: _claude_ping(m, env.get("ANTHROPIC_API_KEY", ""), cfg.get("note") or {}))

    failed = [r for r in results if not r["ok"]]
    LAST.update(state="failed" if failed else "passed", results=results,
                finished=datetime.now().isoformat(timespec="seconds"))
    report("  Self-test: " + ("all models ready." if not failed else
                              f"{len(failed)} of {len(results)} not ready. Fix these before the demo, or use the Class demo cases."))
    return results
