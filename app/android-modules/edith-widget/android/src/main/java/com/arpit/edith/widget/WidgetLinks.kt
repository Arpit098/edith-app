package com.arpit.edith.widget

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

/** The edith:// links the widgets open (the app's shell/links.ts and features handle them). */
internal object WidgetLinks {
  const val LIVE = "edith://live"
  const val TYPE = "edith://live/type" // the chat, composer focused, keyboard up
  const val LISTEN = "edith://live/listen" // the chat, already listening (as the composer's mic)
  const val ATTACH = "edith://live/attach" // the chat with the attach menu open (Camera, Gallery…)

  /** Approve / Deny: the app opens its approvals and asks Arpit to confirm; nothing is answered from here. */
  fun answer(id: String, allow: Boolean) = "edith://approvals?id=${Uri.encode(id)}&answer=${if (allow) "allow" else "deny"}"

  /**
   * Opens EDITH on `link`, as edith-system's Links does for notifications: EDITH's own launcher
   * activity (singleTask), so a running EDITH comes forward and gets the link in onNewIntent
   * (React Native's Linking "url" event) and a stopped one starts with it (Linking.getInitialURL).
   * Each link is its own PendingIntent (the data differs, so they never overwrite each other).
   */
  fun open(context: Context, link: String): PendingIntent {
    val launcher = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (launcher != null) intent.component = launcher
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}
