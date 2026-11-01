#!/usr/bin/env python3
"""Show uncommitted changes in Arpit's project repos, VS Code style, for Telegram.

Usage: changes.py [filter]      filter = part of a repo name or path (optional)

Prints a short text summary and writes a self-contained, phone-friendly HTML diff
(dark theme, one collapsible section per file, red/green lines) whose path is printed
on the last line as  HTML: /path  so EDITH can attach it with SEND_FILE.
Read-only: never touches the git index or working tree.
"""
# The docstring above is kept word for word from legacy/edith/bin/changes.py. EDITH runs this as
# `python3 -I ~/edith/bin/changes.py [filter]` (a wrapper, see deploy/shims/); the output must not change.
#
# Changes from legacy:
# - A fixed number of git calls per repo instead of one per changed file: tracked changes come from
#   one `git diff HEAD` split per file, and untracked files from one `git diff` through a throwaway
#   index that holds them as intent-to-add entries (the repo's own index is never touched). Blocks
#   are matched to files by their `diff --git a/P b/P` header (a dict lookup); anything that doesn't
#   match (quoted special-character names, renames, nested repos) falls back to legacy's per-file
#   call, so even odd cases print exactly what legacy printed.
# - Roots and the output folder are read at call time (EDITH_CHANGES_ROOTS, EDITH_STATE_DIR).
# - Git runs with GIT_OPTIONAL_LOCKS=0 (no opportunistic index refresh) and a timeout per call.
# - The HTML report is written to a temp file created 0600 and renamed into place, so a half-written
#   or briefly world-readable report is never sent.
import datetime
import html
import os
import subprocess
import sys
import tempfile
import time

from edith.common import usertime
from edith.common.paths import resolve

MAX_LINES_PER_FILE = 1500
GIT_TIMEOUT = 30  # seconds per git call; a hung repo is reported, the others still show
SKIP_DIRS = {"node_modules", ".venv", "dist", "build"}
GIT_ENV = {"GIT_OPTIONAL_LOCKS": "0"}


class GitTimeout(Exception):
    pass


def git(repo, *args, env=None, input=None):
    try:
        r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, errors="replace",
                           env={**os.environ, **GIT_ENV, **(env or {})}, input=input, timeout=GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise GitTimeout(f"git {args[0]} timed out after {GIT_TIMEOUT}s")
    return r.stdout


def roots():
    return [os.path.expanduser(p) for p in os.environ.get("EDITH_CHANGES_ROOTS", "~/Projects").split(":")]


def find_repos(filt):
    repos = []
    for root in roots():
        for dirpath, dirnames, _ in os.walk(root):
            if ".git" in dirnames:
                repos.append(dirpath)
                dirnames[:] = []  # don't descend into repos
            else:
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
    if filt:
        f = filt.lower()
        repos = [r for r in repos if f in r.lower()]
    return sorted(repos)


def blocks_by_header(patch):
    """One `git diff` output -> {"a/P b/P": that file's block}, each block exactly as a
    single-file `git diff -- P` would print it."""
    if not patch:
        return {}
    parts = ("\n" + patch).split("\ndiff --git ")[1:]
    out = {}
    for i, part in enumerate(parts):
        block = "diff --git " + part + ("\n" if i < len(parts) - 1 else "")
        out[part.split("\n", 1)[0]] = block
    return out


def count_added(diff):
    return sum(1 for line in diff.splitlines() if line.startswith("+") and not line.startswith("+++"))


def untracked_diffs(repo, paths):
    """Each untracked file's diff as a new file, from one `git diff` against a throwaway index.

    `paths` are as `git ls-files` prints them (special characters quoted), which is also how
    --pathspec-from-file reads them."""
    with tempfile.TemporaryDirectory(prefix="edith-changes-") as tmp:
        env = {"GIT_INDEX_FILE": os.path.join(tmp, "index")}
        git(repo, "add", "--intent-to-add", "--pathspec-from-file=-", env=env, input="\n".join(paths) + "\n")
        found = blocks_by_header(git(repo, "diff", "--no-color", env=env))
    return [found.get(f"a/{p} b/{p}") or git(repo, "diff", "--no-index", "--", "/dev/null", p) for p in paths]


def repo_changes(repo):
    """Return (branch, [(status, path, diff_text, added, removed)])."""
    branch = git(repo, "branch", "--show-current").strip() or "(detached)"
    files = []
    numstat = [parts for parts in (line.split("\t") for line in git(repo, "diff", "HEAD", "--numstat").splitlines())
               if len(parts) >= 3]
    found = blocks_by_header(git(repo, "diff", "HEAD", "--no-color")) if numstat else {}
    for a, d, path in (parts[:3] for parts in numstat):
        if " => " in path:
            diff = ""  # a rename: legacy's `git diff HEAD -- "x => y"` matched nothing either
        else:
            diff = found.get(f"a/{path} b/{path}") or git(repo, "diff", "HEAD", "--", path)
        status = "D" if "\ndeleted file mode" in diff else ("A" if "\nnew file mode" in diff else "M")
        files.append((status, path, diff, a, d))
    untracked = git(repo, "ls-files", "--others", "--exclude-standard").splitlines()
    if untracked:
        for path, diff in zip(untracked, untracked_diffs(repo, untracked)):
            files.append(("U", path, diff, str(count_added(diff)), "0"))
    return branch, files


