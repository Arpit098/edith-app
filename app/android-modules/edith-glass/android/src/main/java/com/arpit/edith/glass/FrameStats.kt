package com.arpit.edith.glass

import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.view.FrameMetrics
import android.view.Window

/**
 * Frame times of one window while it runs, from the system's FrameMetrics (what the GPU and the UI
 * thread actually took, per frame), collected on a thread of its own. Bounded: at most MAX_FRAMES
 * durations are kept (5 minutes at 120 Hz); janky frames are counted past that too.
 */
internal class FrameStats(private val window: Window) {
  private val thread = HandlerThread("EdithFrameStats").apply { start() }
  private val handler = Handler(thread.looper)
  private val totals = LongArray(MAX_FRAMES)
  private var count = 0
  private var seen = 0
  private var janky = 0
  private val startedNs = System.nanoTime()
  private val refreshHz = window.decorView.display?.refreshRate ?: 60f
  private val fallbackDeadlineNs = (1_000_000_000.0 / refreshHz).toLong()

  private val listener = Window.OnFrameMetricsAvailableListener { _, m, _ ->
    if (m.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1L) return@OnFrameMetricsAvailableListener
    val total = m.getMetric(FrameMetrics.TOTAL_DURATION)
    val deadline = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) m.getMetric(FrameMetrics.DEADLINE) else fallbackDeadlineNs
    seen++
    if (total > deadline) janky++
    if (count < MAX_FRAMES) totals[count++] = total
  }

  fun start() {
    window.addOnFrameMetricsAvailableListener(listener, handler)
  }

  /** Stop and summarize, on the stats thread (where the counters live), then end the thread. */
  fun stop(done: (Map<String, Any>) -> Unit) {
    window.removeOnFrameMetricsAvailableListener(listener)
    handler.post {
      val seconds = (System.nanoTime() - startedNs) / 1e9
      val sorted = totals.copyOf(count).also { it.sort() }
      fun pct(p: Double) = if (count == 0) 0.0 else sorted[((count - 1) * p).toInt()] / 1e6
      done(
        mapOf(
          "frames" to seen,
          "seconds" to seconds,
          "refreshHz" to refreshHz.toDouble(),
          "p50Ms" to pct(0.50),
          "p95Ms" to pct(0.95),
          "p99Ms" to pct(0.99),
          "maxMs" to (if (count == 0) 0.0 else sorted[count - 1] / 1e6),
          "jankyFrames" to janky,
          "jankyPercent" to (if (seen == 0) 0.0 else 100.0 * janky / seen),
        ),
      )
      thread.quitSafely()
    }
  }

  companion object {
    const val MAX_FRAMES = 36_000
  }
}
