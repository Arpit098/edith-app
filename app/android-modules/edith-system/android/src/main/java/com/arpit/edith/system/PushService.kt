package com.arpit.edith.system

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlin.random.Random
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Pushes while the app is closed (contracts/push.md): one long-lived ntfy JSON stream to edith over
 * Tailscale, each message shown as a local notification with the same tag the app uses when open.
 *
 * A foreground service ("specialUse", see the manifest) so OxygenOS doesn't freeze it; its own
 * notification is on a minimum-importance channel (no icon in the status bar). It runs only while
 * Settings → Push is on, from app start or boot. One reader thread; reconnects with jittered backoff
 * (1 s doubling to 5 min), at once when the default network changes; `?since=<last id>` so nothing
 * is missed in between. ntfy sends a keepalive every 5 min (deploy/ntfy/server.yml), so a read that
 * stays silent for [READ_TIMEOUT_MS] means a dead connection.
 */
class PushService : Service() {
  private val lock = Object()
  @Volatile private var stopped = false
  @Volatile private var connection: HttpURLConnection? = null
  private var wake = false // guarded by lock: the network changed, skip the backoff wait
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
    if (!config.enabled || config.load() == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (reader == null) {
      watchNetwork()
      reader = Thread(::run, "edith-push").apply { isDaemon = true; start() }
    } else {
      connection?.disconnect() // new settings: reconnect with them
    }
    return START_STICKY // Android may restart it after killing it for memory
  }

  override fun onDestroy() {
    stopped = true
    callback?.let { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) }
    connection?.disconnect()
    synchronized(lock) { lock.notifyAll() } // the reader sees `stopped` and ends
    state = State(false, null)
    super.onDestroy()
  }

  private fun run() {
    val config = PushConfig(this)
    var delay = MIN_BACKOFF_MS
    while (!stopped) {
      val settings = config.load() ?: break
      try {
        if (read(settings, config)) delay = MIN_BACKOFF_MS
      } catch (e: Refused) {
        state = State(false, e.message)
        delay = MAX_BACKOFF_MS // a wrong token won't fix itself soon: no hammering
      } catch (e: IOException) {
        state = State(false, "Not connected to edith's push server (${e.javaClass.simpleName}).")
      } catch (e: RuntimeException) {
        state = State(false, "Push connection failed: ${e.javaClass.simpleName}.") // never kills the app
      } finally {
        connection = null
      }
      if (stopped) break
      val wait = (delay * (0.5 + Random.nextDouble() / 2)).toLong() // jitter: 50–100 % of the step
      try {
        synchronized(lock) {
          if (!wake && !stopped) lock.wait(wait) // returns early when the network changes or the service stops
          wake = false
        }
      } catch (e: InterruptedException) {
        break
      }
      delay = (delay * 2).coerceAtMost(MAX_BACKOFF_MS)
    }
  }

  /** One connection, until it drops. True when it was open (the backoff starts over). */
  private fun read(s: PushSettings, config: PushConfig): Boolean {
    val since = config.lastId?.let { "?since=" + URLEncoder.encode(it, "UTF-8") } ?: ""
    val c = URL("${s.ntfyUrl.trimEnd('/')}/${URLEncoder.encode(s.topic, "UTF-8")}/json$since").openConnection() as HttpURLConnection
    connection = c
    if (stopped) return false
    c.connectTimeout = CONNECT_TIMEOUT_MS
    c.readTimeout = READ_TIMEOUT_MS
    c.setRequestProperty("Authorization", "Bearer ${s.ntfyToken}")
    try {
      val code = c.responseCode
      if (code == 401 || code == 403) throw Refused("edith's push server refused the token ($code). Enter the phone token again in Settings → Push.")
      if (code != 200) throw IOException("HTTP $code")
      state = State(true, null)
      c.inputStream.bufferedReader().useLines { lines ->
        for (line in lines) {
          if (stopped) break
          val o = try { JSONObject(line) } catch (e: JSONException) { continue }
          if (o.optString("event") != "message") continue // open, keepalive
          show(o.optString("message"), s)
          config.lastId = o.optString("id").ifEmpty { null } ?: config.lastId
        }
      }
      return true
    } finally {
      c.disconnect()
    }
  }

  /** One push (contracts/push.md) as a local notification, Allow/Deny built here with the App API token. */
  private fun show(raw: String, s: PushSettings) {
    val m = try { JSONObject(raw) } catch (e: JSONException) { return }
    val tag = m.optString("tag").ifEmpty { return }
    val notifier = LocalNotifier(applicationContext)
    if (m.optBoolean("cancel")) {
      notifier.cancel(tag)
      return
    }
    val known = m.optInt("v", 1) == 1
    val n = JSONObject()
      .put("channel", m.optString("channel", "replies"))
      .put("tag", tag)
      .put("title", m.optString("title", "EDITH"))
      .put("text", m.optString("text"))
      .put("link", m.optString("link", "edith://live"))
    val permission = m.optString("permission")
    if (known && permission.isNotEmpty()) {
      val url = "${s.apiUrl.trimEnd('/')}/v1/permissions/${URLEncoder.encode(permission, "UTF-8")}"
      n.put("actions", JSONArray().put(answer("Deny", false, url, s)).put(answer("Allow", true, url, s)))
    }
    notifier.show(LocalNotification.parse(n.toString()))
  }

  private fun answer(label: String, allow: Boolean, url: String, s: PushSettings) = JSONObject()
    .put("label", label)
    .put("done", if (allow) "Allowed" else "Denied")
    .put("request", JSONObject()
      .put("method", "POST")
      .put("url", url)
      .put("headers", JSONObject().put("Authorization", "Bearer ${s.apiToken}"))
      .put("body", JSONObject().put("allow", allow)))

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

  private class Refused(message: String) : IOException(message)

  /** For Settings → Push: connected now, or why not. */
  data class State(val connected: Boolean, val error: String?)

  companion object {
    private const val CHANNEL_ID = "edith_push"
    private const val NOTIFICATION_ID = 7300
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 11 * 60_000 // two missed 5 min keepalives, plus a margin
    private const val MIN_BACKOFF_MS = 1_000L
    private const val MAX_BACKOFF_MS = 5 * 60_000L

    @Volatile var state = State(false, null)
      private set

    /** Start it if Settings → Push is on (from the app, or at boot). False when Android refused. */
    fun start(context: Context): Boolean {
      val config = PushConfig(context)
      if (!config.enabled || config.load() == null) return false
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
