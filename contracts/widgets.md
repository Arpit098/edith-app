# Home-screen widgets contract (app JS ⇄ native widget module)

Two Android widgets live in `app/android-modules/edith-widget` (native, so they ship in a full APK, not OTA).
The app's JS side is `app/src/features/widgets` (the snapshot writer and the setting) and
`app/src/features/live-session/launch.ts` (the bar's links). Change this file first, then both sides.

## Widgets

| Widget | Size | What it does |
|---|---|---|
| EDITH bar | 4x1, wider or narrower | A glass pill: the orb, "E.D.I.T.H", and Type, Mic and Attach buttons (links below). Tapping the pill itself is Type. No data, never redrawn on a timer |
| Last message | 4x2, resizable to 4x3 (the 3-line layout from 280 dp high, above any 4x2, so a 4x2 always keeps the compact layout) | The orb, "E.D.I.T.H", a status dot, the newest line's time (HH:MM, IST) and the newest reply or alert, ellipsized. At 4x3 the two lines before it too, and Approve / Deny while an approval waits. A tap opens the chat |

Both follow the system's dark mode (`values` / `values-night`).

## Links (edith://)

The widgets open EDITH's launcher activity (singleTask) with a link; the shell (`shell/Shell.tsx`) opens the
screen and, for a second path part on any screen but Settings, publishes the app-local event
`app.link {screen, action, trusted}` after the screen is on top.

- **Key.** Any app or web page can send an edith:// link. The bar's links carry `k`, a random key made per
  install and kept only in the widget's SharedPreferences (`WidgetStore.linkKey`). `trusted` is true only
  when the native `checkLink(url)` accepts it (compared in constant time). listen and attach run only for
  trusted links; any other just opens the chat, with the mic ready but not recording. type needs no key.
- **Once.** The launch link is read natively (`initialLink`) and its intent data cleared as it's read, so
  a JS reload (an OTA update) never runs it again. An intent marked `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`
  (a restore from Recents) gives none. A link received while running is cleared too (`consumeLink`).

| Link | Opens |
|---|---|
| `edith://live/type?k=<key>` | the chat, the message box focused (keyboard up) |
| `edith://live/listen?k=<key>` | the chat, push-to-talk already recording (typing if there's no microphone) |
| `edith://live/attach?k=<key>` | the chat with the composer's menu open (Camera, Gallery, Audio file) |
| `edith://live` | the chat |
| `edith://approvals?id=<id>&answer=allow\|deny` | the Approvals screen, where Arpit confirms. The query is ignored: nothing is ever answered from the widget |

## Snapshot (v1)

What the last-message widget draws, kept in the app's private SharedPreferences (`edith.widget`,
`snapshot.v1`). No token or server address is ever stored for the widgets: they never call edith.

```json
{ "v": 1, "at": 1793280000, "state": "waiting",
  "messages": [{ "text": "🔐 Approve Bash? npm test", "ts": 1793279990, "alert": true }],
  "permission": { "id": "7f3a", "text": "🔐 Approve Bash? npm test" }, "hidden": false }
```

| Field | Meaning |
|---|---|
| `at` | Unix seconds of the last write. A `working` older than 3 h shows as "not known" (grey dot): saving a `working` snapshot sets one inexact, non-wakeup alarm at `at` + 3 h that redraws the widget (any other state cancels it), so this shows even if the app died mid-turn |
| `state` | `working` (a turn runs), `idle`, `waiting` (on Arpit: an approval) |
| `messages` | Newest first, at most 3; `text` plain, one line, at most 300 characters (`""` when left out); `ts` the event's time (a push: ntfy's `time`, else when it arrived) |
| `permission` | The approval waiting, or null |
| `hidden` | The texts were left out ("Show message text in widgets" off) |

Lines: a reply (`turn.done`, a side lane's `message.assistant`) as its text; `⚠️` a failed turn or an error
reply; `🔐 Approve <tool>? <detail>` an approval; `⏰` a reminder. A line is written once per turn ref,
approval id or reminder due time.

## Data refresh: event-driven, two writers, no polling

- **App connected** (open, or held by its foreground service while a turn runs): the widgets feature
  subscribes to the bus (`turn.*`, `lane.status`, `permission.*`, `reminder.due`, a side lane's
  `message.assistant`) and resyncs the state and approvals from `GET /v1/status` and
  `GET /v1/permissions` on each `app.connected`. It writes only when something shown changes (and, during
  a long turn, refreshes `at` on its own `turn.progress` at most every 15 minutes so it never looks stale).
- **App not connected**: edith pushes through ntfy (contracts/push.md). edith-system's `PushNtfy` hands each
  push, by explicit class name and inside the app only, to `WidgetPushReceiver`, which folds it into the
  snapshot (approvals → waiting; their cancel → working; errors, reminders, replies → a line) and redraws.
- Each JS write first reads the saved snapshot back, so lines pushes added while the app was away are kept.
- Each write redraws the placed widgets at once (`AppWidgetManager.updateAppWidget`); `updatePeriodMillis`
  is 0: nothing wakes the phone for the widgets.

## Privacy

Settings → Widgets → **Show message text in widgets** (on by default; stored natively). Off: the native
side drops every text before saving (and wipes the texts already saved), and the widget says only
"New message from EDITH". On a lock screen (a keyguard host) it never shows the text, whatever the setting.
