package com.arpit.edith.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * EDITH's last message (4x2; at 4x3 the last 3 and Approve / Deny). Drawn from [WidgetStore]'s
 * snapshot when the app or a push saves one ([updateAll]), and when the launcher asks (placed,
 * resized). Never on a timer: nothing here changes by itself.
 *
 * Privacy: with "Show message text in widgets" off, or on a lock screen (a keyguard host), it says
 * only "New message from EDITH", and no Approve / Deny.
 */
class MessageWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    draw(context, manager, ids)
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    draw(context, manager, intArrayOf(id))
  }

  companion object {
    private const val STALE_S = 3 * 60 * 60L // "working" with no news for this long: not known any more
    private const val TALL_DP = 170 // before Android 12: at least this high (dp) shows 3 messages
    private val COMPACT = SizeF(180f, 80f) // Android 12+: the launcher picks the biggest of these that fits
    private val TALL = SizeF(180f, 170f)

    /** Redraw every placed last-message widget (the app or a push saved news). */
    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, MessageWidgetProvider::class.java))
      if (ids.isNotEmpty()) draw(context, manager, ids)
    }

    private fun draw(context: Context, manager: AppWidgetManager, ids: IntArray) {
      val store = WidgetStore(context)
      val snapshot = store.load()
      val showText = store.showText
      val now = System.currentTimeMillis() / 1000
      for (id in ids) {
        val options = manager.getAppWidgetOptions(id)
        val keyguard = options.getInt(AppWidgetManager.OPTION_APPWIDGET_HOST_CATEGORY, -1) == AppWidgetProviderInfo.WIDGET_CATEGORY_KEYGUARD
        val masked = !showText || keyguard
        val views = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          RemoteViews(mapOf(COMPACT to views(context, snapshot, masked, false, now), TALL to views(context, snapshot, masked, true, now)))
        } else {
          val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0).takeIf { it > 0 }
            ?: options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
          views(context, snapshot, masked, height >= TALL_DP, now)
        }
        manager.updateAppWidget(id, views)
      }
    }

    private fun views(context: Context, s: WidgetSnapshot, masked: Boolean, tall: Boolean, now: Long): RemoteViews {
      val v = RemoteViews(context.packageName, R.layout.edith_widget_message)
      val state = if (s.at == 0L || (s.state == "working" && now - s.at > STALE_S)) "unknown" else s.state
      v.setImageViewResource(R.id.edith_msg_dot, when (state) {
        "working" -> R.drawable.edith_widget_dot_working
        "waiting" -> R.drawable.edith_widget_dot_waiting
        "idle" -> R.drawable.edith_widget_dot_idle
        else -> R.drawable.edith_widget_dot_unknown
      })
      val stateWord = context.getString(when (state) {
        "working" -> R.string.edith_widget_state_working
        "waiting" -> R.string.edith_widget_state_waiting
        "idle" -> R.string.edith_widget_state_idle
        else -> R.string.edith_widget_state_unknown
      })
      v.setContentDescription(R.id.edith_msg_dot, stateWord)

      val newest = s.messages.firstOrNull()
      v.setTextViewText(R.id.edith_msg_time, newest?.let { time(it.ts) } ?: "")
      val hidden = context.getString(R.string.edith_widget_private)
      val first = when {
        newest == null -> context.getString(R.string.edith_widget_empty)
        masked || newest.text.isEmpty() -> hidden
        else -> newest.text
      }
      v.setTextViewText(R.id.edith_msg_1, first)

      // The two before it, at 4x3 and only with text shown ("New message from EDITH" once is enough).
      val older = if (tall && !masked) s.messages.drop(1).filter { it.text.isNotEmpty() } else emptyList()
      listOf(R.id.edith_msg_2, R.id.edith_msg_3).forEachIndexed { i, row ->
        val m = older.getOrNull(i)
        v.setViewVisibility(row, if (m == null) View.GONE else View.VISIBLE)
        if (m != null) v.setTextViewText(row, "${time(m.ts)} · ${m.text}")
      }

      // Approve / Deny at 4x3: they open EDITH's approvals, which asks Arpit to confirm (no silent answer).
      val permission = s.permission.takeIf { tall && !masked && s.state == "waiting" }
      v.setViewVisibility(R.id.edith_msg_actions, if (permission == null) View.GONE else View.VISIBLE)
      if (permission != null) {
        v.setOnClickPendingIntent(R.id.edith_msg_allow, WidgetLinks.open(context, WidgetLinks.answer(permission.id, true)))
        v.setOnClickPendingIntent(R.id.edith_msg_deny, WidgetLinks.open(context, WidgetLinks.answer(permission.id, false)))
      }

      v.setOnClickPendingIntent(R.id.edith_msg_root, WidgetLinks.open(context, WidgetLinks.LIVE))
      v.setContentDescription(R.id.edith_msg_root, listOf(context.getString(R.string.edith_widget_name), stateWord, first).joinToString(", "))
      return v
    }

    /** HH:MM in IST, Arpit's time zone (as everywhere in EDITH), whatever the phone is set to. */
    private fun time(ts: Long): String {
      if (ts <= 0) return ""
      val f = SimpleDateFormat("HH:mm", Locale.US)
      f.timeZone = TimeZone.getTimeZone("Asia/Kolkata")
      return f.format(Date(ts * 1000))
    }
  }
}
