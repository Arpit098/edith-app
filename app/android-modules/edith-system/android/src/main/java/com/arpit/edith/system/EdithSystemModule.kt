package com.arpit.edith.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** What JS wants the live status to say (the wording is decided and tested in JS). */
class StatusRecord : Record {
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val chip: String = "" // the short text in the status-bar chip / Live Alerts pill
  @Field val startedAt: Double? = null // unix ms: shown as a running timer (no per-second updates)
  @Field val progress: Boolean = false // indeterminate progress (a task is running)
  @Field val link: String = "edith://live" // opened on tap
  @Field val alert: Boolean = false // make a sound/peek once (an approval is waiting)
}

/**
 * Device bits for the app shell and the OngoingStatus port: battery saver (the glass falls back to
 * flat when it's on) and EDITH's live status notification (LiveStatusNotifier).
 */
class EdithSystemModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val notifier by lazy { LiveStatusNotifier(context) }
  private var powerReceiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("EdithSystem")

    Events("onPowerSaveChanged")

    Constant("sdkInt") { Build.VERSION.SDK_INT }

    Function("isPowerSaveMode") { powerManager().isPowerSaveMode }

    // The receiver exists only while JS listens for changes.
    OnStartObserving("onPowerSaveChanged") {
      if (powerReceiver != null) return@OnStartObserving
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
          sendEvent("onPowerSaveChanged", mapOf("on" to powerManager().isPowerSaveMode))
        }
      }
      val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED) // system broadcasts still arrive
      } else {
        context.registerReceiver(receiver, filter)
      }
      powerReceiver = receiver
    }
    OnStopObserving("onPowerSaveChanged") { stopPowerReceiver() }
    OnDestroy {
      stopPowerReceiver()
      notifier.clear()
    }

    Function("showStatus") { status: StatusRecord -> notifier.show(status) }
    Function("clearStatus") { notifier.clear() }
    Function("notificationsEnabled") { notifier.enabled() }
    Function("canPromote") { notifier.canPromote() }
    Function("openPromotionSettings") { notifier.openPromotionSettings() }
  }

  private fun powerManager() = context.getSystemService(Context.POWER_SERVICE) as PowerManager

  private fun stopPowerReceiver() {
    powerReceiver?.let {
      try {
        context.unregisterReceiver(it)
      } catch (ignored: IllegalArgumentException) {
        // already gone
      }
    }
    powerReceiver = null
  }
}
