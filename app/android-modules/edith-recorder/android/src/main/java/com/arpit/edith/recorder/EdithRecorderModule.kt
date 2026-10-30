package com.arpit.edith.recorder

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * Push-to-talk recording: 16 kHz mono 16-bit PCM WAV (what whisper.cpp reads without conversion,
 * contracts/events.md "/v1/stt"), written as it records, on one recording thread.
 *
 * About 10 times a second it sends `onRecording {elapsedMs, level}` (level 0..1 from the RMS), so
 * the UI shows a timer and a meter without polling. At `maxMs` it stops by itself and sends
 * `{capped: true}`; JS then calls stop() to get the file.
 *
 * stop() also describes the take (peak and RMS in dBFS, clipped samples, the file's SHA-256), measured
 * on the recording thread as the samples go by, so JS checks a clip without reading it. Push-to-talk
 * files live in the cache and are replaced by the next recording; `keep` files (wake word training
 * clips, uploaded later, maybe after a restart) live in files/wakeword-clips until discard().
 */
class EdithRecorderModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var session: Recording? = null

  override fun definition() = ModuleDefinition {
    Name("EdithRecorder")
    Events("onRecording")

    AsyncFunction("start") { maxMs: Int, keep: Boolean? ->
      if (session != null) throw CodedException("BUSY", "Already recording", null)
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        throw CodedException("NO_PERMISSION", "Microphone permission is off", null)
      }
      val file = if (keep == true) {
        File(keptDir(), "clip-${System.currentTimeMillis()}.wav")
      } else {
        val dir = File(context.cacheDir, "voice").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // the last recording was uploaded (or dropped) by now
        File(dir, "ptt-${System.currentTimeMillis()}.wav")
      }
      session = Recording(file, maxMs.coerceIn(1_000, 120_000)) { event -> sendEvent("onRecording", event) }.also { it.begin() }
    }

    AsyncFunction("stop") Coroutine { ->
      val s = session ?: return@Coroutine null
      session = null
      withContext(Dispatchers.IO) { s.finish() }
    }

    // Only files this module made: a path elsewhere is ignored.
    AsyncFunction("discard") { uri: String ->
      val path = Uri.parse(uri).path
      val file = path?.let { File(it).canonicalFile }
      val dirs = setOf(keptDir().canonicalFile, File(context.cacheDir, "voice").canonicalFile)
      file != null && file.parentFile in dirs && file.delete()
    }

    AsyncFunction("keptFiles") { keptDir().listFiles()?.filter { it.isFile }?.map { "file://${it.absolutePath}" } ?: emptyList() }

    AsyncFunction("cancel") {
      session?.let {
        session = null
        it.abort()
      }
    }

    OnDestroy {
      session?.abort()
      session = null
    }
  }

  private fun keptDir() = File(context.filesDir, "wakeword-clips").apply { mkdirs() }
}

private class Recording(private val file: File, private val maxMs: Int, private val emit: (Map<String, Any>) -> Unit) {
  @Volatile private var running = true
  private var thread: Thread? = null
  private var samples = 0L
  // The take's level, kept by the recording thread (read after join()).
  private var peak = 0
  private var clipped = 0L
  private var totalSquares = 0.0

  @SuppressLint("MissingPermission") // checked by the module before it starts
  fun begin() {
    val minBuffer = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuffer <= 0) throw CodedException("NO_MIC", "This phone can't record 16 kHz mono", null)
    val record = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuffer, FRAME * 2 * 4))
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      throw CodedException("NO_MIC", "The microphone is busy or unavailable", null)
    }
    val out = RandomAccessFile(file, "rw").apply {
      setLength(0)
      write(ByteArray(HEADER)) // filled in by finish()
    }
    record.startRecording()
    thread = Thread({ loop(record, out) }, "edith-ptt").also { it.start() }
  }

  private fun loop(record: AudioRecord, out: RandomAccessFile) {
    val pcm = ShortArray(FRAME)
    val bytes = ByteBuffer.allocate(FRAME * 2).order(ByteOrder.LITTLE_ENDIAN)
    var sumSquares = 0.0
    var sinceEvent = 0
    try {
      while (running) {
        val n = record.read(pcm, 0, FRAME)
        if (n <= 0) continue
        bytes.clear()
        var chunk = 0.0
        for (i in 0 until n) {
          val v = pcm[i].toInt()
          bytes.putShort(pcm[i])
          chunk += v.toDouble() * v
          val a = abs(v)
          if (a > peak) peak = a
          if (a >= CLIP_AT) clipped++
        }
        sumSquares += chunk
        totalSquares += chunk
        out.write(bytes.array(), 0, n * 2)
        samples += n
        sinceEvent += n
        val elapsedMs = (samples * 1000 / RATE).toInt()
        if (sinceEvent >= RATE / 10) { // ~10 events a second
          val rms = sqrt(sumSquares / sinceEvent) / Short.MAX_VALUE
          val db = if (rms > 0) 20 * log10(rms) else -90.0
          emit(mapOf("elapsedMs" to elapsedMs, "level" to ((db + 60) / 60).coerceIn(0.0, 1.0)))
          sumSquares = 0.0
          sinceEvent = 0
        }
        if (elapsedMs >= maxMs) {
          running = false
          emit(mapOf("elapsedMs" to elapsedMs, "level" to 0.0, "capped" to true))
        }
      }
    } finally {
      try {
        record.stop()
      } catch (ignored: IllegalStateException) {
        // already stopped
      }
      record.release()
      out.close()
    }
  }

  /** Stop, write the WAV header, and describe the file. */
  fun finish(): Map<String, Any> {
    running = false
    thread?.join(2_000)
    RandomAccessFile(file, "rw").use { raf ->
      raf.seek(0)
      raf.write(header(samples * 2))
    }
    return mapOf(
      "uri" to "file://${file.absolutePath}",
      "durationMs" to (samples * 1000 / RATE).toDouble(),
      "bytes" to file.length().toDouble(),
      "peakDbfs" to dbfs(peak.toDouble() / Short.MAX_VALUE),
      "rmsDbfs" to dbfs(if (samples > 0) sqrt(totalSquares / samples) / Short.MAX_VALUE else 0.0),
      "clipped" to clipped.toDouble(),
      "sha256" to sha256(file),
    )
  }

  fun abort() {
    running = false
    thread?.join(2_000)
    file.delete()
  }

  /** dB relative to full scale; silence is -120 (as the server sends -inf, contracts/wakeword.md). */
  private fun dbfs(ratio: Double): Double = if (ratio > 0) maxOf(-120.0, 20 * log10(ratio)) else -120.0

  /** The whole file's SHA-256 (lowercase hex), streamed: the id the server keys clips on. */
  private fun sha256(f: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { input ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        digest.update(buf, 0, n)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun header(dataBytes: Long): ByteArray =
    ByteBuffer.allocate(HEADER).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray()); putInt((36 + dataBytes).toInt()); put("WAVE".toByteArray())
      put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1) // PCM, mono
      putInt(RATE); putInt(RATE * 2); putShort(2); putShort(16) // byte rate, block align, bits
      put("data".toByteArray()); putInt(dataBytes.toInt())
    }.array()

  companion object {
    const val RATE = 16_000
    const val FRAME = 320 // 20 ms
    const val HEADER = 44
    const val CLIP_AT = 32_700 // |sample| at or above this counts as clipped
  }
}
