package com.busmonitor.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Sends a text message to Telegram via the Bot API.
 */
object TelegramSender {

    private val client = OkHttpClient()

    data class TelegramResponse(
        val ok: Boolean,
        val body: String? = null,
        val error: String? = null
    )

    /**
     * @return TelegramResponse with status and body.
     */
    suspend fun send(botToken: String, chatId: String, message: String): TelegramResponse =
        withContext(Dispatchers.IO) {
            try {
                val url = "https://api.telegram.org/bot$botToken/sendMessage"
                val json = JSONObject().apply {
                    put("chat_id", chatId)
                    put("text", message)
                }
                val bodyStr = json.toString()
                    .toRequestBody("application/json".toMediaType())
                val request = Request.Builder().url(url).post(bodyStr).build()
                val response = client.newCall(request).execute()
                val responseBody = response.body?.string()
                val ok = response.isSuccessful
                response.close()
                TelegramResponse(ok, responseBody, if (!ok) "HTTP ${response.code}" else null)
            } catch (e: Exception) {
                TelegramResponse(false, null, e.message ?: "Unknown error")
            }
        }
}
