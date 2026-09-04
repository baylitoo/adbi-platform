"""
Activity tracking — simple JSON-based log stored in data/activity.json.
Tracks: login, cv_upload, match_run events.
"""
import json
import threading
from datetime import datetime
from pathlib import Path

_lock = threading.Lock()
DATA_DIR = Path(__file__).parent.parent / "data"
ACTIVITY_FILE = DATA_DIR / "activity.json"
MAX_EVENTS = 2000


def _load() -> list:
    if not ACTIVITY_FILE.exists():
        return []
    try:
        return json.loads(ACTIVITY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save(events: list):
    DATA_DIR.mkdir(exist_ok=True)
    ACTIVITY_FILE.write_text(
        json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def log_event(event_type: str, user_id: str, user_email: str, detail: dict = None):
    """Append an activity event (non-blocking, thread-safe)."""
    with _lock:
        events = _load()
        events.insert(0, {
            "type":       event_type,
            "user_id":    user_id,
            "user_email": user_email,
            "detail":     detail or {},
            "ts":         datetime.utcnow().isoformat(timespec="seconds"),
        })
        _save(events[:MAX_EVENTS])


def get_events(limit: int = 200, user_id: str = None) -> list:
    events = _load()
    if user_id:
        events = [e for e in events if e.get("user_id") == user_id]
    return events[:limit]


def get_user_stats() -> list:
    """Aggregate per-user stats from the activity log."""
    events = _load()
    stats: dict = {}
    for e in events:
        uid = e.get("user_id", "?")
        if uid not in stats:
            stats[uid] = {
                "user_id":   uid,
                "email":     e.get("user_email", "—"),
                "logins":    0,
                "cv_uploads": 0,
                "matches":   0,
                "last_seen": None,
            }
        et = e.get("type")
        if et == "login":
            stats[uid]["logins"] += 1
        elif et == "cv_upload":
            stats[uid]["cv_uploads"] += 1
        elif et == "match_run":
            stats[uid]["matches"] += 1
        ts = e.get("ts")
        if ts and (not stats[uid]["last_seen"] or ts > stats[uid]["last_seen"]):
            stats[uid]["last_seen"] = ts
    return list(stats.values())
