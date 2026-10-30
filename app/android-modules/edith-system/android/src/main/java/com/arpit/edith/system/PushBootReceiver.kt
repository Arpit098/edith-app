package com.arpit.edith.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/** After a reboot or an app update, pushes resume without opening EDITH (only if Settings → Push is on). */
class PushBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> PushService.start(context.applicationContext)
    }
  }
}
