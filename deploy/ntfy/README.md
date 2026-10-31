# ntfy on edith (Phase 5 pushes)

Pushes for the app while it is closed (contracts/push.md). ntfy is open source (Apache 2.0 / GPLv2),
one static binary, no account anywhere. It is a live change: it goes in only after Arpit's "yes"
(deploy/README.md, "Steps for every live change").

| File | Installed as |
|---|---|
| `deploy/ntfy/server.yml` | `~/.config/ntfy/server.yml` |
| `deploy/systemd/ntfy.service` | `~/.config/systemd/user/ntfy.service` |

Every block below is copy-paste as is, in one shell on edith, in order, after `~/edith-app-live` is
checked out at the tag that has this folder. Each starts with `set -euo pipefail` in a subshell, so a
failing step stops that block and leaves the shell open.

## 1. Install the binary and the files

edith is ARM64. The version is pinned and its SHA-256 is written here (taken from the release's
checksums.txt and checked against a download on 31 Oct 2026, IST). The download is checked against
this value, not against a checksums file fetched next to it, so a changed download stops before
anything is installed.

```bash
(
set -euo pipefail
V=2.34.0
SHA=d585fe48d1b2e80b1b1719977bb651cc7d9259bacb817aa8a8d5b4c8f0c9e946   # ntfy_2.34.0_linux_arm64.tar.gz
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
curl -fsSL -o "$T/ntfy.tar.gz" "https://github.com/binwiederhier/ntfy/releases/download/v$V/ntfy_${V}_linux_arm64.tar.gz"
echo "$SHA  $T/ntfy.tar.gz" | sha256sum -c -          # prints "OK"; anything else stops here
tar xzf "$T/ntfy.tar.gz" -C "$T"
mkdir -p ~/opt/ntfy ~/.local/share/ntfy ~/.config/ntfy ~/.config/systemd/user ~/.config/edith
install -m 755 "$T/ntfy_${V}_linux_arm64/ntfy" ~/opt/ntfy/ntfy
install -m 644 ~/edith-app-live/deploy/ntfy/server.yml ~/.config/ntfy/server.yml
install -m 644 ~/edith-app-live/deploy/systemd/ntfy.service ~/.config/systemd/user/ntfy.service
~/opt/ntfy/ntfy --help >/dev/null && echo "ntfy $V installed"
)
```

## 2. Users and tokens (never printed)

Two users, each limited to the `edith` topic: `edith` publishes (write-only), `phone` subscribes
(read-only). Their passwords are random and never kept (only tokens are used). `ntfy token add`
prints `token tk_… created for user …` on stdout; awk takes the token straight into a file created
under `umask 077` (mode 600). The last line prints only each file's mode and size: `600 33`
(`tk_`, 29 characters, a newline).

```bash
(
set -euo pipefail
export NTFY_AUTH_FILE=~/.local/share/ntfy/user.db
NTFY_PASSWORD="$(head -c 32 /dev/urandom | base64)" ~/opt/ntfy/ntfy user add edith
NTFY_PASSWORD="$(head -c 32 /dev/urandom | base64)" ~/opt/ntfy/ntfy user add phone
~/opt/ntfy/ntfy access edith edith write-only
~/opt/ntfy/ntfy access phone edith read-only
umask 077
~/opt/ntfy/ntfy token add --label=edith-server edith | awk '{print $2}' > ~/.config/edith/ntfy-publish-token
~/opt/ntfy/ntfy token add --label=phone phone | awk '{print $2}' > ~/.config/edith/ntfy-phone-token
chmod 600 ~/.local/share/ntfy/user.db
stat -c '%a %s %n' ~/.config/edith/ntfy-publish-token ~/.config/edith/ntfy-phone-token
)
```

The phone token is given to the app once (Settings → Push), the same way as the App API token.

## 3. Start ntfy

```bash
systemctl --user daemon-reload
systemctl --user enable --now ntfy
```

## 4. Check

```bash
(
set -euo pipefail
systemctl --user is-active ntfy                     # active
ss -ltn | grep ':2586'                              # 100.78.124.98:2586 only, never 0.0.0.0
curl -s -o /dev/null -w '%{http_code}\n' 'http://100.78.124.98:2586/edith/json?poll=1'   # 401 or 403: deny-all
# The tokens work (200 each), fed to curl on stdin (printf is a shell builtin: no token in `ps`):
printf 'header = "Authorization: Bearer %s"\n' "$(cat ~/.config/edith/ntfy-phone-token)" \
  | curl -s -o /dev/null -w 'phone reads: %{http_code}\n' -K - 'http://100.78.124.98:2586/edith/json?poll=1'
printf 'header = "Authorization: Bearer %s"\n' "$(cat ~/.config/edith/ntfy-publish-token)" \
  | curl -s -o /dev/null -w 'edith publishes: %{http_code}\n' -K - -d 'ntfy check' 'http://100.78.124.98:2586/edith'
)
```

## 5. Turn it on in EDITH

In `~/.config/edith/config.toml` (and `deploy/config/edith.toml`): `"ntfy"` added to `[adapters]
notifiers` (keep whatever is there: `[]` becomes `["ntfy"]`), `"notifications"` added to
`[features] enabled`, and

```toml
[adapter.ntfy]
url = "http://100.78.124.98:2586"
topic = "edith"
token_file = "~/.config/edith/ntfy-publish-token"
```

then `systemctl --user restart edith-bridge` (a few seconds of downtime for Telegram and the app).
Its log says `features loaded: [... 'notifications' ...]`; a turn sent from the app with the app
closed then arrives as a push.

## Roll back

```bash
systemctl --user disable --now ntfy
```

and revert the config lines of step 5, then restart `edith-bridge`. Without a notifier the
feature logs "nothing is pushed" and stays off; nothing else depends on ntfy. To remove it
completely afterwards (this deletes the user database and both tokens):

```bash
rm -f ~/.config/systemd/user/ntfy.service && systemctl --user daemon-reload
rm -rf ~/opt/ntfy ~/.config/ntfy ~/.local/share/ntfy
rm -f ~/.config/edith/ntfy-publish-token ~/.config/edith/ntfy-phone-token
```
