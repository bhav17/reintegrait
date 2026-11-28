"""The shared case file: every case manager's records in one SQLite file on the helper.

Each browser keeps its own copy in localStorage (so the prototype still works offline) and sends
the whole copy here when it changes. The grant report is then counted from this file, so it covers
every case manager instead of one laptop.

Sync rule: a browser's copy is the truth for the records it sent last. A sync from one browser adds
and updates its records and removes the ones it no longer has (for example after "Reset sample
data"). Records last sent by another browser are never touched.

Uses only Python's built-in sqlite3. The file is backend/data/case-file.db and is never uploaded
(see backend/.gitignore).
"""
import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

RECORD_TYPES = ["Client", "Interaction", "Need", "Service", "Goal", "Referral", "Approval", "Document", "Provider"]
_lock = threading.Lock()


class CaseStore:
    def __init__(self, path):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS records (
                type TEXT NOT NULL, id TEXT NOT NULL, device TEXT NOT NULL,
                data TEXT NOT NULL, updated_at TEXT NOT NULL,
                PRIMARY KEY (type, id));
            CREATE TABLE IF NOT EXISTS devices (
                device TEXT PRIMARY KEY, label TEXT, last_sync TEXT NOT NULL, records INTEGER NOT NULL);
        """)
        self.db.commit()

    def sync(self, device, label, records):
        """Replace this device's records with `records` ({type: [record, ...]}). Returns counts per type."""
        device = str(device or "").strip()[:80]
        if not device:
            raise ValueError("device is required")
        if not isinstance(records, dict):
            raise ValueError("records must be an object of record lists")
        now = datetime.now().isoformat(timespec="seconds")
        rows = []
        for t in RECORD_TYPES:
            items = records.get(t) or []
            if not isinstance(items, list):
                raise ValueError(f"{t} must be a list")
            for r in items:
                if isinstance(r, dict) and r.get("Id"):
                    rows.append((t, str(r["Id"]), device, json.dumps(r, ensure_ascii=False), now))
        with _lock:
            cur = self.db.cursor()
            cur.execute("DELETE FROM records WHERE device = ?", (device,))
            cur.executemany("INSERT OR REPLACE INTO records (type, id, device, data, updated_at) VALUES (?, ?, ?, ?, ?)", rows)
            cur.execute("INSERT OR REPLACE INTO devices (device, label, last_sync, records) VALUES (?, ?, ?, ?)",
                        (device, str(label or "")[:80], now, len(rows)))
            self.db.commit()
        counts = {t: 0 for t in RECORD_TYPES}
        for t, *_ in rows:
            counts[t] += 1
        return {"synced_at": now, "counts": counts}

    def clear(self):
        """Remove every record from every browser. Used by the demo reset."""
        with _lock:
            self.db.execute("DELETE FROM records")
            self.db.execute("DELETE FROM devices")
            self.db.commit()

    def load(self):
        """All records, {type: [record, ...]}, in the order they were first written."""
        out = {t: [] for t in RECORD_TYPES}
        with _lock:
            for t, data in self.db.execute("SELECT type, data FROM records ORDER BY rowid"):
                if t in out:
                    out[t].append(json.loads(data))
        return out

    def devices(self):
        with _lock:
            return [{"device": d, "label": l, "last_sync": s, "records": n}
                    for d, l, s, n in self.db.execute("SELECT device, label, last_sync, records FROM devices ORDER BY last_sync DESC")]
