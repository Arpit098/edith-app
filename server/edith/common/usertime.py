"""The user's timezone (config [general] timezone, default Asia/Kolkata) and the usage-limit times
Claude Code prints in the server's zone ("5-hour limit reached ∙ resets 4pm (UTC)"), rewritten into
it ("resets 9:30 PM IST").

Claude Code is launched with TZ set to the user's zone (usertime.env()), so it prints local times
itself; localize_limit_text() is the safety net for a Claude started some other way (or before
that change). Text it can't read is left exactly as it was.
"""
import datetime as dt
import logging
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

log = logging.getLogger("edith.common.usertime")

DEFAULT_TZ = "Asia/Kolkata"
_tz_name = DEFAULT_TZ

MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
UTC_NAMES = r"UTC|Etc/UTC|GMT|Etc/GMT|UCT|Etc/UCT|Universal|Etc/Universal|Zulu|Etc/Zulu"
# "resets 4pm (UTC)", "resets at 4:30 pm (Etc/UTC)", "resets Nov 2, 4pm (UTC)", "resets Nov 2 at 16:00 (GMT)"
LIMIT_RESET = re.compile(
    r"(?P<lead>\bresets?(?:\s+at)?\s+)"
    r"(?:(?P<mon>[A-Za-z]{3})[A-Za-z]*\.?\s+(?P<day>\d{1,2})(?:\s*,\s*|\s+at\s+|\s+))?"
    r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?:(?P<ap>[ap])\.?m\b\.?)?"
    rf"\s*\((?P<zone>{UTC_NAMES})\)", re.I)
# Older Claude Code: "Claude AI usage limit reached|1761998400" (the reset as unix seconds)
LIMIT_EPOCH = re.compile(r"(?P<lead>usage limit reached)\|(?P<ts>\d{9,11})\b", re.I)
# Claude Code's own limit wording ("Claude usage limit reached", "5-hour limit reached ∙ resets 4pm",
# "You've hit your limit"): never a bare "limit reached", which a reply or a tool ("rate limit
# reached") can print too. Shared with claude_screen. A reset time is rewritten only when this comes
# at most LIMIT_BEFORE characters before it, on the same line and outside fenced code: "the cron job
# resets at 16:00 (UTC)" in a reply is left alone.
USAGE_LIMIT = re.compile(r"usage limit reached|\b\d+-hour limit reached|weekly limit reached|hit your limit"
                         r"|limit will reset", re.I)
LIMIT_BEFORE = 60
FENCE = re.compile(r"^\s*(```|~~~)")


def configure(name) -> str:
    """Set the user's timezone from config ([general] timezone). Anything but a known zone name (a
    number, a list, an unknown name) falls back to DEFAULT_TZ with a warning; None/"" means the default.
    -> the zone in use."""
    global _tz_name
    if name is None or name == "":
        _tz_name = DEFAULT_TZ
        return _tz_name
    try:
        if not isinstance(name, str):
            raise TypeError(f"not a string: {type(name).__name__}")
        ZoneInfo(name)
        _tz_name = name
    except Exception as e:  # ZoneInfoNotFoundError, ValueError, TypeError: startup must not fail on it
        log.warning("bad timezone %r in config (%s); using %s", name, e, DEFAULT_TZ)
        _tz_name = DEFAULT_TZ
    return _tz_name


def configure_from(config) -> str:
    """configure() from a whole config dict; a [general] that isn't a table is ignored with a warning."""
    general = config.get("general", {}) if isinstance(config, dict) else {}
    if not isinstance(general, dict):
        log.warning("[general] in config isn't a table; using timezone %s", DEFAULT_TZ)
        general = {}
    return configure(general.get("timezone"))


def stamp(now: dt.datetime | None = None) -> str:
    """"2026-11-02 10:43 IST": now, in the user's zone (the prompt headers sent to Claude)."""
    t = (now or dt.datetime.now(dt.timezone.utc)).astimezone(user_tz())
    return f"{t:%Y-%m-%d %H:%M} {t.tzname() or _tz_name}"


