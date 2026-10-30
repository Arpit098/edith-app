package com.arpit.edith.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.random.Random

/**
 * A notification button (Allow / Deny) pressed: its App API request is sent from here, without
 * opening the app, and the notification shows how it went. The request (address and token) travels
 * inside the button's PendingIntent, which is explicit, immutable and readable only by EDITH.
 *
 * Each press gets its own thread (one press never waits behind another), and goAsync keeps the
 * broadcast alive meanwhile. A main-thread deadline at [DEADLINE_MS], well inside Android's 10 s,
 * bounds the whole press, DNS included (which HttpURLConnection's timeouts don't cover): whichever
 * of the request and the deadline comes first shows the outcome and finishes the broadcast; a late
 * answer is dropped. Retries only when the server wasn't reached or answered 502/503/504, with a
 * jittered, bounded backoff.
 */
class NotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val raw = intent.getStringExtra(EXTRA_NOTIFICATION) ?: return
    val n = try {
      LocalNotification.parse(raw)
    } catch (e: org.json.JSONException) {
      return
    }
    val action = n.actions.getOrNull(intent.getIntExtra(EXTRA_ACTION, -1)) ?: return
    val notifier = LocalNotifier(context.applicationContext)
    notifier.show(n, note = "Sending…", buttons = false) // no second press while this one is out
    val pending = goAsync()
    val done = AtomicBoolean(false)
    val main = Handler(Looper.getMainLooper())
    fun finish(status: Int) {
      if (!done.compareAndSet(false, true)) return // the other side got there first
      when (status) {
        in 200..299 -> notifier.show(n, note = action.done, buttons = false, dismissAfterMs = DISMISS_MS)
        404 -> notifier.show(n, note = "Already answered or expired", buttons = false, dismissAfterMs = DISMISS_MS)
        else -> notifier.show(n, note = if (status == 0) "Couldn't reach EDITH. Try again" else "EDITH answered $status. Try again")
      }
      pending.finish()
    }
    val deadline = Runnable { finish(0) }
    main.postDelayed(deadline, DEADLINE_MS)
    Thread({
      val status = send(action, SystemClock.elapsedRealtime() + DEADLINE_MS - MARGIN_MS)
      main.removeCallbacks(deadline)
      finish(status)
    }, "edith-notification-action").apply { isDaemon = true }.start()
  }

  /** The HTTP status, or 0 when the server wasn't reached before `deadline` (elapsedRealtime ms). */
  private fun send(a: LocalAction, deadline: Long): Int {
    var backoff = FIRST_BACKOFF_MS
    while (true) {
      val left = deadline - SystemClock.elapsedRealtime()
      val status = attempt(a, minOf(ATTEMPT_MS, left).toInt().coerceAtLeast(MIN_ATTEMPT_MS))
      if (status !in RETRY) return status
      val wait = backoff + Random.nextLong(backoff / 2 + 1)
      if (deadline - SystemClock.elapsedRealtime() < wait + MIN_ATTEMPT_MS) return status
      Thread.sleep(wait) // bounded backoff between retries, on the worker thread
      backoff *= 2
    }
  }

  private fun attempt(a: LocalAction, timeoutMs: Int): Int {
    var conn: HttpURLConnection? = null
    return try {
      val c = URL(a.url).openConnection() as HttpURLConnection
      conn = c
      c.requestMethod = a.method
      c.connectTimeout = timeoutMs
      c.readTimeout = timeoutMs
      a.headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
      if (a.body.isNotEmpty()) {
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(a.body.toByteArray()) }
      }
      c.responseCode
    } catch (e: IOException) {
      0
    } finally {
      conn?.disconnect()
    }
  }

  companion object {
    const val EXTRA_NOTIFICATION = "com.arpit.edith.notification"
    const val EXTRA_ACTION = "com.arpit.edith.action"
    private const val DEADLINE_MS = 7_000L // the whole press; Android's limit for a foreground broadcast is 10 s
    private const val MARGIN_MS = 500L // the request stops trying this long before the deadline
    private const val ATTEMPT_MS = 3_000L
    private const val MIN_ATTEMPT_MS = 1_000
    private const val FIRST_BACKOFF_MS = 400L
    private const val DISMISS_MS = 4_000L
    private val RETRY = setOf(0, 502, 503, 504)
  }
}
