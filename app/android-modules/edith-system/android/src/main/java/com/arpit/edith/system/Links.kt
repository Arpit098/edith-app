package com.arpit.edith.system

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

/** What a tap on one of EDITH's notifications (or the Live Alerts pill) opens. */
internal object Links {
  /**
   * Opens EDITH on `link` (edith://live, edith://approvals). The intent names EDITH's own launcher
   * activity, which is singleTask: a running EDITH comes forward and gets the link in onNewIntent
   * (React Native's Linking "url" event), a stopped one starts with it (Linking.getInitialURL).
   * NEW_TASK is required from a notification; CLEAR_TOP | SINGLE_TOP never stack a second copy.
   */
  fun open(context: Context, link: String): PendingIntent {
    val launcher = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (launcher != null) intent.component = launcher
    // One PendingIntent per link (the data differs, so they never overwrite each other).
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}
