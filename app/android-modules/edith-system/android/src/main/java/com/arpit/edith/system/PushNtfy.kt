package com.arpit.edith.system

import android.content.Context
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Reading edith's ntfy (contracts/push.md), for both modes: [PushService]'s long-lived stream and
 * [PushPollJob]'s 15-minute check (`poll=1`: the waiting messages, then the answer ends).
 */
internal object PushNtfy {
  const val CONNECT_TIMEOUT_MS = 15_000

  /** edith's ntfy refused the token: it won't fix itself, so the caller backs off for long. */
  class Refused(message: String) : IOException(message)

  /** A connection to the topic from `lastId` on, its status already checked (200, or it throws). */
  fun open(s: PushSettings, lastId: String?, poll: Boolean, readTimeoutMs: Int, onConnection: (HttpURLConnection) -> Unit = {}): HttpURLConnection {
    val query = listOfNotNull(
      if (poll) "poll=1" else null,
      lastId?.let { "since=" + URLEncoder.encode(it, "UTF-8") },
    ).joinToString("&")
    val topic = URLEncoder.encode(s.topic, "UTF-8")
    val c = URL("${s.ntfyUrl.trimEnd('/')}/$topic/json" + if (query.isEmpty()) "" else "?$query").openConnection() as HttpURLConnection
    onConnection(c) // the caller may disconnect it from another thread from here on
    c.connectTimeout = CONNECT_TIMEOUT_MS
    c.readTimeout = readTimeoutMs
    c.setRequestProperty("Authorization", "Bearer ${s.ntfyToken}")
    try {
      val code = c.responseCode
      if (code == 401 || code == 403) throw Refused("edith's push server refused the token ($code). Enter the phone token again in Settings → Push.")
      if (code != 200) throw IOException("HTTP $code")
    } catch (e: IOException) {
      c.disconnect()
      throw e
    }
    return c
  }

  /** Every line until the answer ends: messages shown, `lastId` moved on; `onLine` for each line (keepalives too). */
  fun read(context: Context, c: HttpURLConnection, config: PushConfig, stopped: () -> Boolean = { false }, onLine: () -> Unit = {}) {
    try {
      c.inputStream.bufferedReader().useLines { lines ->
        for (line in lines) {
          if (stopped()) break
          onLine()
          val o = try { JSONObject(line) } catch (e: JSONException) { continue }
          if (o.optString("event") != "message") continue // open, keepalive
          show(context, o.optString("message"), config)
          config.lastId = o.optString("id").ifEmpty { null } ?: config.lastId
        }
      }
    } finally {
      c.disconnect()
    }
  }

  /**
   * One push as a local notification, Allow/Deny built here with the App API token. The settings are
   * read again for each one, so an App API that moved since the stream opened is the one used.
   */
  private fun show(context: Context, raw: String, config: PushConfig) {
    val m = try { JSONObject(raw) } catch (e: JSONException) { return }
    val tag = m.optString("tag").ifEmpty { return }
    val notifier = LocalNotifier(context.applicationContext)
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
    val s = config.load()
    if (known && permission.isNotEmpty() && s != null) {
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
}
