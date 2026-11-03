package com.arpit.edith.widget

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The device side of the HomeWidgets port (core/ports.ts): the app saves the last-message widget's
 * snapshot whenever its chat or status changes, and the "Show message text in widgets" setting
 * (Settings → Widgets). Each save redraws the placed widgets at once.
 */
class EdithWidgetModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("EdithWidget")

    // A snapshot as JSON (core/ports.ts WidgetSnapshot): checked and trimmed here, never trusted as is.
    // What is saved now (pushes may have folded news in while the app was away), so the app starts from it.
    Function("read") { WidgetStore(context).load().toJson().toString() }

    Function("write") { json: String ->
      val store = WidgetStore(context)
      val s = WidgetSnapshot.parse(json)
      store.save(if (store.showText) s else s.redacted())
      MessageWidgetProvider.updateAll(context)
    }

    Function("showText") { WidgetStore(context).showText }

    Function("setShowText") { on: Boolean ->
      val store = WidgetStore(context)
      if (store.showText != on) {
        store.showText = on
        MessageWidgetProvider.updateAll(context)
      }
    }
  }
}
