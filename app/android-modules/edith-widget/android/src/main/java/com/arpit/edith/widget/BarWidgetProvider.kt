package com.arpit.edith.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

/**
 * The EDITH bar (4x1): the orb and name open the chat; Type, Mic and Attach open it with the
 * keyboard up, already listening, or with the attach menu open. It shows no data, so it is drawn
 * only when the launcher asks (placed, resized, after an update of the app).
 */
class BarWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val views = views(context)
    ids.forEach { manager.updateAppWidget(it, views) }
  }

  private fun views(context: Context) = RemoteViews(context.packageName, R.layout.edith_widget_bar).apply {
    setOnClickPendingIntent(R.id.edith_bar, WidgetLinks.open(context, WidgetLinks.TYPE)) // tapping the bar itself: type, as the Google bar does
    setOnClickPendingIntent(R.id.edith_bar_type, WidgetLinks.open(context, WidgetLinks.TYPE))
    setOnClickPendingIntent(R.id.edith_bar_mic, WidgetLinks.open(context, WidgetLinks.LISTEN))
    setOnClickPendingIntent(R.id.edith_bar_attach, WidgetLinks.open(context, WidgetLinks.ATTACH))
  }
}
