package com.arpit.edith.system

import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** core/ports.ts OngoingStatusView, as JS sends it. */
class StatusRecord : Record {
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val chip: String = ""
  @Field val startedAt: Double? = null
  @Field val progress: Boolean = false
  @Field val link: String = "edith://live"
  @Field val keepAlive: Boolean = false

  fun toStatus() = LiveStatus(title, text, chip, startedAt?.toLong(), progress, link, keepAlive)
}

/** core/ports.ts PushSetup, as JS sends it. */
class PushRecord : Record {
  @Field val ntfyUrl: String = ""
  @Field val topic: String = "edith"
  @Field val ntfyToken: String = ""
  @Field val apiUrl: String = ""
  @Field val apiToken: String = ""

  fun toSettings() = PushSettings(ntfyUrl, topic, ntfyToken, apiUrl, apiToken)
}

/**
 * The device side of the OngoingStatus, Notifier and PushReceiver ports: EDITH's live status
 * (LiveStatusNotifier, with EdithSessionService while a turn runs), its one-off notifications
 * (LocalNotifier), and pushes while the app is closed (PushService).
 */
class EdithSystemModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val status by lazy { LiveStatusNotifier(context.applicationContext) }
  private val local by lazy { LocalNotifier(context.applicationContext) }
  private val push by lazy { Push(context.applicationContext) }

  override fun definition() = ModuleDefinition {
    Name("EdithSystem")

    Constant("sdkInt") { Build.VERSION.SDK_INT }

    // JS is gone: nothing may claim a running task, and nothing should keep EDITH alive.
    OnDestroy { if (SUPPORTED) appContext.reactContext?.let { LiveStatusNotifier(it.applicationContext).clear() } }

    // Channels and foreground-service starts need Android 8 (API 26); the app's minSdk is 24. JS
    // offers no ports below that (adapters/system/android), and these stay inert there too.
    Function("showStatus") { s: StatusRecord -> if (SUPPORTED) status.show(s.toStatus()) }
    Function("clearStatus") { if (SUPPORTED) status.clear() }
    Function("notify") { json: String -> if (SUPPORTED) local.show(LocalNotification.parse(json)) }
    Function("cancel") { tag: String -> if (SUPPORTED) local.cancel(tag) }
    Function("activeTags") { if (SUPPORTED) local.activeTags() else emptyList() }
    Function("notificationsEnabled") { status.enabled() }
    Function("canPromote") { status.canPromote() }
    Function("openPromotionSettings") { if (SUPPORTED) status.openPromotionSettings() }
    Function("testIsland") { if (SUPPORTED) status.testIsland() else mapOf("ok" to false, "message" to "Needs Android 8 or newer.") }
    Function("pushEnable") { s: PushRecord -> SUPPORTED && push.enable(s.toSettings()) }
    Function("pushUpdateApi") { apiUrl: String, apiToken: String -> if (SUPPORTED) push.updateApi(apiUrl, apiToken) }
    Function("pushResume") { SUPPORTED && push.resume() }
    Function("pushDisable") { if (SUPPORTED) push.disable() }
    Function("pushStatus") { if (SUPPORTED) push.status() else mapOf("enabled" to false) }
    Function("openBatterySettings") { if (SUPPORTED) push.openBatterySettings() }
  }
}

private val SUPPORTED = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
