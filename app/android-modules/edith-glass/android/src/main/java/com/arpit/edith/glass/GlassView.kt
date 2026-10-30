package com.arpit.edith.glass

import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewTreeObserver
import androidx.annotation.RequiresApi
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference
import kotlin.math.ceil

/**
 * A Liquid Glass surface over a backdrop view (any React Native view, found by its tag).
 *
 * The backdrop's display list is recorded into a RenderNode (a list of drawing commands, no bitmap
 * copy) for the area under this view plus a margin, and drawn here through one RenderEffect chain:
 * - "shader" (Android 13+): blur, then the AGSL lens (GlassShader.kt: refraction, dispersion,
 *   saturation, tint, specular);
 * - "blur" (Android 12): blur, then a saturation colour matrix; the tint is drawn over it.
 * Below Android 12 (or in battery saver) JS doesn't mount this view: the flat fallback is plain
 * React Native styling.
 *
 * It redraws only when needed: on the window's pre-draw pass it checks whether the backdrop has
 * pending drawing (isDirty) or this view moved on screen; nothing runs while the screen is still.
 * The backdrop must not contain this view (it would record itself); then the glass draws nothing
 * and the JS fallback underneath shows.
 */
class GlassView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val density = resources.displayMetrics.density

  var mode = "shader"
    set(v) { field = v; changed() }
  var cornerRadiusDp = 0f
    set(v) { field = v; changed() }
  var blurDp = 20f
    set(v) { field = v; changed() }
  var refractionDp = 0f
    set(v) { field = v; changed() }
  var bezelDp = 16f
    set(v) { field = v; changed() }
  var dispersion = 0f
    set(v) { field = v; changed() }
  var saturation = 1f
    set(v) { field = v; changed() }
  var specular = 0f
    set(v) { field = v; changed() }
  /** Straight RGBA, each 0..1. */
  var tint = floatArrayOf(0f, 0f, 0f, 0f)
    set(v) { field = v; changed() }

  private var backdropTag: Int? = null
  private var backdropRef: WeakReference<View>? = null

  private var node: RenderNode? = null
  private var effect: RenderEffect? = null
  // What `effect` was built for; a new one only when these or a prop (paramsDirty) change.
  private var paramsDirty = true
  private var effectShader = false
  private var effectW = 0
  private var effectH = 0
  private var effectMargin = 0
  private var effectBlur = 0f
  private var lensShader: RuntimeShader? = null // one per view: the AGSL compiles once, uniforms are set again
  private val clip = Path()
  private val tintPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val here = IntArray(2)
  private val there = IntArray(2)
  private var lastX = Int.MIN_VALUE
  private var lastY = Int.MIN_VALUE

  // Redraws for a changed backdrop are capped at MIN_REDRAW_MS (about 30 a second): a running
  // task's spinner and blob would otherwise re-record and re-blur every glass surface at 120 Hz.
  // The last change is never lost: one redraw is queued for when the interval is up. Glass that
  // moves itself (a sheet, the header growing) redraws at once.
  private var lastDrawMs = 0L
  private var redrawQueued = false
  private val redraw = Runnable {
    redrawQueued = false
    invalidate()
  }

  private val preDraw = ViewTreeObserver.OnPreDrawListener {
    val b = backdrop()
    if (b != null) {
      getLocationInWindow(here)
      if (here[0] != lastX || here[1] != lastY) {
        invalidate()
      } else if (b.isDirty) {
        val wait = MIN_REDRAW_MS - (SystemClock.uptimeMillis() - lastDrawMs)
        if (wait <= 0) {
          invalidate()
        } else if (!redrawQueued) {
          redrawQueued = true
          postDelayed(redraw, wait)
        }
      }
    }
    true
  }

  init {
    setWillNotDraw(false)
  }

  fun setBackdrop(tag: Int?) {
    if (tag == backdropTag) return
    backdropTag = tag
    backdropRef = null
    invalidate()
  }

  private fun changed() {
    paramsDirty = true
    invalidate()
  }

  /** The backdrop view, looked up lazily (it may mount after this view); null if it contains us. */
  private fun backdrop(): View? {
    backdropRef?.get()?.let { return it }
    val tag = backdropTag ?: return null
    val v = appContext.findView<View>(tag) ?: return null
    var p = parent
    while (p is View) {
      if (p === v) return null
      p = p.parent
    }
    backdropRef = WeakReference(v)
    return v
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnPreDrawListener(preDraw)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnPreDrawListener(preDraw)
    removeCallbacks(redraw)
    redrawQueued = false
    node?.discardDisplayList()
    // The compiled lens goes back to the pool for the next glass view (a menu opened again).
    lensShader?.let { releaseShader(it) }
    lensShader = null
    effect = null
    paramsDirty = true
    super.onDetachedFromWindow()
  }

  override fun draw(canvas: Canvas) {
    if (capturing > 0) return // we're being recorded as part of another glass's backdrop
    val b = backdrop()
    var drew = false
    if (!failed && b != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && canvas.isHardwareAccelerated && width > 0 && height > 0) {
      // Glass is decoration: whatever goes wrong drawing it (a GPU driver refusing the effect, say),
      // this view stops trying and draws flat. The app never crashes for it.
      try {
        drawGlass(canvas, b)
        drew = true
      } catch (e: RuntimeException) {
        failed = true
        Log.w(TAG, "glass off for this view: ${e.message}")
      }
    }
    // No glass this frame (no backdrop yet or one that contains us, no hardware canvas, or a
    // failure): the flat panel, since JS made the surface transparent for the glass.
    if (!drew && width > 0 && height > 0) drawFlat(canvas)
    super.draw(canvas)
  }

  private var failed = false

  /** Without glass: the tint, nearly opaque, so the surface still reads as a panel. */
  private fun drawFlat(canvas: Canvas) {
    val r = cornerRadiusDp * density
    clip.rewind()
    clip.addRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, Path.Direction.CW)
    tintPaint.setARGB((maxOf(tint[3], 0.88f) * 255).toInt(), (tint[0] * 255).toInt(), (tint[1] * 255).toInt(), (tint[2] * 255).toInt())
    canvas.drawPath(clip, tintPaint)
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun drawGlass(canvas: Canvas, b: View) {
    // RuntimeShader exists from Android 13; and if the lens ever fails to compile (shaderBroken),
    // every view falls back to blur.
    val shader = mode == "shader" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !shaderBroken
    val blurPx = (blurDp * density).coerceAtLeast(1f)
    // Room around the glass for the blur's reach and the lens looking inward from the rim.
    val margin = ceil(blurPx * 2 + if (shader) refractionDp * density else 0f).toInt()
    val w = width + 2 * margin
    val h = height + 2 * margin

    getLocationInWindow(here)
    b.getLocationInWindow(there)
    lastX = here[0]
    lastY = here[1]
    lastDrawMs = SystemClock.uptimeMillis()

    val n = node ?: RenderNode("EdithGlass").also { node = it }
    n.setPosition(0, 0, w, h)
    val rc = n.beginRecording(w, h)
    try {
      rc.translate((there[0] - here[0] + margin).toFloat(), (there[1] - here[1] + margin).toFloat())
      capturing++
      try {
        b.draw(rc)
      } finally {
        capturing--
      }
    } finally {
      n.endRecording()
    }
    n.setRenderEffect(effectFor(shader, w, h, margin, blurPx))
    val lensOn = shader && !shaderBroken // false if the lens just failed to compile: blur, clip and tint here

    val r = cornerRadiusDp * density
    clip.rewind()
    clip.addRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, Path.Direction.CW)
    canvas.save()
    if (!lensOn) canvas.clipPath(clip) // the lens shapes and antialiases its own edge
    canvas.translate(-margin.toFloat(), -margin.toFloat())
    canvas.drawRenderNode(n)
    canvas.restore()
    if (!lensOn && tint[3] > 0f) {
      tintPaint.setARGB((tint[3] * 255).toInt(), (tint[0] * 255).toInt(), (tint[1] * 255).toInt(), (tint[2] * 255).toInt())
      canvas.drawPath(clip, tintPaint)
    }
  }

  /** The effect chain, rebuilt only when the size or a parameter changes (it's immutable). */
  @RequiresApi(Build.VERSION_CODES.S)
  private fun effectFor(shader: Boolean, w: Int, h: Int, margin: Int, blurPx: Float): RenderEffect {
    val current = effect
    if (current != null && !paramsDirty && shader == effectShader && w == effectW && h == effectH && margin == effectMargin && blurPx == effectBlur) {
      return current
    }
    val blur = RenderEffect.createBlurEffect(blurPx, blurPx, Shader.TileMode.CLAMP)
    val lensEffect = if (shader) {
      try {
        lens(blur, margin)
      } catch (e: IllegalArgumentException) { // the AGSL didn't compile on this device
        shaderBroken = true
        Log.w(TAG, "lens shader unavailable, blur only: ${e.message}")
        null
      }
    } else {
      null
    }
    val e = if (lensEffect != null) {
      lensEffect
    } else {
      val m = ColorMatrix().apply { setSaturation(saturation) }
      RenderEffect.createChainEffect(RenderEffect.createColorFilterEffect(ColorMatrixColorFilter(m)), blur)
    }
    effect = e
    paramsDirty = false
    effectShader = shader
    effectW = w
    effectH = h
    effectMargin = margin
    effectBlur = blurPx
    return e
  }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun lens(blur: RenderEffect, margin: Int): RenderEffect {
    val s = lensShader ?: takeShader().also { lensShader = it }
    s.setFloatUniform("origin", margin.toFloat(), margin.toFloat())
    s.setFloatUniform("size", width.toFloat(), height.toFloat())
    s.setFloatUniform("radius", (cornerRadiusDp * density).coerceAtMost(minOf(width, height) / 2f))
    s.setFloatUniform("bezel", (bezelDp * density).coerceAtLeast(1f))
    s.setFloatUniform("refraction", refractionDp * density)
    s.setFloatUniform("dispersion", dispersion)
    s.setFloatUniform("saturation", saturation)
    s.setFloatUniform("tint", tint[0], tint[1], tint[2], tint[3])
    s.setFloatUniform("specular", specular)
    // Chain: the inner effect (blur) runs first, the lens reads its result as `content`.
    return RenderEffect.createChainEffect(RenderEffect.createRuntimeShaderEffect(s, "content"), blur)
  }

  companion object {
    /** > 0 while some glass records its backdrop: glass views inside that backdrop draw nothing. UI thread only. */
    internal var capturing = 0

    /** The lens shader failed to compile once: no view tries again (UI thread only). */
    internal var shaderBroken = false

    // Compiled lens shaders not in use: a view that detaches gives its shader back and a new view
    // takes one, so mounting glass (the navigation menu's sheet, each time it opens) doesn't compile
    // the AGSL again. Each shader belongs to one view at a time (its uniforms are that view's).
    // The first compile also makes one spare, for the first glass mounted later. UI thread only.
    private const val POOL_MAX = 4
    private val pool = ArrayDeque<Any>() // RuntimeShader (typed Any: the class exists from Android 13)
    private var spareMade = false

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun takeShader(): RuntimeShader {
      (pool.removeLastOrNull() as RuntimeShader?)?.let { return it }
      val s = RuntimeShader(GLASS_AGSL) // throws IllegalArgumentException if the AGSL doesn't compile
      if (!spareMade) {
        spareMade = true
        pool.addLast(RuntimeShader(GLASS_AGSL))
      }
      return s
    }

    private fun releaseShader(s: Any) {
      if (pool.size < POOL_MAX) pool.addLast(s)
    }

    private const val TAG = "EdithGlass"
    private const val MIN_REDRAW_MS = 33L
  }
}
