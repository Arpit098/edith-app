package com.arpit.edith.glass

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Liquid Glass (PLAN.md §4.11): the GlassView, what the glass may cost (the Android version and
 * battery saver, with an event when it changes) and frame-time measurement.
 */
class EdithGlassModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  // The battery-saver receiver and the context it's registered with: the application context, taken
  // when registering, because the React context getter throws once the JS reloads (ReactContextLost)
  // and a broadcast arriving then must not crash the app.
  private var powerReceiver: BroadcastReceiver? = null
  private var receiverContext: Context? = null
  private var stats: FrameStats? = null

  private fun powerSave(c: Context): Boolean = (c.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode

  private fun unregisterPower() {
    val r = powerReceiver ?: return
    receiverContext?.let { c -> runCatching { c.unregisterReceiver(r) } }
    powerReceiver = null
    receiverContext = null
  }

  override fun definition() = ModuleDefinition {
    Name("EdithGlass")
    Events("onPowerSaveChanged")

    Constant("sdkInt") { Build.VERSION.SDK_INT }

    Function("isPowerSaveMode") { powerSave(context.applicationContext) }

    // The broadcast is registered only while JS listens (no receiver otherwise).
    OnStartObserving("onPowerSaveChanged") {
      if (powerReceiver != null) return@OnStartObserving
      val app = context.applicationContext
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          runCatching { sendEvent("onPowerSaveChanged", mapOf("on" to powerSave(app))) }
        }
      }
      val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
      // A system broadcast: delivered to a not-exported receiver, which other apps can't reach.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        app.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        app.registerReceiver(r, filter)
      }
      powerReceiver = r
      receiverContext = app
    }

    OnStopObserving("onPowerSaveChanged") { unregisterPower() }

    Function("startFrameStats") {
      val window = appContext.currentActivity?.window ?: throw CodedException("NO_WINDOW", "No activity window to measure", null)
      stats?.stop { }
      stats = FrameStats(window).also { it.start() }
    }

    AsyncFunction("stopFrameStats") { promise: Promise ->
      val s = stats ?: return@AsyncFunction promise.resolve(null)
      stats = null
      s.stop { promise.resolve(it) }
    }

    OnDestroy {
      unregisterPower()
      stats?.stop { }
      stats = null
    }

    View(GlassView::class) {
      Name("EdithGlassView")
      Prop("backdrop") { v: GlassView, tag: Int? -> v.setBackdrop(tag) }
      Prop("mode") { v: GlassView, mode: String -> v.mode = mode }
      Prop("cornerRadius") { v: GlassView, r: Float -> v.cornerRadiusDp = r }
      Prop("blur") { v: GlassView, r: Float -> v.blurDp = r }
      Prop("refraction") { v: GlassView, r: Float -> v.refractionDp = r }
      Prop("bezel") { v: GlassView, r: Float -> v.bezelDp = r }
      Prop("dispersion") { v: GlassView, d: Float -> v.dispersionDp = d }
      Prop("lift") { v: GlassView, l: Float -> v.lift = l }
      Prop("rimWidth") { v: GlassView, w: Float -> v.rimWidthDp = w }
      Prop("base") { v: GlassView, c: FloatArray -> if (c.size == 4) v.base = c }
      Prop("saturation") { v: GlassView, s: Float -> v.saturation = s }
      Prop("specular") { v: GlassView, s: Float -> v.specular = s }
      Prop("tint") { v: GlassView, t: FloatArray -> if (t.size == 4) v.tint = t }
    }
  }
}
