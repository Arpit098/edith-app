package com.arpit.edith.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The device side of the HomeWidgets port (core/ports.ts): the app saves the last-message widget's
 * snapshot whenever its chat or status changes, and the "Show message text in widgets" setting
 * (Settings → Widgets). Each save redraws the placed widgets at once. Also the LaunchLinks port:
 * the widget links' key check, and the launch link read once.
 */
class EdithWidgetModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("EdithWidget")

    // What is saved now (pushes may have folded news in while the app was away), so the app starts from it.
    Function("read") { WidgetStore(context).load().toJson().toString() }

    // A snapshot as JSON (core/ports.ts WidgetSnapshot): checked and trimmed here, never trusted as is.
    Function("write") { json: String ->
      val store = WidgetStore(context)
      val s = WidgetSnapshot.parse(json)
      store.save(if (store.showText) s else s.redacted())
      MessageWidgetProvider.updateAll(context)
    }

    Function("showText") { WidgetStore(context).showText }

    // The LaunchLinks port (core/ports.ts). Whether `url` is one of the widget's own links (it carries
    // this install's key): only those may start the microphone or open the attach menu.
    Function("checkLink") { url: String ->
      val key = try { Uri.parse(url).getQueryParameter(WidgetLinks.KEY_PARAM) } catch (e: Exception) { null }
      WidgetStore(context).isLinkKey(key)
    }

    // The link EDITH's activity was started with, once: its data is cleared as it's read, so a JS
    // reload (an OTA update) never runs it again; null for a restore from Recents (Android hands that
    // the old intent again) or when there is none.
    Function("initialLink") {
      val intent = appContext.currentActivity?.intent
      val link = intent?.dataString
      if (intent != null && link != null) {
        intent.data = null
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) null else link
      } else {
        null
      }
    }

    // A link that came while running (onNewIntent) is handled: if it became the activity's intent, clear it too.
    Function("consumeLink") { url: String ->
      val intent = appContext.currentActivity?.intent
      if (intent != null && intent.dataString == url) intent.data = null
    }

    Function("setShowText") { on: Boolean ->
      val store = WidgetStore(context)
      if (store.showText != on) {
        store.showText = on
        MessageWidgetProvider.updateAll(context)
      }
    }
  }
}
