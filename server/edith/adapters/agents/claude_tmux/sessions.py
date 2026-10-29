"""Conversations: Claude's transcripts in ~/.claude/projects/<work dir>/<id>.jsonl, titled by their
/name or first real message (Telegram headers stripped), newest first, without side-lane forks.

Legacy re-read up to 400 lines of every transcript on every /sessions. A conversation's first
message never changes, so titles are cached once found; only new conversations are read.
"""
import json
import os


class Sessions:
    def __init__(self, folder, state, max_lines=400):
        self.folder, self.state, self.max_lines = folder, state, max_lines
        self._titles: dict[str, str] = {}

    def exists(self, sid):
        return os.path.exists(os.path.join(self.folder, f"{sid}.jsonl"))

    def title(self, sid):
        name = self.state.get("session_names", {}).get(sid)
        if name:
            return name
        if sid not in self._titles:
            found = self._first_message(sid)
            if not found:
                return None  # nothing yet; look again next time
            self._titles[sid] = found
        return self._titles[sid]

    def _first_message(self, sid):
        try:
            with open(os.path.join(self.folder, f"{sid}.jsonl")) as f:
                for i, raw in enumerate(f):
                    if i >= self.max_lines:
                        break
                    try:
                        entry = json.loads(raw)
                    except ValueError:
                        continue
                    if entry.get("type") != "user" or entry.get("isMeta"):
                        continue
                    content = entry.get("message", {}).get("content")
                    if isinstance(content, list):
                        content = " ".join(b.get("text", "") for b in content if b.get("type") == "text")
                    if not isinstance(content, str) or content.lstrip().startswith("<"):
                        continue
                    lines = [ln.strip() for ln in content.splitlines()
                             if ln.strip() and not ln.strip().startswith(("[", "- Arpit:", "EDITH:"))]
                    if lines:
                        return lines[0][:60]
        except OSError:
            pass
        return None

    def recent(self, limit=8):
        """[(sid, title, mtime)] newest first, skipping side-lane forks."""
        forks = set(self.state.get("side_sessions", []))
        try:
            with os.scandir(self.folder) as it:
                files = sorted(((e.stat().st_mtime, e.name[:-6]) for e in it if e.name.endswith(".jsonl")),
                               reverse=True)
        except OSError:
            return []
        out, seen = [], set()
        for mtime, sid in files:
            if sid in forks:
                continue
            title = self.title(sid)
            # Older forks weren't tracked; they share their parent's first message, so keep the newest.
            if title and title not in seen:
                seen.add(title)
                out.append((sid, title, mtime))
            if len(out) >= limit:
                break
        return out

    def find(self, arg):
        """/resume argument -> session id: a number from the last list, a name, or an id prefix."""
        listing = self.state.get("last_listing", [])
        if arg.isdigit() and 0 < int(arg) <= len(listing):
            return listing[int(arg) - 1]
        for sid, name in self.state.get("session_names", {}).items():
            if name.lower() == arg.lower():
                return sid
        try:
            with os.scandir(self.folder) as it:
                matches = [e.name[:-6] for e in it if e.name.startswith(arg) and e.name.endswith(".jsonl")]
        except OSError:
            return None
        return matches[0] if len(matches) == 1 else None
