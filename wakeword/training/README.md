# Training "Hey Edith"

For the **Claude agent on Arpit's MacBook** (M5), working in a clone of this repo. It pulls Arpit's
recordings from edith, trains the model with openWakeWord, and pushes `wakeword/models/` to `main`. The
app gets the model in its next OTA update (PLAN.md §4.5, contracts/wakeword.md).

Rules while doing this:
- **Never print, log or paste the App API token.** The scripts read it from a file.
- **Recordings and training data never go in git.** They live in `wakeword/work/` (git-ignored). Only the
  three files in `wakeword/models/` are committed.
- Free and open source only; the versions below are pinned. Don't upgrade them on the fly.

## 0. Once: prerequisites

1. The Mac is on Tailscale and reaches edith: `tailscale ping edith`, then
   `curl -s -o /dev/null -w "%{http_code}\n" http://edith:8787/v1/status` prints `401` (no token sent yet: good).
2. The token: Arpit puts the App API token in `~/.config/edith/app-token` himself (the same value the app
   uses), then `chmod 600 ~/.config/edith/app-token`. Check it without showing it:
   `test "$(wc -c < ~/.config/edith/app-token)" -ge 32 && echo token file ok`.
3. Python 3.12: `brew install python@3.12`.
4. Disk: about 25 GB free for the full negative set (`df -h .`). With less, use `--negative-hours 500`
   in step 3 (about 4.5 GB; trains faster, may accept a few more false wakes).

## 1. Environment (once; from the repo root)

```bash
cd wakeword/training
python3.12 -m venv ../work/venv
source ../work/venv/bin/activate
pip install --upgrade pip==24.3.1
pip install -r requirements.txt
pip install --no-deps -r requirements-nodeps.txt
python -c "import torch; print('mps' if torch.backends.mps.is_available() else 'no mps')"   # expect: mps
```

## 2. Recordings (every training run)

```bash
python fetch.py                      # the newest session with clips; or --session <id>
```

It prints the session, the clips per kind and "all SHA-256 checked". It needs at least 10 "Hey Edith" clips
(30–50 is the target) and some `noise` clips (home, TV). If it says there are none, Arpit records them in
the app first (Train wake word screen). Use `--base-url http://<edith's Tailscale IP>:8787` if MagicDNS
isn't on.

## 3. Training data (once; resumes if interrupted)

```bash
python data.py                        # or: python data.py --negative-hours 500
```

Downloads the Piper voice generator, openWakeWord's feature models, the negative features, the
validation set and room impulse responses, each checked against its pinned SHA-256 (data.py lists them).

## 4. Train

```bash
caffeinate -i python train.py         # keeps the Mac awake; the log shows "device: mps"
```

- It takes hours the first time. Piper's synthetic clips are generated on the CPU and kept, so later
  runs skip that step. If it stops, run the same command again: finished steps are skipped.
- Options: `--steps 50000` (longer training), `--real-repeat 20`, `--device cpu`, `--session <id>`.
- The output: `wakeword/models/hey_edith.onnx`, `hey_edith.json` and `metrics.md`.

## 5. Check the metrics

`metrics.md` shows:
- the false-reject rate on held-out recordings (every 5th "Hey Edith" clip, never trained on). The target
  is under 5%;
- false accepts per hour on openWakeWord's negative validation set (about 11 h). The target is under 1;
- false accepts per hour on the held-out home noise (every 3rd noise clip).

If a target is missed, tell Arpit the numbers and suggest what fits: more recordings (especially far and
whispered), `--steps 50000`, or the full negative set. Don't push a model that misses a target unless Arpit
says so.

## 6. Ship it

```bash
cd "$(git rev-parse --show-toplevel)"
git status --short                    # must show only wakeword/models/ files
git add wakeword/models/hey_edith.onnx wakeword/models/hey_edith.json wakeword/models/metrics.md
git commit -m "Wake word model <version from hey_edith.json>: FRR x%, y false accepts/h"
git push origin main
```

Then tell Arpit the version and the metrics (times in IST). The app picks the model up in the next OTA update
and asks him to say "Hey Edith" a few times to confirm. No attribution lines in commits.

## Fallback: on edith's CPU

The same scripts run on edith (Python 3.12, no GPU), slowly and at low priority so EDITH isn't affected.
Use a work dir outside the repo clone the bridge runs from, and the local App API address:

```bash
python3.12 -m venv ~/wakeword-work/venv && source ~/wakeword-work/venv/bin/activate
pip install -r requirements.txt && pip install --no-deps -r requirements-nodeps.txt
python fetch.py --base-url http://100.78.124.98:8787 --work ~/wakeword-work
python data.py --work ~/wakeword-work --negative-hours 500
nice -n 19 python train.py --work ~/wakeword-work --device cpu
```
