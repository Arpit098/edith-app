package com.arpit.edith.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * A push that edith-system's PushService (or its 15-minute check) just received while the app was
 * away (contracts/push.md): folded into the last-message widget's snapshot, which is redrawn. Sent by
 * class name from inside the app ([ACTION], the raw ntfy `message` in [EXTRA_PUSH], its `time` in
 * [EXTRA_TIME]); not exported.
 * The work is a small JSON parse and a SharedPreferences write: fine on the main thread.
 */
class WidgetPushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    val raw = intent.getStringExtra(EXTRA_PUSH) ?: return
    val store = WidgetStore(context)
    val now = System.currentTimeMillis() / 1000
    val next = WidgetSnapshot.fold(store.load(), raw, now, store.showText, intent.getLongExtra(EXTRA_TIME, 0L)) ?: return
    store.save(next)
    MessageWidgetProvider.updateAll(context.applicationContext)
  }

  companion object {
    // Mirrored in edith-system's PushNtfy (the two modules don't link to each other).
    const val ACTION = "com.arpit.edith.widget.PUSH"
    const val EXTRA_PUSH = "com.arpit.edith.widget.push"
    const val EXTRA_TIME = "com.arpit.edith.widget.time" // ntfy's `time` (unix seconds), 0 if unknown
  }
}
