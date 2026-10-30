package com.arpit.edith.system

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
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
  val alert: Boolean, // make a sound/peek once (an approval is waiting)
  val keepAlive: Boolean, // a turn runs or an approval waits: hold the foreground service
)

/**
 * EDITH's live status as one ongoing notification (PLAN.md §4.11).
 *
 * Android 16+: a promoted ongoing notification ("Live Update", `setRequestPromotedOngoing`) with
 * `ProgressStyle` and a short chip text; OxygenOS 16 shows these in the Live Alerts pill once Arpit
 * allows it for EDITH. Older Android: the same notification, just not promoted.
 *
 * Updates come from stream events (JS throttles them); the elapsed time is a chronometer, so the
 * notification never needs a per-second refresh. While `keepAlive` is set the notification belongs
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
    context.startActivity(intent)
  }

  private fun post(notification: Notification) {
    try {
      manager.notify(NOTIFICATION_ID, notification)
    } catch (ignored: SecurityException) {
      // notifications not allowed (Android 13+ permission denied): nothing to show
    }
  }

  private fun build(s: LiveStatus): Notification {
    ensureChannel(context)
    val builder = Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.edith_status_icon)
      .setContentTitle(s.title)
      .setContentText(s.text)
      .setOngoing(true)
      .setOnlyAlertOnce(!s.alert)
      .setCategory(if (s.alert) Notification.CATEGORY_REMINDER else Notification.CATEGORY_PROGRESS)
      .setContentIntent(Links.open(context, s.link))
      .setShowWhen(s.startedAt != null)
    // A foreground service's notification lives as long as the service; any other one times out by
    // itself if EDITH is killed mid-task, instead of claiming a task forever.
    if (!s.keepAlive) builder.setTimeoutAfter(STALE_AFTER_MS)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    s.startedAt?.let { builder.setWhen(it).setUsesChronometer(true) }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
      builder.setRequestPromotedOngoing(true)
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
    private const val STALE_AFTER_MS = 30L * 60 * 1000 // no update for 30 min: EDITH is gone, drop it
    // Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS (Android 16), by value
    private const val ACTION_PROMOTION_SETTINGS = "android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS"

    fun ensureChannel(context: Context) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      // Default importance (not MIN/LOW) so the status can be promoted; silent unless an update asks to alert.
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
