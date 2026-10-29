package com.arpit.edith.installer

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * In-app APK updates (contracts/app-updates.md §5): download an APK from the App API with a
 * streamed SHA-256 check, then hand it to Android's PackageInstaller. Android always shows its own
 * confirmation; nothing here can (or tries to) skip it.
 *
 * Downloads go to the app's cache, resume with a Range request when a partial file is there, and
 * never hold the APK in memory. All I/O runs on Dispatchers.IO, off the JS and main threads.
 */
class EdithInstallerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("EdithInstaller")

    Events("onProgress", "onInstallStatus")

    Constant("versionName") { packageInfo().versionName ?: "" }
    Constant("versionCode") { versionCode() }

    OnCreate { InstallResultReceiver.listener = { status, message -> sendEvent("onInstallStatus", mapOf("status" to status, "message" to message)) } }
    OnDestroy { InstallResultReceiver.listener = null }

    AsyncFunction("download") Coroutine { url: String, headers: Map<String, String>, expectedSha256: String, size: Double ->
      download(url, headers, expectedSha256.lowercase(), size.toLong())
    }

    AsyncFunction("canInstall") {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
    }

    AsyncFunction("openInstallSettings") {
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_SECURITY_SETTINGS)
      }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    AsyncFunction("install") Coroutine { path: String -> install(File(path)) }

    AsyncFunction("clearDownloads") Coroutine { -> withContext(Dispatchers.IO) { downloadsDir().deleteRecursively(); Unit } }
  }

  private fun packageInfo() = context.packageManager.getPackageInfo(context.packageName, 0)

  @Suppress("DEPRECATION")
  private fun versionCode(): Long {
    val info = packageInfo()
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
  }

  private fun downloadsDir() = File(context.cacheDir, "app-updates").apply { mkdirs() }

  private suspend fun download(url: String, headers: Map<String, String>, expected: String, size: Long): Map<String, Any> =
    withContext(Dispatchers.IO) {
      if (!expected.matches(Regex("[0-9a-f]{64}"))) throw CodedException("BAD_SHA256", "Expected a hex SHA-256", null)
      val dest = File(downloadsDir(), "$expected.apk")
      if (dest.exists() && sha256(dest) == expected) return@withContext result(dest, expected)
      val part = File(downloadsDir(), "$expected.part")
      var have = if (part.exists()) part.length() else 0L
      if (size in 1..have) {
        part.delete() // longer than the APK can be: start over
        have = 0L
      }

      val conn = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 10_000
        readTimeout = 30_000
        headers.forEach { (k, v) -> setRequestProperty(k, v) }
        if (have > 0) setRequestProperty("Range", "bytes=$have-")
      }
      try {
        val code = conn.responseCode
        if (code != HttpURLConnection.HTTP_OK && code != HttpURLConnection.HTTP_PARTIAL) {
          throw CodedException("HTTP_$code", "Download failed (HTTP $code)", null)
        }
        val resume = code == HttpURLConnection.HTTP_PARTIAL
        val digest = MessageDigest.getInstance("SHA-256")
        if (resume) part.inputStream().use { feed(it, digest) } else have = 0L
        val total = if (size > 0) size else have + conn.contentLengthLong
        var lastEvent = 0L
        FileOutputStream(part, resume).use { out ->
          conn.inputStream.use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              digest.update(buf, 0, n)
              have += n
              val now = System.currentTimeMillis()
              if (now - lastEvent >= 250) { // progress at most 4 times a second
                lastEvent = now
                sendEvent("onProgress", mapOf("received" to have.toDouble(), "total" to total.toDouble()))
                ensureActive() // stop if the JS side went away
              }
            }
          }
        }
        val actual = hex(digest.digest())
        if (actual != expected) {
          part.delete()
          throw CodedException("SHA256_MISMATCH", "The download doesn't match its SHA-256; deleted", null)
        }
        dest.delete()
        if (!part.renameTo(dest)) throw CodedException("RENAME_FAILED", "Couldn't finish the download", null)
        sendEvent("onProgress", mapOf("received" to have.toDouble(), "total" to have.toDouble()))
        result(dest, actual)
      } finally {
        conn.disconnect()
      }
    }

  private fun result(file: File, sha: String) = mapOf("path" to file.absolutePath, "sha256" to sha, "size" to file.length().toDouble())

  private suspend fun install(apk: File): Int = withContext(Dispatchers.IO) {
    if (!apk.exists() || apk.canonicalFile.parentFile?.path != downloadsDir().canonicalPath) throw CodedException("NO_APK", "That APK isn't a finished download", null)
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(context.packageName)
      setSize(apk.length())
    }
    val sessionId = installer.createSession(params)
    installer.openSession(sessionId).use { session ->
      apk.inputStream().use { input ->
        session.openWrite("edith.apk", 0, apk.length()).use { out ->
          input.copyTo(out, 64 * 1024)
          session.fsync(out)
        }
      }
      val intent = Intent(context, InstallResultReceiver::class.java).setPackage(context.packageName)
      // The installer adds its result (and the confirmation intent) to this PendingIntent: mutable.
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
      val pending = PendingIntent.getBroadcast(context, sessionId, intent, flags)
      session.commit(pending.intentSender)
    }
    sessionId
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { feed(it, digest) }
    return hex(digest.digest())
  }

  private fun feed(input: java.io.InputStream, digest: MessageDigest) {
    val buf = ByteArray(64 * 1024)
    while (true) {
      val n = input.read(buf)
      if (n < 0) return
      digest.update(buf, 0, n)
    }
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
}
