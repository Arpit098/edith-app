package com.arpit.edith.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** [PushService]'s wake-up alarm (it can't wait on a timer while the phone sleeps). */
class PushAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    PushService.alarm(context.applicationContext)
  }
}
