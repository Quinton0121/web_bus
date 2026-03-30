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

    /**
     * @return true if the message was accepted by Telegram.
     */
    suspend fun send(botToken: String, chatId: String, message: String): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val url = "https://api.telegram.org/bot$botToken/sendMessage"
                val json = JSONObject().apply {
                    put("chat_id", chatId)
                    put("text", message)
                }
                val body = json.toString()
                    .toRequestBody("application/json".toMediaType())
                val request = Request.Builder().url(url).post(body).build()
                val response = client.newCall(request).execute()
                val ok = response.isSuccessful
                response.close()
                ok
            } catch (e: Exception) {
                false
            }
        }
}