def tz_name() -> str:
    return _tz_name


def user_tz() -> ZoneInfo:
    return ZoneInfo(_tz_name)


def env(base: dict | None = None) -> dict:
    """`base` (or nothing) plus TZ=<the user's zone>: the environment a Claude Code is launched with."""
    return dict(base or {}, TZ=_tz_name)


def _zone(tz) -> ZoneInfo:
    return tz if isinstance(tz, dt.tzinfo) else ZoneInfo(tz) if tz else user_tz()


def clock(t: dt.datetime) -> str:
    """9:30 PM IST"""
    abbr = t.tzname() or ""
    if not abbr or abbr[0] in "+-":  # a zone with no abbreviation: name it
        abbr = getattr(t.tzinfo, "key", None) or f"UTC{abbr}"
    return f"{t.hour % 12 or 12}:{t.minute:02d} {'AM' if t.hour < 12 else 'PM'} {abbr}"


def day(t: dt.datetime) -> str:
    """Nov 2"""
    return f"{t:%b} {t.day}"


def localize_limit_text(text: str, tz=None, now: dt.datetime | None = None) -> str:
    """Rewrite Claude Code's usage-limit reset times from UTC into `tz` (default: the user's zone):
    "resets 4pm (UTC)" -> "resets 9:30 PM IST", "resets Nov 2, 8pm (UTC)" -> "resets Nov 3, 1:30 AM IST".
    A time without a date is the next one from `now`; a date is in the coming year when it would
    otherwise be over half a year ago. Only on a line with Claude's limit wording (USAGE_LIMIT) at most
    LIMIT_BEFORE characters before the time, outside fenced code. Text it can't parse, or already
    local, comes back unchanged."""
    if not text or ("(" not in text and "|" not in text):
        return text
    zone = _zone(tz)
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)

    def reset(m):
        # up to the match's end: "limit will reset at 4pm" shares its "reset" with the match
        if not USAGE_LIMIT.search(m.string[max(0, m.start() - LIMIT_BEFORE):m.end()]):
            return m[0]  # not Claude's limit line: someone else's "resets 4pm (UTC)"
        h, mins, ap = int(m["h"]), int(m["m"] or 0), (m["ap"] or "").lower()
        if (not ap and m["m"] is None) or mins > 59 or (h > 23 if not ap else not 1 <= h <= 12):
            return m[0]
        if ap:
            h = h % 12 + (12 if ap == "p" else 0)
        if m["mon"]:
            mon = m["mon"].lower()
            if mon not in MONTHS:
                return m[0]
            try:
                at = dt.datetime(now.year, MONTHS.index(mon) + 1, int(m["day"]), h, mins, tzinfo=dt.timezone.utc)
                if at < now - dt.timedelta(days=183):
                    at = at.replace(year=now.year + 1)
            except ValueError:
                return m[0]
        else:
            at = now.replace(hour=h, minute=mins, second=0, microsecond=0)
            if at < now:
                at += dt.timedelta(days=1)
        local = at.astimezone(zone)
        return f"{m['lead']}{day(local) + ', ' if m['mon'] else ''}{clock(local)}"

    def epoch(m):
        try:
            local = dt.datetime.fromtimestamp(int(m["ts"]), zone)
        except (OverflowError, OSError, ValueError):
            return m[0]
        today = now.astimezone(zone).date()
        return f"{m['lead']} ∙ resets {day(local) + ', ' if local.date() != today else ''}{clock(local)}"

    out, fenced = [], False
    for line in text.split("\n"):  # line by line, so the limit wording must be on the time's own line
        if FENCE.match(line):
            fenced = not fenced
        elif not fenced and USAGE_LIMIT.search(line):
            line = LIMIT_EPOCH.sub(epoch, LIMIT_RESET.sub(reset, line))
        out.append(line)
    return "\n".join(out)
