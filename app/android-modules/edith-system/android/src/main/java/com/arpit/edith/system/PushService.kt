package com.arpit.edith.system

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import java.io.IOException
import java.net.HttpURLConnection
import kotlin.random.Random

/**
 * Pushes while the app is closed, always-on mode (contracts/push.md): one long-lived ntfy JSON stream
 * to edith over Tailscale, each message shown as a local notification with the same tag the app
 * uses when open. (The 15-minute check mode is [PushPollJob], with no service.)
 *
 * A foreground service ("specialUse", see the manifest) so OxygenOS doesn't freeze it; its own
 * notification is on a minimum-importance channel (no icon in the status bar). It runs only while
 * Settings → Push is on, from app start or boot. One reader thread; reconnects with jittered backoff
 * (1 s doubling to 5 min, back to 1 s once a stream was open), at once when the default network
 * changes; `?since=<last id>` so nothing is missed in between.
 *
 * Asleep, Object.wait's timeout and the socket's read timeout stop with the CPU, so an inexact
 * allow-while-idle alarm ([PushAlarmReceiver]) wakes it: at the end of each backoff wait, and every
 * [CHECK_MS] while connected to check that a line (ntfy's 5 min keepalive) came in lately. Each
 * reconnect holds a partial wakelock for at most [WAKE_MS].
 */
