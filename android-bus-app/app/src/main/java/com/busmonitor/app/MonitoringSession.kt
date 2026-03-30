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
            try {
                run()
            } catch (e: CancellationException) {
                onLog("🛑 Session cancelled")
            } catch (e: Exception) {
                onLog("❌ Error: ${e.message}")
            } finally {
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

        // Step 1: Extract token
        onLog("🔑 Extracting DSAT token...")
        val creds = TokenExtractor.extract(context, busNumbers.firstOrNull() ?: "11")
        if (creds.token.isBlank()) {
            onLog("⚠️ Token extraction failed — will use fallback API")
        } else {
            token = creds.token
            cookie = creds.cookie
            onLog("✅ Token obtained")
        }

        // Step 2–5: Fetch → Send → Wait loop
        var consecutiveErrors = 0
        while (currentCycle < MAX_CYCLES) {
            currentCycle++
            coroutineContext.ensureActive()

            try {
                onLog("📡 Fetching bus data ($currentCycle/$MAX_CYCLES)...")

                // Try DSAT first
                var result = BusDataFetcher.fetchFromDsatOnly(
                    stationId, busNumbers, token, cookie, onLog
                )

                // DSAT failed/empty → might be token expired
                if (result == null && token.isNotBlank()) {
                    onLog("🔄 DSAT returned no data — re-extracting token...")
                    val newCreds = TokenExtractor.extract(context, busNumbers.firstOrNull() ?: "11")
                    if (newCreds.token.isNotBlank()) {
                        token = newCreds.token
                        cookie = newCreds.cookie
                        onLog("✅ New token obtained — retrying DSAT...")
                        // Retry DSAT with fresh token
                        result = BusDataFetcher.fetchFromDsatOnly(
                            stationId, busNumbers, token, cookie, onLog
                        )
                    }
                }

                // Still no data from DSAT → fall back to old proxy
                if (result == null) {
                    onLog("⚠️ DSAT unavailable — trying backup proxy...")
                    result = BusDataFetcher.fetchFromProxyOnly(stationId, busNumbers)
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
}
