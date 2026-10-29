package com.arpit.edith.installer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

/**
 * Receives PackageInstaller's result for an install session. "Pending user action" carries
 * Android's own confirmation screen, which we show; every other status goes to JS as an event.
 */
class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra(Intent.EXTRA_INTENT)
      }
      if (confirm != null) {
        context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        listener?.invoke("pending", message)
        return
      }
    }
    listener?.invoke(
      when (status) {
        PackageInstaller.STATUS_SUCCESS -> "success" // usually never seen: the update replaces this process
        PackageInstaller.STATUS_FAILURE_ABORTED -> "cancelled"
        PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "incompatible"
        else -> "failed"
      },
      message,
    )
  }

  companion object {
    @Volatile
    var listener: ((status: String, message: String) -> Unit)? = null
  }
}
