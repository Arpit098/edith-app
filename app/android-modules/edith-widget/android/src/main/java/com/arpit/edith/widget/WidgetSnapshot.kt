package com.arpit.edith.widget

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** One line on the last-message widget: a reply (`alert` false) or an alert (approval, error, reminder). */
internal data class WidgetMessage(val text: String, val ts: Long, val alert: Boolean)

/** The approval waiting for Arpit, for Approve / Deny at 4x3. */
internal data class WidgetPermission(val id: String, val text: String)

/**
 * What the last-message widget draws (the app's core/ports.ts WidgetSnapshot, v1). The app writes it
 * whenever its chat or status changes; a push folds itself in while the app isn't running ([fold]).
 *
 * - `at`: when it was last updated (unix seconds), so a "working" nobody updated for hours shows as unknown.
 * - `state`: `working`, `idle` or `waiting` (on Arpit: an approval).
 * - `messages`: newest first, at most [MAX_MESSAGES].
 * - `hidden`: the texts were left out ("Show message text in widgets" off): the widget says only
 *   "New message from EDITH".
 */
internal data class WidgetSnapshot(
  val at: Long,
  val state: String,
  val messages: List<WidgetMessage>,
  val permission: WidgetPermission?,
  val hidden: Boolean,
) {
  fun toJson(): JSONObject {
    val list = JSONArray()
    messages.forEach { list.put(JSONObject().put("text", it.text).put("ts", it.ts).put("alert", it.alert)) }
    return JSONObject()
      .put("v", 1)
      .put("at", at)
      .put("state", state)
      .put("messages", list)
      .put("permission", permission?.let { JSONObject().put("id", it.id).put("text", it.text) } ?: JSONObject.NULL)
      .put("hidden", hidden)
  }

  /** Without any message text (the setting was turned off): nothing private stays saved. */
  fun redacted() = copy(messages = messages.map { it.copy(text = "") }, permission = permission?.copy(text = ""), hidden = true)

  companion object {
    const val MAX_MESSAGES = 3
    const val MAX_TEXT = 300 // a push's text is at most 300 characters too (contracts/push.md)
    val STATES = setOf("working", "idle", "waiting")
    val EMPTY = WidgetSnapshot(0, "idle", emptyList(), null, false)

    /** A saved or app-written snapshot; anything malformed or from a newer major version is [EMPTY]. */
    fun parse(raw: String?): WidgetSnapshot {
      if (raw.isNullOrEmpty()) return EMPTY
      return try {
        val o = JSONObject(raw)
        if (o.optInt("v", 1) != 1) return EMPTY
        val list = o.optJSONArray("messages") ?: JSONArray()
        val messages = (0 until minOf(list.length(), MAX_MESSAGES)).mapNotNull { i ->
          list.optJSONObject(i)?.let { WidgetMessage(it.optString("text").take(MAX_TEXT), it.optLong("ts"), it.optBoolean("alert")) }
        }
        val p = o.optJSONObject("permission")
        WidgetSnapshot(
          at = o.optLong("at"),
          state = o.optString("state").takeIf { it in STATES } ?: "idle",
          messages = messages,
          permission = p?.optString("id")?.takeIf { it.isNotEmpty() }?.let { WidgetPermission(it, p.optString("text").take(MAX_TEXT)) },
          hidden = o.optBoolean("hidden"),
        )
      } catch (e: JSONException) {
        EMPTY
      }
    }

    /**
     * A push message (contracts/push.md "Message") folded into `s`, or null when it changes nothing
     * the widget shows (an update alert, a cancel of something else, garbage). `now` is unix seconds.
     *
     * - `approvals` → "🔐 <title> <text>", waiting on Arpit, with its id for Approve / Deny;
     * - a cancel of the waiting approval's `perm:<id>` (answered or timed out) → working again (the turn goes on);
     * - `errors` → "⚠️ …", idle; `reminders` → "⏰ …", state kept; `replies` (and anything else) → the text, idle.
     */
    fun fold(s: WidgetSnapshot, raw: String, now: Long, showText: Boolean): WidgetSnapshot? {
      val m = try { JSONObject(raw) } catch (e: JSONException) { return null }
      val tag = m.optString("tag")
      if (tag.isEmpty()) return null
      if (m.optBoolean("cancel")) {
        val waiting = s.permission ?: return null
        if (tag != "perm:${waiting.id}") return null
        return s.copy(at = now, state = "working", permission = null)
      }
      val channel = m.optString("channel", "replies")
      if (channel == "updates") return null
      val known = m.optInt("v", 1) == 1
      val title = m.optString("title").trim()
      val text = m.optString("text").trim()
      val both = listOf(title, text).filter { it.isNotEmpty() }.joinToString(" ")
      val waiting = s.permission
      val (line, alert, state, permission) = when (channel) {
        "approvals" -> {
          val id = if (known) m.optString("permission") else ""
          Fold("🔐 $both", true, "waiting", if (id.isNotEmpty()) WidgetPermission(id, both) else waiting)
        }
        "errors" -> Fold("⚠️ $both", true, if (waiting != null) "waiting" else "idle", waiting)
        "reminders" -> Fold("⏰ ${text.ifEmpty { title }}", true, s.state, waiting)
        else -> Fold(text.ifEmpty { title }, false, if (waiting != null) "waiting" else "idle", waiting)
      }
      val message = WidgetMessage(if (showText) line.take(MAX_TEXT) else "", now, alert)
      val next = WidgetSnapshot(now, state, (listOf(message) + s.messages).take(MAX_MESSAGES), permission, !showText)
      return if (showText) next else next.redacted()
    }
  }
}

private data class Fold(val line: String, val alert: Boolean, val state: String, val permission: WidgetPermission?)
