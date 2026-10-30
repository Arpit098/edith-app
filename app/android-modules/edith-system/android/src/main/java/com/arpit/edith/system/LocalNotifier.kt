package com.arpit.edith.system

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

/** A notification button that calls the App API in the background (see [NotificationActionReceiver]). */
data class LocalAction(val label: String, val method: String, val url: String, val headers: Map<String, String>, val body: String, val done: String)

/** One notification, as JS sends it (core/ports.ts LocalNotification). `raw` is that JSON. */
data class LocalNotification(
  val channel: String,
  val tag: String,
  val title: String,
  val text: String,
  val link: String,
  val actions: List<LocalAction>,
  val raw: String,
) {
  companion object {
    fun parse(raw: String): LocalNotification {
      val o = JSONObject(raw)
      val actions = o.optJSONArray("actions")
      return LocalNotification(
        channel = o.getString("channel"),
        tag = o.getString("tag"),
        title = o.optString("title"),
        text = o.optString("text"),
        link = o.optString("link", "edith://live"),
        actions = (0 until (actions?.length() ?: 0)).map { i ->
          val a = actions!!.getJSONObject(i)
          val r = a.getJSONObject("request")
          val h = r.optJSONObject("headers")
          LocalAction(
            label = a.getString("label"),
            method = r.optString("method", "POST"),
            url = r.getString("url"),
            headers = h?.keys()?.asSequence()?.associateWith { h.getString(it) } ?: emptyMap(),
            body = r.opt("body")?.toString() ?: "",
            done = a.optString("done"),
          )
        },
        raw = raw,
      )
    }
  }
}

/**
 * Replies, approvals, reminders and errors (PLAN.md §4.6), one channel each so Arpit can tune them
 * in Android's settings. One notification per tag: posting a tag again replaces it.
 */
class LocalNotifier(private val context: Context) {
  private val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  /**
   * Show `n`. `note` replaces the text (e.g. "Allowed" after a button); `buttons` false hides the
   * actions (while one is being sent, or once answered); `dismissAfterMs` takes it down by itself.
   */
  fun show(n: LocalNotification, note: String? = null, buttons: Boolean = true, dismissAfterMs: Long = 0) {
    val channel = CHANNELS[n.channel] ?: CHANNELS.getValue("replies")
    ensureChannel(channel)
    val text = if (note == null) n.text else "$note · ${n.text}"
    val builder = Notification.Builder(context, channel.id)
      .setSmallIcon(R.drawable.edith_status_icon)
      .setContentTitle(n.title)
      .setContentText(note ?: n.text)
      .setStyle(Notification.BigTextStyle().bigText(text))
      .setCategory(channel.category)
      .setContentIntent(Links.open(context, n.link))
      .setAutoCancel(true)
      .setOnlyAlertOnce(note != null) // an update after a button press is silent
      .setShowWhen(true)
    if (dismissAfterMs > 0) builder.setTimeoutAfter(dismissAfterMs)
    if (buttons) {
      n.actions.forEachIndexed { i, a ->
        builder.addAction(Notification.Action.Builder(null, a.label, actionIntent(n, i)).build())
      }
    }
    try {
      manager.notify(n.tag, NOTIFICATION_ID, builder.build())
    } catch (ignored: SecurityException) {
      // notifications not allowed (Android 13+ permission denied): nothing to show
    }
  }

  fun cancel(tag: String) = manager.cancel(tag, NOTIFICATION_ID)

  private fun actionIntent(n: LocalNotification, index: Int): PendingIntent {
    val intent = Intent(context, NotificationActionReceiver::class.java)
      .setAction("${context.packageName}.NOTIFICATION_ACTION")
      .setData(Uri.fromParts("edith-notification", "${n.tag}#$index", null)) // one PendingIntent per button
      .putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION, n.raw)
      .putExtra(NotificationActionReceiver.EXTRA_ACTION, index)
      .addFlags(Intent.FLAG_RECEIVER_FOREGROUND) // Arpit is waiting on it: no background-queue delay
    return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun ensureChannel(c: Channel) {
    if (manager.getNotificationChannel(c.id) != null) return
    manager.createNotificationChannel(NotificationChannel(c.id, c.name, c.importance).apply { description = c.description })
  }

  private data class Channel(val id: String, val name: String, val description: String, val importance: Int, val category: String)

  companion object {
    private const val NOTIFICATION_ID = 7200 // with the tag as the key
    private val CHANNELS = mapOf(
      "replies" to Channel("edith_replies", "Replies and finished tasks", "EDITH's answer to a message you sent from the app", NotificationManager.IMPORTANCE_DEFAULT, Notification.CATEGORY_MESSAGE),
      "approvals" to Channel("edith_approvals", "Approval needed", "EDITH waits for Allow or Deny", NotificationManager.IMPORTANCE_HIGH, Notification.CATEGORY_REMINDER),
      "reminders" to Channel("edith_reminders", "Reminders", "Reminders you set with EDITH", NotificationManager.IMPORTANCE_HIGH, Notification.CATEGORY_REMINDER),
      "errors" to Channel("edith_errors", "Errors", "A task that failed or ended with an error", NotificationManager.IMPORTANCE_DEFAULT, Notification.CATEGORY_ERROR),
    )
  }
}
