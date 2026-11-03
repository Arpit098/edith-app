package com.arpit.edith.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * The last-message widget's data, in the app's private SharedPreferences: the snapshot the app (or a
 * push) saved, Settings → Widgets → "Show message text in widgets", and this install's link key. No
 * token or address is kept here: the widgets never call edith themselves.
 */
internal class WidgetStore(context: Context) {
  private val app = context.applicationContext
  private val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** On by default (the home screen); the lock screen never shows the text whatever this says. */
  var showText: Boolean
    get() = prefs.getBoolean(KEY_SHOW_TEXT, true)
    set(on) {
      prefs.edit().putBoolean(KEY_SHOW_TEXT, on).apply()
      if (!on) save(load().redacted()) // nothing private stays saved once it's off
    }

  fun load(): WidgetSnapshot = WidgetSnapshot.parse(prefs.getString(KEY_SNAPSHOT, null))

  /**
   * apply(): written in the background, but read back at once from memory (the renderer reads it next).
   * A "working" snapshot also sets one inexact alarm for when it goes stale, so the widget turns grey
   * ("not known") even if the app died mid-turn and nothing else redraws it; any other state cancels it.
   */
  fun save(s: WidgetSnapshot) {
    prefs.edit().putString(KEY_SNAPSHOT, s.toJson().toString()).apply()
    staleCheck(s)
  }

  /**
   * A random key for this install, made on first use and kept here only: the widget's own links carry
   * it, so the app runs Mic and Attach only for them, never for an edith:// link from another app or a page.
   */
  val linkKey: String
    get() = prefs.getString(KEY_LINK, null) ?: synchronized(LOCK) {
      prefs.getString(KEY_LINK, null) ?: ByteArray(16).also { SecureRandom().nextBytes(it) }
        .joinToString("") { "%02x".format(it) }
        .also { prefs.edit().putString(KEY_LINK, it).commit() }
    }

  /** Whether `key` is this install's link key (compared in constant time). */
  fun isLinkKey(key: String?): Boolean =
    !key.isNullOrEmpty() && MessageDigest.isEqual(key.toByteArray(), linkKey.toByteArray())

  private fun staleCheck(s: WidgetSnapshot) {
    val alarms = app.getSystemService(AlarmManager::class.java) ?: return
    val intent = Intent(app, MessageWidgetProvider::class.java).setAction(MessageWidgetProvider.ACTION_STALE)
    val pending = PendingIntent.getBroadcast(app, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    if (s.state != "working" || s.at <= 0) {
      alarms.cancel(pending)
      return
    }
    // RTC (not a wakeup) and inexact: no permission, and it waits for the phone to be awake anyway.
    // The same PendingIntent each time, so a newer save replaces the alarm.
    alarms.set(AlarmManager.RTC, (s.at + WidgetSnapshot.STALE_S + STALE_MARGIN_S) * 1000, pending)
  }

  private companion object {
    const val PREFS = "edith.widget"
    const val KEY_SNAPSHOT = "snapshot.v1"
    const val KEY_SHOW_TEXT = "showText"
    const val KEY_LINK = "linkKey"
    const val STALE_MARGIN_S = 60L // just past the stale point, so the redraw sees it stale
    val LOCK = Any()
  }
}
