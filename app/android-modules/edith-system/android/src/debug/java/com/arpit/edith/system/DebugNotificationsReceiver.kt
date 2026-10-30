package com.arpit.edith.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import org.json.JSONObject

/**
 * Debug builds only (src/debug): shows what JS would, from `adb shell am broadcast`, for the CI
 * emulator screenshots (app/scripts/emulator/). The payloads come from the real JS models
 * (app/scripts/emulator/states.json, checked by jest), base64 so adb passes them untouched:
 *
 *   am broadcast -n com.arpit.edith/com.arpit.edith.system.DebugNotificationsReceiver \
 *     --es kind status|notify|clear|cancel --es payload <base64 JSON, or the tag to cancel>
 */
class DebugNotificationsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext
    val json = intent.getStringExtra("payload")?.let { String(Base64.decode(it, Base64.DEFAULT)) }
    when (intent.getStringExtra("kind")) {
      "status" -> LiveStatusNotifier(app).show(status(JSONObject(json!!)))
      "notify" -> LocalNotifier(app).show(LocalNotification.parse(json!!))
      "clear" -> LiveStatusNotifier(app).clear()
      "cancel" -> LocalNotifier(app).cancel(json!!)
    }
  }

  private fun status(o: JSONObject) = LiveStatus(
    title = o.getString("title"),
    text = o.getString("text"),
    chip = o.getString("chip"),
    startedAt = if (o.isNull("startedAt")) null else o.getLong("startedAt"),
    progress = o.getBoolean("progress"),
    link = o.getString("link"),
    alert = o.getBoolean("alert"),
    keepAlive = o.getBoolean("keepAlive"),
  )
}
