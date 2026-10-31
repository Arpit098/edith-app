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

  /** Save the settings, turn pushes on in `mode` and start (the app is in front). False: Android refused. */
  fun enable(s: PushSettings, mode: String): Boolean {
    config.save(s)
    if (config.lastId == null) config.lastId = (System.currentTimeMillis() / 1000).toString() // from now on (ntfy takes a unix time)
    config.enabled = true
    return setMode(mode)
  }

  /** Always-on ([PushConfig.INSTANT]) or every 15 minutes ([PushConfig.POLL]): the other one stops. */
  fun setMode(mode: String): Boolean {
    config.mode = if (mode == PushConfig.POLL) PushConfig.POLL else PushConfig.INSTANT
    if (config.mode == PushConfig.POLL) PushService.stop(context) else PushPollJob.cancel(context)
    return resume()
  }

  /** A new App API address or token (the app reconnected elsewhere): Allow/Deny use it from now on. */
  fun updateApi(apiUrl: String, apiToken: String) {
    val s = config.load() ?: return
    if (s.apiUrl != apiUrl || s.apiToken != apiToken) config.save(s.copy(apiUrl = apiUrl, apiToken = apiToken))
  }

  /** At app start (or boot): make sure the service runs or the check is scheduled, if pushes are on. Harmless when it already does. */
  fun resume(): Boolean {
    if (!config.enabled || config.load() == null) return false
    return if (config.mode == PushConfig.POLL) PushPollJob.schedule(context) else PushService.start(context)
  }

  fun disable() {
    config.clear() // the tokens too
    PushService.stop(context)
    PushPollJob.cancel(context)
  }

  fun status(): Map<String, Any?> {
    val s = config.load()
    val poll = config.mode == PushConfig.POLL
    val connected: Boolean
    val error: String?
    if (poll) {
      PushPollJob.state.let { connected = it.ok; error = it.error }
    } else {
      PushService.state.let { connected = it.connected; error = it.error }
    }
    return mapOf(
      "enabled" to (config.enabled && s != null),
      "ntfyUrl" to s?.ntfyUrl,
      "mode" to config.mode,
      "connected" to connected,
      "error" to error,
      "lastCheckAt" to config.lastCheck.takeIf { it > 0 }?.toDouble(),
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
