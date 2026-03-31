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

    data class Update(
        val updateId: Int,
        val message: Message?
    )

    data class Message(
        val chatId: Long,
        val text: String?
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

    data class GetUpdatesResponse(
        val ok: Boolean,
        val updates: List<Update> = emptyList(),
        val error: String? = null
    )

    /**
     * Poll for new updates from Telegram.
     */
    suspend fun getUpdates(botToken: String, offset: Int? = null): GetUpdatesResponse =
        withContext(Dispatchers.IO) {
            try {
                val url = "https://api.telegram.org/bot$botToken/getUpdates" +
                        if (offset != null) "?offset=$offset" else ""
                val request = Request.Builder().url(url).build()
                val response = client.newCall(request).execute()
                val body = response.body?.string() ?: return@withContext GetUpdatesResponse(false, error = "Empty response body")
                response.close()

                val json = JSONObject(body)
                val ok = json.optBoolean("ok")
                if (!ok) return@withContext GetUpdatesResponse(false, error = body)

                val resultArr = json.getJSONArray("result")
                val updatesList = mutableListOf<Update>()
                for (i in 0 until resultArr.length()) {
                    val u = resultArr.getJSONObject(i)
                    val updateId = u.getInt("update_id")
                    val m = u.optJSONObject("message") ?: u.optJSONObject("edited_message")
                    val message = m?.let {
                        Message(
                            chatId = it.getJSONObject("chat").getLong("id"),
                            text = it.optString("text", null) ?: it.optString("caption", null)
                        )
                    }
                    updatesList.add(Update(updateId, message))
                }
                GetUpdatesResponse(true, updatesList)
            } catch (e: Exception) {
                GetUpdatesResponse(false, error = e.message ?: "Unknown error")
            }
        }

    /**
     * Deletes the webhook if one is active.
     */
    suspend fun deleteWebhook(botToken: String): TelegramResponse =
        withContext(Dispatchers.IO) {
            try {
                val url = "https://api.telegram.org/bot$botToken/deleteWebhook"
                val request = Request.Builder().url(url).build()
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
