package com.arpit.edith.system

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings

/** What the live status says (the wording is decided and tested in JS: features/live-status). */
data class LiveStatus(
  val title: String,
  val text: String,
  val chip: String, // the short text in the status-bar chip / Live Alerts pill
  val startedAt: Long?, // unix ms: shown as a running timer (no per-second updates)
  val progress: Boolean, // indeterminate progress (a task is running)
  val link: String, // opened on tap
  val keepAlive: Boolean, // a turn runs or an approval waits: hold the foreground service
)

/**
 * EDITH's live status as one ongoing notification (PLAN.md §4.11).
 *
 * Android 16+: a promoted ongoing notification ("Live Update", the `EXTRA_REQUEST_PROMOTED_ONGOING` extra) with
 * `ProgressStyle` and a short chip text; OxygenOS 16 shows these in the Live Alerts pill once Arpit
 * allows it for EDITH. Older Android: the same notification, just not promoted.
 *
 * Updates come from stream events (JS throttles them); the elapsed time is a chronometer, so the
 * notification never needs a per-second refresh. The status never makes a sound (an approval alerts
 * through its own notification). While `keepAlive` is set the notification belongs
 * to [EdithSessionService], which keeps EDITH (and its stream) running in the background. All
 * changes run in order on the main thread, where the service lives too.
 */
class LiveStatusNotifier(private val context: Context) {
  private val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  private val main = Handler(Looper.getMainLooper())

  fun show(s: LiveStatus) {
    val notification = build(s)
    main.post {
      if (s.keepAlive) {
        EdithSessionService.hold(context, notification)
      } else {
        EdithSessionService.release(remove = false) // the notification stays, then is replaced
        post(notification)
      }
    }
  }

  /**
   * A 30 s demo Live Update ("EDITH · Thinking…" with a running timer) under its own id, built and
   * channelled exactly like the real status, so Arpit can check the Live Alerts pill without a turn.
   * Posted at once on the calling thread (NotificationManager is thread-safe), so a failure comes
   * back to the app instead of vanishing. The answer says what Arpit will see, or why he won't.
   */
  fun testIsland(): Map<String, Any> {
    if (!manager.areNotificationsEnabled()) return outcome(false, "Notifications are off for EDITH. Turn them on in Android's settings.")
    ensureChannel(context)
    if (manager.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) {
      return outcome(false, "The \"EDITH live status\" notification category is off. Turn it on in EDITH's notification settings.")
    }
    val demo = LiveStatus(
      title = "EDITH · Thinking…",
      text = "A test of the Live Alerts pill",
      chip = "Thinking",
      startedAt = System.currentTimeMillis(),
      progress = true,
      link = "edith://live",
      keepAlive = false,
    )
    try {
      manager.notify(TEST_ID, build(demo, timeoutMs = TEST_MS))
    } catch (e: RuntimeException) { // SecurityException and anything a builder rejects
      return outcome(false, "Android refused the demo: ${e.message ?: e.javaClass.simpleName}")
    }
    return when {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.BAKLAVA -> outcome(true, "Demo in the notification shade for 30 s (the Live Alerts pill needs Android 16).")
      !canPromote() -> outcome(true, "Demo in the notification shade for 30 s, but Live Updates are off for EDITH, so it can't reach the pill.")
      else -> outcome(true, "Demo running for 30 s: it's in the notification shade now. Leave the app to see the pill.")
    }
  }

  private fun outcome(ok: Boolean, message: String): Map<String, Any> = mapOf("ok" to ok, "message" to message)

  fun clear() {
    main.post {
      EdithSessionService.release(remove = true)
      manager.cancel(NOTIFICATION_ID)
    }
  }

  fun enabled(): Boolean = manager.areNotificationsEnabled()

  /** Android 16: whether EDITH's Live Updates may be promoted (to the chip / Live Alerts). */
  fun canPromote(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA && manager.canPostPromotedNotifications()

  fun openPromotionSettings() {
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
      Intent(ACTION_PROMOTION_SETTINGS)
    } else {
      Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
    }.putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
    } catch (e: ActivityNotFoundException) {
      // a build without the promotion page: EDITH's notification settings instead
      try {
        context.startActivity(
          Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      } catch (ignored: ActivityNotFoundException) {
        // no settings app to open
      }
    }
  }

  private fun post(notification: Notification) {
    try {
      manager.notify(NOTIFICATION_ID, notification)
    } catch (ignored: SecurityException) {
      // notifications not allowed (Android 13+ permission denied): nothing to show
    }
  }

  private fun build(s: LiveStatus, timeoutMs: Long? = null): Notification {
    ensureChannel(context)
    val builder = Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.edith_status_icon)
      .setContentTitle(s.title)
      .setContentText(s.text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setContentIntent(Links.open(context, s.link))
      .setShowWhen(s.startedAt != null)
    // Never claims a task forever (EDITH killed mid-task, a lost turn.done): it times out by itself
    // unless re-posted. JS re-posts a held status at least every 10 min (features/live-status), and
    // EdithSessionService stops at the same deadline.
    builder.setTimeoutAfter(timeoutMs ?: if (s.keepAlive) KEEP_ALIVE_TIMEOUT_MS else STALE_AFTER_MS)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    s.startedAt?.let { builder.setWhen(it).setUsesChronometer(true) }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
      builder.addExtras(Bundle().apply { putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true) })
      if (s.chip.isNotEmpty()) builder.setShortCriticalText(s.chip)
      if (s.progress) builder.setStyle(Notification.ProgressStyle().setProgressIndeterminate(true))
    } else if (s.progress) {
      builder.setProgress(0, 0, true)
    }
    return builder.build()
  }

  companion object {
    const val CHANNEL_ID = "edith_live"
    const val NOTIFICATION_ID = 7110
    private const val TEST_ID = 7112
    private const val TEST_MS = 30_000L
    private const val STALE_AFTER_MS = 30L * 60 * 1000 // no update for 30 min: EDITH is gone, drop it
    const val KEEP_ALIVE_TIMEOUT_MS = 20L * 60 * 1000 // a held status not re-posted for 20 min: let go
    // Notification.EXTRA_REQUEST_PROMOTED_ONGOING (Android 16), by value: the platform Builder has no
    // setter for it (only NotificationCompat does), the extra is how a Live Update is requested.
    private const val EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing"
    // Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS (Android 16), by value
    private const val ACTION_PROMOTION_SETTINGS = "android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS"

    fun ensureChannel(context: Context) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      // Default importance (not MIN/LOW) so the status can be promoted; silent: it only reports.
      val channel = NotificationChannel(CHANNEL_ID, "EDITH live status", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "What EDITH is doing right now: thinking, running a tool, waiting for approval, speaking"
        setSound(null, null)
        enableVibration(false)
        setShowBadge(false)
      }
      manager.createNotificationChannel(channel)
    }
  }
}