class PushService : Service() {
  private val lock = Object()
  @Volatile private var stopped = false
  @Volatile private var connection: HttpURLConnection? = null
  @Volatile private var streaming: PushSettings? = null // the settings of the open stream; null while connecting
  @Volatile private var lastLine = 0L // elapsedRealtime of the last line read (counts asleep, too)
  private var wake = false // guarded by lock: skip the backoff wait
  private var reader: Thread? = null
  private var callback: ConnectivityManager.NetworkCallback? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      foreground()
    } catch (e: RuntimeException) {
      // Not allowed now (e.g. ForegroundServiceStartNotAllowedException): it tries again on the next app start.
      state = State(false, "Android didn't allow the background connection; it starts again with the app.")
      stopSelf()
      return START_NOT_STICKY
    }
    val config = PushConfig(this)
    val settings = config.load()
    if (!config.enabled || config.mode != PushConfig.INSTANT || settings == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (reader == null) {
      instance = this
      watchNetwork()
      reader = Thread(::run, "edith-push").apply { isDaemon = true; start() }
    } else if (streaming?.let { it.ntfyUrl != settings.ntfyUrl || it.topic != settings.topic || it.ntfyToken != settings.ntfyToken } == true) {
      connection?.disconnect() // another server or token: reconnect with it (a new App API needs no reconnect)
    }
    return START_STICKY // Android may restart it after killing it for memory
  }

  override fun onDestroy() {
    stopped = true
    if (instance === this) instance = null
    callback?.let { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) }
    (getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(alarmIntent(this))
    connection?.disconnect()
    synchronized(lock) { lock.notifyAll() } // the reader sees `stopped` and ends
    wakeLock(this).release()
    state = State(false, null)
    super.onDestroy()
  }

  private fun run() {
    val config = PushConfig(this)
    var delay = MIN_BACKOFF_MS
    while (!stopped) {
      val settings = config.load() ?: break
      var opened = false
      try {
        wakeLock(this).acquire(WAKE_MS)
        val c = PushNtfy.open(settings, config.lastId, poll = false, readTimeoutMs = READ_TIMEOUT_MS) { connection = it }
        opened = true
        lastLine = SystemClock.elapsedRealtime()
        streaming = settings
        state = State(true, null)
        schedule(CHECK_MS)
        wakeLock(this).release() // connected: lines arriving wake the phone by themselves
        PushNtfy.read(this, c, config, { stopped }) { lastLine = SystemClock.elapsedRealtime() }
      } catch (e: PushNtfy.Refused) {
        state = State(false, e.message)
        delay = MAX_BACKOFF_MS // a wrong token won't fix itself soon: no hammering
      } catch (e: IOException) {
        state = State(false, "Not connected to edith's push server (${e.javaClass.simpleName}).")
      } catch (e: RuntimeException) {
        state = State(false, "Push connection failed: ${e.javaClass.simpleName}.") // never kills the app
      } finally {
        connection = null
        streaming = null
      }
      if (stopped) break
      if (opened) delay = MIN_BACKOFF_MS // it was up (however it ended): start over from 1 s
      val wait = (delay * (0.5 + Random.nextDouble() / 2)).toLong() // jitter: 50–100 % of the step
      schedule(wait) // the wait below doesn't run while the phone sleeps; this alarm wakes it
      wakeLock(this).release()
      try {
        synchronized(lock) {
          if (!wake && !stopped) lock.wait(wait) // returns early on an alarm, a network change or a stop
          wake = false
        }
      } catch (e: InterruptedException) {
        break
      }
      delay = (delay * 2).coerceAtMost(MAX_BACKOFF_MS)
    }
  }

  /** The alarm went off, with the wakelock held: reconnect if waiting, drop a stream gone silent, else check again later. */
  private fun onAlarm() {
    val c = connection
    if (c != null) {
      if (streaming == null) return // connecting now: the reader lets the wakelock go when that's done
      if (SystemClock.elapsedRealtime() - lastLine > READ_TIMEOUT_MS) {
        c.disconnect() // no keepalive for two periods: the socket is dead; the reader reconnects at once
      } else {
        schedule(CHECK_MS)
        wakeLock(this).release()
      }
      return
    }
    synchronized(lock) {
      wake = true
      lock.notifyAll()
    }
  }

  private fun schedule(inMs: Long) {
    val alarms = getSystemService(Context.ALARM_SERVICE) as AlarmManager
    // Inexact: Android batches it, and in Doze runs it at most about every 10 min (enough here).
    alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + inMs, alarmIntent(this))
  }

  /** A new default network (Wi-Fi ↔ mobile): the old socket may hang until its read timeout, so drop it and reconnect now. */
  private fun watchNetwork() {
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        connection?.disconnect()
        synchronized(lock) {
          wake = true
          lock.notifyAll()
        }
      }
    }
    try {
      (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).registerDefaultNetworkCallback(cb)
      callback = cb
    } catch (e: RuntimeException) {
      // too many callbacks registered (never expected): backoff alone still reconnects
    }
  }

  private fun foreground() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Push connection", NotificationManager.IMPORTANCE_MIN).apply {
        description = "Shown while EDITH listens for notifications with the app closed. You can hide this category."
        setShowBadge(false)
      })
    }
    val n = Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.edith_status_icon)
      .setContentTitle("EDITH notifications are on")
      .setContentText("Replies and approvals arrive with the app closed.")
      .setContentIntent(Links.open(this, "edith://live"))
      .setOngoing(true)
      .setShowWhen(false)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, n)
    }
  }

  /** For Settings → Push: connected now, or why not. */
  data class State(val connected: Boolean, val error: String?)

  companion object {
    private const val CHANNEL_ID = "edith_push"
    private const val NOTIFICATION_ID = 7300
    private const val READ_TIMEOUT_MS = 11 * 60_000 // two missed 5 min keepalives, plus a margin
    private const val MIN_BACKOFF_MS = 1_000L
    private const val MAX_BACKOFF_MS = 5 * 60_000L
    private const val CHECK_MS = 15 * 60_000L // while connected: is the stream still alive?
    private const val WAKE_MS = 30_000L // one reconnect: the 15 s connect timeout, plus a margin

    @Volatile var state = State(false, null)
      private set
    @Volatile private var instance: PushService? = null
    private var wakeLock: PowerManager.WakeLock? = null

    @Synchronized
    private fun wakeLock(context: Context): PowerManager.WakeLock = wakeLock
      ?: (context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "edith:push")
        .apply { setReferenceCounted(false) } // one holder at a time; release() always lets go
        .also { wakeLock = it }

    private fun alarmIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
      context, 0, Intent(context, PushAlarmReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** From [PushAlarmReceiver]: keep the CPU up for one reconnect and tell the service. */
    internal fun alarm(context: Context) {
      val service = instance ?: return // stopped meanwhile: nothing to wake
      wakeLock(context).acquire(WAKE_MS)
      service.onAlarm()
    }

    /** Start it if Settings → Push is on in always-on mode (from the app, or at boot). False when Android refused. */
    fun start(context: Context): Boolean {
      val config = PushConfig(context)
      if (!config.enabled || config.mode != PushConfig.INSTANT || config.load() == null) return false
      return try {
        context.startForegroundService(Intent(context, PushService::class.java))
        true
      } catch (e: IllegalStateException) {
        false // Android 12+ from the background (ForegroundServiceStartNotAllowedException)
      } catch (e: SecurityException) {
        false
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, PushService::class.java))
    }
  }
}
