#!/usr/bin/env python3
"""Show uncommitted changes in Arpit's project repos, VS Code style, for Telegram.

Usage: changes.py [filter]      filter = part of a repo name or path (optional)

Prints a short text summary and writes a self-contained, phone-friendly HTML diff
(dark theme, one collapsible section per file, red/green lines) whose path is printed
on the last line as  HTML: /path  so EDITH can attach it with SEND_FILE.
Read-only: never touches the git index or working tree.
"""
import html
import os
import subprocess
import sys
import time

ROOTS = [os.path.expanduser(p) for p in os.environ.get("EDITH_CHANGES_ROOTS", "~/Projects").split(":")]
OUT_DIR = os.path.expanduser("~/.cache/edith/changes")
MAX_LINES_PER_FILE = 1500


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, errors="replace")
    return r.stdout


def find_repos(filt):
    repos = []
    for root in ROOTS:
        for dirpath, dirnames, _ in os.walk(root):
            if ".git" in dirnames:
                repos.append(dirpath)
                dirnames[:] = []  # don't descend into repos
            else:
                dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".venv", "dist", "build")]
    if filt:
        f = filt.lower()
        repos = [r for r in repos if f in r.lower()]
    return sorted(repos)


def repo_changes(repo):
    """Return (branch, [(status, path, diff_text, added, removed)])."""
    branch = git(repo, "branch", "--show-current").strip() or "(detached)"
    files = []
    tracked = git(repo, "diff", "HEAD", "--numstat").splitlines()
    for line in tracked:
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        a, d, path = parts[0], parts[1], parts[2]
        diff = git(repo, "diff", "HEAD", "--", path)
        status = "D" if "\ndeleted file mode" in diff else ("A" if "\nnew file mode" in diff else "M")
        files.append((status, path, diff, a, d))
    for path in git(repo, "ls-files", "--others", "--exclude-standard").splitlines():
        r = subprocess.run(["git", "-C", repo, "diff", "--no-index", "--", "/dev/null", path],
                           capture_output=True, text=True, errors="replace")
        added = sum(1 for l in r.stdout.splitlines() if l.startswith("+") and not l.startswith("+++"))
        files.append(("U", path, r.stdout, str(added), "0"))
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


def main():
    filt = sys.argv[1] if len(sys.argv) > 1 else ""
    repos = find_repos(filt)
    if not repos:
        print(f"No git repos found under ~/Projects{' matching ' + repr(filt) if filt else ''}.")
        return
    total_files, summary, sections = 0, [], []
    for repo in repos:
        branch, files = repo_changes(repo)
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
    os.makedirs(OUT_DIR, mode=0o700, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = os.path.join(OUT_DIR, f"changes-{stamp}.html")
    with open(out, "w") as f:
        f.write(f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" '
                f'content="width=device-width,initial-scale=1"><title>Changes {stamp}</title>'
                f'<style>{CSS}</style></head><body><h1>Project changes</h1>'
                f'<div class="meta">{time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())} · '
                f'M modified · A added · U untracked · D deleted</div>{"".join(sections)}</body></html>')
    os.chmod(out, 0o600)
    # keep only the 20 most recent reports
    old = sorted(os.listdir(OUT_DIR))[:-20]
    for o in old:
        os.remove(os.path.join(OUT_DIR, o))
    print(f"HTML: {out}")


if __name__ == "__main__":
    main()
