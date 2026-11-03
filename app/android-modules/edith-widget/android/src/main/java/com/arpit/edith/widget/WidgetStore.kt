package com.arpit.edith.widget

import android.content.Context

/**
 * The last-message widget's data, in the app's private SharedPreferences: the snapshot the app (or a
 * push) saved, and Settings → Widgets → "Show message text in widgets". No token or address is kept here:
 * the widgets never call edith themselves.
 */
internal class WidgetStore(context: Context) {
  private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** On by default (the home screen); the lock screen never shows the text whatever this says. */
  var showText: Boolean
    get() = prefs.getBoolean(KEY_SHOW_TEXT, true)
    set(on) {
      prefs.edit().putBoolean(KEY_SHOW_TEXT, on).apply()
      if (!on) save(load().redacted()) // nothing private stays saved once it's off
    }

  fun load(): WidgetSnapshot = WidgetSnapshot.parse(prefs.getString(KEY_SNAPSHOT, null))

  /** apply(): written in the background, but read back at once from memory (the renderer reads it next). */
  fun save(s: WidgetSnapshot) {
    prefs.edit().putString(KEY_SNAPSHOT, s.toJson().toString()).apply()
  }

  private companion object {
    const val PREFS = "edith.widget"
    const val KEY_SNAPSHOT = "snapshot.v1"
    const val KEY_SHOW_TEXT = "showText"
  }
}
