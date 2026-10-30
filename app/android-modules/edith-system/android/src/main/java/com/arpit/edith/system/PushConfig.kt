package com.arpit.edith.system

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * What [PushService] needs with the app closed (at boot, too): edith's ntfy, its read-only token, and
 * the App API address and token for Allow/Deny. Kept in private SharedPreferences, the secrets
 * encrypted with an AES-GCM key that never leaves the Android Keystore. `lastId` (ntfy's message id,
 * for `?since=`) is not secret and is written on every message.
 */
data class PushSettings(
  val ntfyUrl: String,
  val topic: String,
  val ntfyToken: String,
  val apiUrl: String, // e.g. http://100.78.124.98:8787
  val apiToken: String,
)

class PushConfig(context: Context) {
  private val prefs = context.getSharedPreferences("edith_push", Context.MODE_PRIVATE)

  var enabled: Boolean
    get() = prefs.getBoolean("enabled", false)
    set(v) = prefs.edit().putBoolean("enabled", v).apply()

  var lastId: String?
    get() = prefs.getString("lastId", null)
    set(v) = prefs.edit().putString("lastId", v).apply()

  /** The settings, or null when none are saved (or the key is gone, e.g. after a restore). */
  fun load(): PushSettings? {
    val blob = prefs.getString("settings", null) ?: return null
    return try {
      val bytes = Base64.decode(blob, Base64.NO_WRAP)
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
      val o = JSONObject(String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8))
      PushSettings(o.getString("ntfyUrl"), o.getString("topic"), o.getString("ntfyToken"), o.getString("apiUrl"), o.getString("apiToken"))
    } catch (e: GeneralSecurityException) {
      null
    } catch (e: IllegalArgumentException) {
      null
    } catch (e: org.json.JSONException) {
      null
    }
  }

  fun save(s: PushSettings) {
    val json = JSONObject()
      .put("ntfyUrl", s.ntfyUrl).put("topic", s.topic).put("ntfyToken", s.ntfyToken)
      .put("apiUrl", s.apiUrl).put("apiToken", s.apiToken)
      .toString().toByteArray(Charsets.UTF_8)
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val sealed = cipher.iv + cipher.doFinal(json)
    // A new server or token means a new stream: start from new messages, not the old server's ids.
    val sameServer = load()?.let { it.ntfyUrl == s.ntfyUrl && it.topic == s.topic } ?: false
    val edit = prefs.edit().putString("settings", Base64.encodeToString(sealed, Base64.NO_WRAP))
    if (!sameServer) edit.remove("lastId")
    edit.apply()
  }

  fun clear() = prefs.edit().clear().apply()

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  private companion object {
    const val ALIAS = "edith_push"
    const val TRANSFORM = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
