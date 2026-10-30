package com.arpit.edith.system

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * EDITH's live status as one ongoing notification (PLAN.md §4.11).
 *
 * Android 16+: a promoted ongoing notification ("Live Update", `setRequestPromotedOngoing`) with
 * `ProgressStyle` and a short chip text; OxygenOS 16 shows these in the Live Alerts pill once Arpit
 * allows it for EDITH. Older Android: the same notification, just not promoted.
 *
 * Updates come from stream events (JS throttles them); the elapsed time is a chronometer, so the
 * notification never needs a per-second refresh. If EDITH is killed mid-task, the notification
 * times out by itself instead of claiming a task forever.
 */
class LiveStatusNotifier(private val context: Context) {
  private val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  fun show(s: StatusRecord) {
    ensureChannel()
    val builder = Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.edith_status_icon)
      .setContentTitle(s.title)
      .setContentText(s.text)
      .setOngoing(true)
      .setOnlyAlertOnce(!s.alert)
      .setCategory(if (s.alert) Notification.CATEGORY_REMINDER else Notification.CATEGORY_PROGRESS)
      .setContentIntent(openIntent(s.link))
      .setTimeoutAfter(STALE_AFTER_MS)
      .setShowWhen(s.startedAt != null)
    s.startedAt?.let {
      builder.setWhen(it.toLong()).setUsesChronometer(true)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
      builder.setRequestPromotedOngoing(true)
      if (s.chip.isNotEmpty()) builder.setShortCriticalText(s.chip)
      if (s.progress) builder.setStyle(Notification.ProgressStyle().setProgressIndeterminate(true))
    } else if (s.progress) {
      builder.setProgress(0, 0, true)
    }
    try {
      manager.notify(NOTIFICATION_ID, builder.build())
    } catch (ignored: SecurityException) {
      // notifications not allowed (Android 13+ permission denied): nothing to show
    }
  }

  fun clear() = manager.cancel(NOTIFICATION_ID)

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

  private fun ensureChannel() {
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    // Default importance (not MIN/LOW) so the status can be promoted; silent unless an update asks to alert.
    val channel = NotificationChannel(CHANNEL_ID, "EDITH live status", NotificationManager.IMPORTANCE_DEFAULT).apply {
      description = "What EDITH is doing right now: listening, thinking, a running task, an approval waiting"
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun openIntent(link: String): PendingIntent {
    val launch = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
      .setAction(Intent.ACTION_VIEW)
      .setData(Uri.parse(link))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  companion object {
    private const val CHANNEL_ID = "edith_live"
    private const val NOTIFICATION_ID = 7110
    private const val STALE_AFTER_MS = 30L * 60 * 1000 // no update for 30 min: EDITH is gone, drop it
    // Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS (Android 16), by value
    private const val ACTION_PROMOTION_SETTINGS = "android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS"
  }
}
