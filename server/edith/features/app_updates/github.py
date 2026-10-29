"""The few GitHub calls app_updates needs, through the `gh` CLI (already logged in on edith), each
with a timeout. Failures raise GhError; a missing artifact raises MissingArtifact (that run never
gets one, so it is not asked for again)."""
import json
import subprocess


class GhError(Exception):
    pass


class MissingArtifact(GhError):
    pass


class GitHub:
    def __init__(self, repo, workflow="build-apk.yml", branch="main", gh="gh", run=subprocess.run):
        self.repo, self.workflow, self.branch, self.gh, self._run = repo, workflow, branch, gh, run

    def _call(self, args, timeout):
        try:
            r = self._run([self.gh, *args], capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise GhError(f"gh {args[0]} {args[1]} timed out after {timeout}s")
        except OSError as e:
            raise GhError(f"gh not runnable: {e}")
        if r.returncode != 0:
            err = (r.stderr or "").strip()
            if "no artifact" in err.lower() or "no valid artifacts" in err.lower():
                raise MissingArtifact(err[:200])
            raise GhError(f"gh {args[0]} {args[1]} failed ({r.returncode}): {err[:300]}")
        return r.stdout

    def runs(self, limit=20):
        """Successful runs of the workflow on the branch, newest first: [{id, sha, created}]."""
        out = self._call(["run", "list", "--repo", self.repo, "--workflow", self.workflow, "--branch", self.branch,
                          "--status", "success", "--limit", str(limit), "--json", "databaseId,headSha,createdAt"], 60)
        try:
            return [{"id": int(r["databaseId"]), "sha": r["headSha"], "created": r["createdAt"]} for r in json.loads(out)]
        except (ValueError, KeyError, TypeError) as e:
            raise GhError(f"gh run list: unexpected output ({e})")

    def download(self, run_id, name, dest):
        """Extract one artifact of a run into `dest` (an empty directory)."""
        self._call(["run", "download", str(run_id), "--repo", self.repo, "--name", name, "--dir", dest], 900)

    def subjects(self, base, head, limit=20):
        """Commit subjects in base..head (newest first, at most `limit`); just head's when base is None."""
        if base and base != head:
            out = self._call(["api", f"repos/{self.repo}/compare/{base}...{head}",
                              "--jq", '.commits[].commit.message | split("\\n")[0]'], 30)
            return out.splitlines()[::-1][:limit]
        out = self._call(["api", f"repos/{self.repo}/commits/{head}", "--jq", '.commit.message | split("\\n")[0]'], 30)
        return out.splitlines()[:1]
