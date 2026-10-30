# ntfy on edith (Phase 5 pushes)

Pushes for the app while it is closed (contracts/push.md). ntfy is open source (Apache 2.0 / GPLv2),
one static binary, no account anywhere. **Nothing here is installed yet:** it is a live change, so it
goes to Arpit as a change list first (deploy/README.md, "Steps for every live change").

| File | Installed as |
|---|---|
| `deploy/ntfy/server.yml` | `~/.config/ntfy/server.yml` |
| `deploy/systemd/ntfy.service` | `~/.config/systemd/user/ntfy.service` |

## Install (after Arpit's "yes")

edith is ARM64. Pick the latest release at https://github.com/binwiederhier/ntfy/releases and check
its checksum before running anything:

```bash
V=2.11.0   # the release being installed
cd "$(mktemp -d)"
curl -fsSLO "https://github.com/binwiederhier/ntfy/releases/download/v$V/ntfy_${V}_linux_arm64.tar.gz"
curl -fsSLO "https://github.com/binwiederhier/ntfy/releases/download/v$V/checksums.txt"
grep "ntfy_${V}_linux_arm64.tar.gz" checksums.txt | sha256sum -c -
tar xzf "ntfy_${V}_linux_arm64.tar.gz"
mkdir -p ~/opt/ntfy ~/.local/share/ntfy ~/.config/ntfy
install -m 755 "ntfy_${V}_linux_arm64/ntfy" ~/opt/ntfy/ntfy
install -m 644 ~/edith-app-live/deploy/ntfy/server.yml ~/.config/ntfy/server.yml
install -m 644 ~/edith-app-live/deploy/systemd/ntfy.service ~/.config/systemd/user/ntfy.service
```

## Users and tokens (never printed)

Two users, each limited to the `edith` topic: `edith` publishes (write-only), `phone` subscribes
(read-only). Their passwords are random and never used (tokens only). Each token goes straight
into a mode-600 file:

```bash
export NTFY_AUTH_FILE=~/.local/share/ntfy/user.db
NTFY_PASSWORD="$(head -c 32 /dev/urandom | base64)" ~/opt/ntfy/ntfy user add edith
NTFY_PASSWORD="$(head -c 32 /dev/urandom | base64)" ~/opt/ntfy/ntfy user add phone
~/opt/ntfy/ntfy access edith edith write-only
~/opt/ntfy/ntfy access phone edith read-only
(umask 077; ~/opt/ntfy/ntfy token add --label=edith-server edith | awk '{print $2}' > ~/.config/edith/ntfy-publish-token)
(umask 077; ~/opt/ntfy/ntfy token add --label=phone phone | awk '{print $2}' > ~/.config/edith/ntfy-phone-token)
```

The phone token is given to the app once (Settings → Push), the same way as the App API token.

## Start and enable in EDITH

```bash
systemctl --user daemon-reload && systemctl --user enable --now ntfy
```

Then, in `~/.config/edith/config.toml` (and `deploy/config/edith.toml`): `notifiers = ["ntfy"]`,
`"notifications"` added to `[features] enabled`, and

```toml
[adapter.ntfy]
url = "http://100.78.124.98:2586"
topic = "edith"
token_file = "~/.config/edith/ntfy-publish-token"
```

followed by an `edith-bridge` restart (a few seconds of downtime for Telegram and the app).

## Check

```bash
systemctl --user status ntfy
ss -ltnp | grep 2586                                # 100.78.124.98:2586 only
curl -s -o /dev/null -w '%{http_code}\n' http://100.78.124.98:2586/edith/json?poll=1   # 401/403: deny-all
```

## Roll back

```bash
systemctl --user disable --now ntfy
```

and revert the three config lines above, then restart `edith-bridge`. The feature without a notifier
logs "nothing is pushed" and stays off; nothing else depends on ntfy.
