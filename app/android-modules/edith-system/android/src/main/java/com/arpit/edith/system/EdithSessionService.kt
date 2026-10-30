package com.arpit.edith.system

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps EDITH running while a turn is in progress or an approval waits, so the stream (and with it
 * the live status and the notifications) carries on with the app in the background. It does no work
 * of its own: it only holds the live status notification as a foreground service ("specialUse", see
 * the manifest) and stops the moment the turn is over.
 *
 * Driven by [LiveStatusNotifier] on the main thread only (so no locking). Android 12+ refuses to
 * start it from the background; then the status is a plain notification and EDITH may be paused
 * like any background app (accepted: a turn almost always starts from the open app).
 */
class EdithSessionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    starting = false
    val notification = wanted
    if (notification == null) {
      // Released before Android got here. startForeground is still owed (Android crashes the app
      // otherwise): do it with a placeholder under its own id, so the real status isn't touched.
      LiveStatusNotifier.ensureChannel(this)
      foreground(PLACEHOLDER_ID, Notification.Builder(this, LiveStatusNotifier.CHANNEL_ID).setSmallIcon(R.drawable.edith_status_icon).build())
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      foreground(LiveStatusNotifier.NOTIFICATION_ID, notification)
      instance = this
    } catch (e: RuntimeException) {
      // Not allowed now (e.g. ForegroundServiceStartNotAllowedException): the notification stays plain.
      stopSelf()
    }
    return START_NOT_STICKY // never restarted without the app: JS decides when it runs
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun foreground(id: Int, notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(id, notification)
    }
  }

  companion object {
    private const val PLACEHOLDER_ID = 7111
    private var wanted: Notification? = null // what the service should show; null: it should stop
    private var instance: EdithSessionService? = null
    private var starting = false

    /** Show `notification` as the live status and keep EDITH alive (main thread). */
    fun hold(context: Context, notification: Notification) {
      wanted = notification
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      try {
        manager.notify(LiveStatusNotifier.NOTIFICATION_ID, notification) // updates the service's, or shows it plain
      } catch (ignored: SecurityException) {
        // notifications not allowed: the service still keeps the stream alive
      }
      if (instance != null || starting) return
      try {
        context.startForegroundService(Intent(context, EdithSessionService::class.java))
        starting = true
      } catch (e: IllegalStateException) {
        // Android 12+ from the background (ForegroundServiceStartNotAllowedException): stay plain.
      } catch (e: SecurityException) {
        // the foreground service permission is missing: stay plain
      }
    }

    /** Stop keeping EDITH alive (main thread). `remove`: also take the notification down. */
    fun release(remove: Boolean) {
      wanted = null
      starting = false
      val service = instance ?: return
      instance = null
      service.stopForeground(if (remove) Service.STOP_FOREGROUND_REMOVE else Service.STOP_FOREGROUND_DETACH)
      service.stopSelf()
    }
  }
}
