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
  @Field val alert: Boolean = false
  @Field val keepAlive: Boolean = false

  fun toStatus() = LiveStatus(title, text, chip, startedAt?.toLong(), progress, link, alert, keepAlive)
}

/**
 * The device side of the OngoingStatus and Notifier ports: EDITH's live status (LiveStatusNotifier,
 * with EdithSessionService while a turn runs) and its one-off notifications (LocalNotifier).
 */
class EdithSystemModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val status by lazy { LiveStatusNotifier(context.applicationContext) }
  private val local by lazy { LocalNotifier(context.applicationContext) }

  override fun definition() = ModuleDefinition {
    Name("EdithSystem")

    Constant("sdkInt") { Build.VERSION.SDK_INT }

    // JS is gone: nothing may claim a running task, and nothing should keep EDITH alive.
    OnDestroy { appContext.reactContext?.let { LiveStatusNotifier(it.applicationContext).clear() } }

    Function("showStatus") { s: StatusRecord -> status.show(s.toStatus()) }
    Function("clearStatus") { status.clear() }
    Function("notify") { json: String -> local.show(LocalNotification.parse(json)) }
    Function("cancel") { tag: String -> local.cancel(tag) }
    Function("notificationsEnabled") { status.enabled() }
    Function("canPromote") { status.canPromote() }
    Function("openPromotionSettings") { status.openPromotionSettings() }
  }
}
