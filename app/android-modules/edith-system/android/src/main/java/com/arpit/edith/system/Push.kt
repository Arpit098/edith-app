package com.arpit.edith.system

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/** Settings → Push, for the module: turn pushes on or off, and how they're doing. */
internal class Push(private val context: Context) {
  private val config = PushConfig(context)

  /** Save the settings, turn pushes on and start the service (the app is in front). False: Android refused to start it. */
  fun enable(s: PushSettings): Boolean {
    config.save(s)
    config.enabled = true
    return PushService.start(context)
  }

  /** A new App API address or token (the app reconnected elsewhere): Allow/Deny use it from now on. */
  fun updateApi(apiUrl: String, apiToken: String) {
    val s = config.load() ?: return
    if (s.apiUrl != apiUrl || s.apiToken != apiToken) config.save(s.copy(apiUrl = apiUrl, apiToken = apiToken))
  }

  /** At app start: (re)start the service if pushes are on. */
  fun resume(): Boolean = PushService.start(context)

  fun disable() {
    config.clear() // the tokens too
    PushService.stop(context)
  }

  fun status(): Map<String, Any?> {
    val s = config.load()
    val state = PushService.state
    return mapOf(
      "enabled" to (config.enabled && s != null),
      "ntfyUrl" to s?.ntfyUrl,
      "connected" to state.connected,
      "error" to state.error,
      "batteryUnrestricted" to (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName),
    )
  }

  /** EDITH's app page, where OxygenOS keeps "Battery → Unrestricted" (no permission needed to open it). */
  fun openBatterySettings() {
    try {
      context.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    } catch (ignored: ActivityNotFoundException) {
      // no settings app to open
    }
  }
}
