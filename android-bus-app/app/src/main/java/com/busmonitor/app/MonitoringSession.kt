package com.busmonitor.app

import android.content.Context
import kotlinx.coroutines.*
import kotlin.coroutines.coroutineContext

/**
 * Orchestrates a single monitoring session:
 *   1. Extract token via hidden WebView
 *   2. Fetch bus data from DSAT (or fallback)
 *   3. Send to Telegram
 *   4. Wait 40 seconds, repeat
 *   5. After 20 messages → stop
 *   6. On "Stop" button → cancel immediately
 *
 * All resources are released when the session ends.
 */
class MonitoringSession(
    private val context: Context,
    private val stationId: String,
    private val busNumbers: List<String>,
    private val onLog: (String) -> Unit,
    private val onFinished: () -> Unit
) {
    companion object {
        const val MAX_CYCLES = 20
        const val INTERVAL_MS = 40_000L
    }

    private var job: Job? = null
    private var token = ""
    private var cookie = ""
    private var currentCycle = 0

    val isRunning: Boolean get() = job?.isActive == true

    /**
     * Start the monitoring session. Safe to call from any thread.
     */
    fun start(scope: CoroutineScope) {
        if (isRunning) {
            onLog("⚠️ Session already running")
            return
        }
        currentCycle = 0
        job = scope.launch {
            val botToken = AppConfig.getTelegramBotToken(context)
            val chatId = AppConfig.getTelegramChatId(context)

            // Start polling for "stop" commands in parallel
            val pollingJob = if (botToken.isNotBlank() && chatId.isNotBlank()) {
                launch { pollForStopCommand(botToken, chatId) }
            } else null

            try {
                run()
            } catch (e: CancellationException) {
                onLog("🛑 Session cancelled")
            } catch (e: Exception) {
                onLog("❌ Error: ${e.message}")
            } finally {
                pollingJob?.cancel()
                onLog("🏁 Session ended – all resources released")
                withContext(Dispatchers.Main) { onFinished() }
            }
        }
    }

    /**
     * Immediately cancel the session and release everything.
     */
    fun stop() {
        job?.cancel()
        job = null
        token = ""
        cookie = ""
        currentCycle = 0
    }

    /* ── internal ── */

    private suspend fun run() {
        val botToken = AppConfig.getTelegramBotToken(context)
        val chatId = AppConfig.getTelegramChatId(context)
        if (botToken.isBlank() || chatId.isBlank()) {
            onLog("❌ Telegram credentials not configured. Go to Settings.")
            return
        }

        // Step 1: Initialize cookies (huid)
        onLog("🍪 Initializing DSAT session...")
        val creds = TokenExtractor.extract(context, busNumbers.firstOrNull() ?: "11")
        cookie = creds.cookie
        if (cookie.isBlank()) {
            onLog("⚠️ Cookie extraction failed — will use fallback API")
        } else {
            onLog("✅ Session initialized")
        }

        // Step 2–5: Fetch → Send → Wait loop
        var consecutiveErrors = 0
        while (currentCycle < MAX_CYCLES) {
            currentCycle++
            coroutineContext.ensureActive()

            try {
                onLog("📡 Fetching bus data ($currentCycle/$MAX_CYCLES)...")

                // Try DSAT first (Token is now generated automatically inside fetchFromDsatOnly)
                var result = BusDataFetcher.fetchFromDsatOnly(
                    stationId, busNumbers, "", cookie, onLog
                )

                // Still no data from DSAT → fall back to old proxy (unless suffix is used)
                if (result == null) {
                    if (stationId.contains("/")) {
                        onLog("⚠️ [Debug] Station $stationId not found in DSAT API. Skipping proxy fallback to avoid platform mixing.")
                    } else {
                        onLog("⚠️ DSAT unavailable — trying backup proxy...")
                        result = BusDataFetcher.fetchFromProxyOnly(stationId, busNumbers)
                    }
                }

                // Even proxy failed
                if (result == null) {
                    onLog("❌ Both APIs failed for cycle $currentCycle, skipping...")
                    consecutiveErrors++
                    if (consecutiveErrors >= 3) {
                        onLog("❌ 3 consecutive failures — stopping session")
                        break
                    }
                } else {
                    consecutiveErrors = 0
                    sendAndLog(result, botToken, chatId)
                }

            } catch (e: CancellationException) {
                throw e  // Let cancellation propagate
            } catch (e: Exception) {
                onLog("⚠️ Error in cycle $currentCycle: ${e.message}")
                consecutiveErrors++
                if (consecutiveErrors >= 3) {
                    onLog("❌ 3 consecutive failures — stopping session")
                    break
                }
            }

            // Wait unless this is the last cycle
            if (currentCycle < MAX_CYCLES) {
                onLog("⏳ Waiting ${INTERVAL_MS / 1000}s until next update...")
                delay(INTERVAL_MS)
            }
        }

        onLog("✅ All $MAX_CYCLES messages sent — monitoring complete")
    }

    private suspend fun sendAndLog(
        result: BusDataFetcher.FetchResult,
        botToken: String,
        chatId: String
    ) {
        val message = BusDataFetcher.formatForTelegram(
            result, stationId, busNumbers, currentCycle, MAX_CYCLES
        )
        
        // Mask chatId for privacy but show prefix/length for debugging
        val maskedChatId = if (chatId.length > 6) {
            chatId.take(3) + "..." + chatId.takeLast(3)
        } else chatId
        
        onLog("📤 Sending to Telegram... (chatId: $maskedChatId, source: ${result.source})")
        
        val response = TelegramSender.send(botToken, chatId, message)
        if (response.ok) {
            onLog("✅ Message $currentCycle sent successfully")
            // Optionally log a bit of the response for the user to see it's really from Telegram
            response.body?.let { 
                if (it.contains("message_id")) {
                    onLog("   [Debug] Telegram response: OK (message_id present)")
                }
            }
        } else {
            onLog("❌ Telegram send failed for message $currentCycle")
            onLog("   [Error] ${response.error ?: "Unknown error"}")
            response.body?.let { onLog("   [Response] $it") }
        }
    }

    /**
     * Polls Telegram for any new message from the user to stop the session.
     */
    private suspend fun pollForStopCommand(botToken: String, chatId: String) {
        var lastUpdateId = -1
        // Initial fetch to skip old messages (get the current state)
        onLog("🔍 [Debug] Telegram polling started (chatId: $chatId)")

        // Resolve webhook conflict if any (required for getUpdates to work)
        val deleteRes = TelegramSender.deleteWebhook(botToken)
        if (deleteRes.ok) {
            onLog("🔍 [Debug] Webhook deleted/checked successfully")
        } else {
            onLog("⚠️ [Debug] deleteWebhook failed or not needed: ${deleteRes.error}")
        }

        val initialResponse = TelegramSender.getUpdates(botToken)
        if (initialResponse.ok && initialResponse.updates.isNotEmpty()) {
            lastUpdateId = initialResponse.updates.maxOf { it.updateId }
            onLog("🔍 [Debug] Skipping ${initialResponse.updates.size} old messages. lastUpdateId: $lastUpdateId")
        } else if (!initialResponse.ok) {
            onLog("⚠️ [Debug] Initial Telegram poll failed: ${initialResponse.error}")
        }

        while (coroutineContext.isActive) {
            val response = TelegramSender.getUpdates(botToken, lastUpdateId + 1)
            
            if (response.ok) {
                for (update in response.updates) {
                    lastUpdateId = update.updateId
                    val receivedChatId = update.message?.chatId?.toString()
                    if (receivedChatId != null) {
                        onLog("🔍 [Debug] Message from $receivedChatId: ${update.message.text ?: "[no text]"}")
                        // Stop if any message is received from the correct chatId
                        if (receivedChatId == chatId || receivedChatId.endsWith(chatId) || chatId.endsWith(receivedChatId)) {
                            onLog("🛑 Stop command received from Telegram: ${update.message.text ?: "[media]"}")
                            stop()
                            return
                        } else {
                            onLog("🔍 [Debug] chatId mismatch: received=$receivedChatId, expected=$chatId")
                        }
                    }
                }
            } else {
                onLog("⚠️ [Debug] Telegram poll error: ${response.error}")
            }
            delay(5000) // Check every 5 seconds
        }
    }
}