def render_diff(diff):
    out, lines = [], diff.splitlines()
    shown = 0
    for l in lines:
        if l.startswith(("diff --git", "index ", "--- ", "+++ ", "new file mode", "deleted file mode", "similarity", "rename ")):
            continue
        if shown >= MAX_LINES_PER_FILE:
            out.append(f'<div class="hunk">… {len(lines) - shown} more lines not shown</div>')
            break
        cls = "add" if l.startswith("+") else "del" if l.startswith("-") else "hunk" if l.startswith("@@") else "ctx"
        if l.startswith("Binary files"):
            cls = "hunk"
        out.append(f'<div class="{cls}">{html.escape(l) or "&nbsp;"}</div>')
        shown += 1
    return "\n".join(out) or '<div class="hunk">(no text diff: binary or mode change)</div>'


CSS = """
body{background:#1e1e1e;color:#d4d4d4;font:14px -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:10px}
h1{font-size:17px;margin:4px 0 10px}h2{font-size:15px;margin:18px 0 6px;color:#9cdcfe}
.meta{color:#888;font-size:12px}
details{background:#252526;border-radius:6px;margin:6px 0;overflow:hidden}
summary{padding:8px 10px;cursor:pointer;font-size:13px;word-break:break-all}
.st{display:inline-block;width:18px;font-weight:bold}.M{color:#e2c08d}.A,.U{color:#73c991}.D{color:#f14c4c}
.n{float:right;font-size:12px}.na{color:#73c991}.nd{color:#f14c4c}
.code{font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;overflow-x:auto;white-space:pre;border-top:1px solid #333}
.code div{padding:0 8px;min-width:max-content}
.add{background:#23381f;color:#b5e8a8}.del{background:#4b1818;color:#f4b0b0}
.hunk{color:#569cd6;background:#1f2a36;padding:2px 8px!important}.ctx{color:#bbb}
"""


def write_private(path, text):
    """Create the report 0600 from the start, then rename it into place."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=".html")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    filt = argv[0] if argv else ""
    repos = find_repos(filt)
    if not repos:
        print(f"No git repos found under ~/Projects{' matching ' + repr(filt) if filt else ''}.")
        return
    total_files, summary, sections = 0, [], []
    for repo in repos:
        try:
            branch, files = repo_changes(repo)
        except GitTimeout as e:
            summary.append(f"{os.path.basename(repo)}: skipped, {e}")
            continue
        name = os.path.relpath(repo, os.path.expanduser("~/Projects"))
        if not files:
            summary.append(f"{os.path.basename(repo)} ({branch}): clean")
            continue
        total_files += len(files)
        add = sum(int(f[3]) for f in files if f[3].isdigit())
        rem = sum(int(f[4]) for f in files if f[4].isdigit())
        summary.append(f"{os.path.basename(repo)} ({branch}): {len(files)} file(s), +{add} -{rem}")
        for st, path, _, a, d in files:
            summary.append(f"  {st} {path} (+{a} -{d})")
        items = []
        for st, path, diff, a, d in files:
            items.append(
                f'<details{" open" if len(files) <= 3 else ""}><summary><span class="st {st}">{st}</span>'
                f'{html.escape(path)}<span class="n"><span class="na">+{a}</span> <span class="nd">-{d}</span></span>'
                f'</summary><div class="code">{render_diff(diff)}</div></details>')
        sections.append(f'<h2>{html.escape(name)} <span class="meta">({html.escape(branch)}) · '
                        f'{len(files)} file(s) · +{add} -{rem}</span></h2>' + "\n".join(items))

    print("\n".join(summary))
    if not total_files:
        print("No uncommitted changes.")
        return
    out_dir = resolve().changes_dir
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = os.path.join(out_dir, f"changes-{stamp}.html")
    write_private(out, f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" '
                       f'content="width=device-width,initial-scale=1"><title>Changes {stamp}</title>'
                       f'<style>{CSS}</style></head><body><h1>Project changes</h1>'
                       f'<div class="meta">{datetime.datetime.now(usertime.user_tz()):%Y-%m-%d %H:%M %Z} · '
                       f'M modified · A added · U untracked · D deleted</div>{"".join(sections)}</body></html>')
    # keep only the 20 most recent reports
    old = sorted(n for n in os.listdir(out_dir) if n.startswith("changes-"))[:-20]
    for o in old:
        os.remove(os.path.join(out_dir, o))
    print(f"HTML: {out}")


if __name__ == "__main__":
    main()
