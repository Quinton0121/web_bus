package com.busmonitor.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder

/**
 * Fetches bus arrival data from DSAT official API (primary)
 * or the old proxy API (fallback).
 *
 * Mirrors the logic in webbus-worker/src/index.ts → fetchBusInfo().
 */
object BusDataFetcher {

    data class BusInfo(
        val routeNo: String,
        val dir: Int,
        val lastbus: Int,
        val remaining: Double? = null
    )

    data class FetchResult(
        val buses: List<BusInfo>,
        val source: String  // "DSAT Official API" or "Old Proxy API"
    )

    private val client = OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    /**
     * Primary: hit DSAT official API using the token.
     * Falls back to old proxy if DSAT fails.
     */
    suspend fun fetch(
        stationId: String,
        busNumbers: List<String>,
        token: String,
        cookie: String
    ): FetchResult = withContext(Dispatchers.IO) {
        // Try primary DSAT API first
        if (token.isNotBlank()) {
            try {
                val result = fetchFromDsat(stationId, busNumbers, token, cookie)
                if (result.buses.isNotEmpty()) return@withContext result
            } catch (e: Exception) {
                // Fall through to proxy
            }
        }
        // Fallback to old proxy
        fetchFromProxy(stationId, busNumbers)
    }

    /** Check if the token seems expired based on a failed DSAT response. */
    suspend fun fetchWithTokenCheck(
        stationId: String,
        busNumbers: List<String>,
        token: String,
        cookie: String
    ): Pair<FetchResult, Boolean> = withContext(Dispatchers.IO) {
        // tokenExpired flag
        var tokenExpired = false
        if (token.isNotBlank()) {
            try {
                val result = fetchFromDsat(stationId, busNumbers, token, cookie)
                if (result.buses.isNotEmpty()) return@withContext result to false
                // Empty result = possibly expired
                tokenExpired = true
            } catch (e: Exception) {
                tokenExpired = true
            }
        }
        fetchFromProxy(stationId, busNumbers) to tokenExpired
    }

    /**
     * Try DSAT only (no auto-fallback to proxy).
     * Returns null if DSAT fails or returns empty.
     * Accepts optional logger for debug output.
     */
    suspend fun fetchFromDsatOnly(
        stationId: String,
        busNumbers: List<String>,
        token: String,
        cookie: String,
        logger: ((String) -> Unit)? = null
    ): FetchResult? = withContext(Dispatchers.IO) {
        logger?.invoke("🔍 [Debug] Initializing DSAT fetch (cookie present: ${cookie.isNotBlank()})")
        try {
            val result = fetchFromDsat(stationId, busNumbers, token, cookie, logger)
            if (result.buses.isNotEmpty()) {
                logger?.invoke("🔍 [DEBUG] DSAT returned ${result.buses.size} bus(es)")
                result
            } else {
                logger?.invoke("🔍 [DEBUG] DSAT returned 0 matching buses")
                null
            }
        } catch (e: Exception) {
            logger?.invoke("🔍 [DEBUG] DSAT exception: ${e.message}")
            null
        }
    }

    /**
     * Proxy-only fetch (public, for explicit fallback).
     * Returns null if proxy also fails.
     */
    suspend fun fetchFromProxyOnly(
        stationId: String,
        busNumbers: List<String>
    ): FetchResult? = withContext(Dispatchers.IO) {
        try {
            fetchFromProxy(stationId, busNumbers)
        } catch (e: Exception) {
            null
        }
    }

    /* ── DSAT Official API ── */

    private fun fetchFromDsat(
        stationId: String,
        busNumbers: List<String>,
        token: String, // Kept for signature but will be regenerated
        cookie: String,
        logger: ((String) -> Unit)? = null
    ): FetchResult {
        val processedData = mutableListOf<BusInfo>()

        for (route in busNumbers) {
            val routeStr = route.trim()
            val params = mapOf(
                "action" to "dy",
                "routeName" to routeStr,
                "dir" to "0",
                "lang" to "zh-tw",
                "routeType" to "2",
                "device" to "web"
            )
            
            val dynamicToken = DSATTokenGenerator.generate(params)
            val formBody = params.entries.joinToString("&") { (k, v) ->
                "$k=${java.net.URLEncoder.encode(v, "UTF-8")}"
            }

            val userAgent = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
                
            val request = Request.Builder()
                .url("https://bis.dsat.gov.mo:37812/macauweb/routestation/bus")
                .post(formBody.toRequestBody("application/x-www-form-urlencoded; charset=UTF-8".toMediaType()))
                .header("Accept", "application/json, text/javascript, */*; q=0.01")
                .header("Accept-Language", "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7")
                .header("Connection", "keep-alive")
                .header("User-Agent", userAgent)
                .header("Origin", "https://bis.dsat.gov.mo:37812")
                .header("Referer",
                    "https://bis.dsat.gov.mo:37812/macauweb/routeLine.html" +
                    "?routeName=$routeStr&direction=0&language=zh-tw&ver=3.8.6&routeType=2&fromDzzp=false")
                .header("X-Requested-With", "XMLHttpRequest")
                .header("Sec-Fetch-Dest", "empty")
                .header("Sec-Fetch-Mode", "cors")
                .header("Sec-Fetch-Site", "same-origin")
                .header("Sec-CH-UA", "\"Not_A Brand\";v=\"8\", \"Chromium\";v=\"120\", \"Google Chrome\";v=\"120\"")
                .header("Sec-CH-UA-Mobile", "?1")
                .header("Sec-CH-UA-Platform", "\"Android\"")
                .header("Cookie", cookie)
                .header("token", dynamicToken)
                .build()

            val response = client.newCall(request).execute()
            val code = response.code
            val body = response.body?.string() ?: ""
            response.close()
            
            logger?.invoke("🔍 [Debug] DSAT HTTP $code for route $routeStr")
            if (code == 403 || code == 401) {
                logger?.invoke("   [Error] DSAT rejected token (Forbidden/Unauthorized)")
            }
            
            if (response.isSuccessful) {
                logger?.invoke("   [Response] ${body.take(100)}...")
                val json = JSONObject(body)
                val data = json.optJSONObject("data")
                if (data == null) {
                    logger?.invoke("🔍 [DEBUG] No 'data' field in response")
                    continue
                }
                val routeInfo = data.optJSONArray("routeInfo")
                if (routeInfo == null) {
                    logger?.invoke("🔍 [DEBUG] No 'routeInfo' in data")
                    continue
                }
                logger?.invoke("🔍 [DEBUG] routeInfo has ${routeInfo.length()} stations")

                // Find the station in the route using prefix matching
                var stationIndex = -1
                val allStaCodes = mutableListOf<String>()
                
                for (i in 0 until routeInfo.length()) {
                    val info = routeInfo.getJSONObject(i)
                    val sc = info.optString("staCode")
                    allStaCodes.add(sc)
                    
                    if (sc.startsWith(stationId)) {
                        stationIndex = i
                        logger?.invoke("   [Debug] Found station match: $sc (at index $i)")
                        break
                    }
                }

                if (stationIndex == -1) {
                    logger?.invoke("   [Warning] Station $stationId not found in route $routeStr")
                    // Log a few available codes to help the user
                    if (allStaCodes.isNotEmpty()) {
                        val sample = allStaCodes.take(5).joinToString(", ")
                        logger?.invoke("   [Debug] Sample codes on this route: $sample...")
                    }
                }

                if (stationIndex != -1) {
                    // Look backwards from the station to find all buses behind it
                    for (i in stationIndex downTo 0) {
                        val sInfo = routeInfo.getJSONObject(i)
                        val busInfo = sInfo.optJSONArray("busInfo")
                        if (busInfo != null && busInfo.length() > 0) {
                            val stopsAway = stationIndex - i
                            // Add an entry for every bus found at this stop
                            for (j in 0 until busInfo.length()) {
                                processedData.add(
                                    BusInfo(routeStr, 0, -1, remaining = stopsAway.toDouble())
                                )
                            }
                        }
                    }
                }
            }
            response.close()
        }

        return FetchResult(processedData, "DSAT Official API")
    }

    /* ── Old Proxy API (fallback) ── */

    private fun fetchFromProxy(
        stationId: String,
        busNumbers: List<String>
    ): FetchResult {
        val timestamp = System.currentTimeMillis()
        val url = "https://motransportinfo.com/its/getStopInfo.php?ref=1&id=$stationId&_t=$timestamp"

        val request = Request.Builder()
            .url(url)
            .header("Cache-Control", "no-cache, no-store, must-revalidate")
            .header("Pragma", "no-cache")
            .header("Expires", "0")
            .header("User-Agent", "Mozilla/5.0 (compatible; BusMonitorAndroid/1.0)")
            .build()

        val response = client.newCall(request).execute()
        if (!response.isSuccessful) throw IOException("Proxy API failed: ${response.code}")

        val responseText = response.body?.string() ?: throw IOException("Empty response")
        response.close()

        if (responseText.trimStart().startsWith("<") || responseText.contains("Title:")) {
            throw IOException("Proxy API is currently unavailable")
        }

        val processedData = mutableListOf<BusInfo>()
        val arr = org.json.JSONArray(responseText)

        for (i in 0 until arr.length()) {
            val bus = arr.getJSONObject(i)
            val routeNo = bus.optString("route_no", "")
            val dir = bus.optInt("dir", 0)
            val lastbus = bus.optInt("lastbus", 0)

            // Check for nested bus sub-objects (keys "0", "1", etc.)
            var hasNested = false
            for (key in bus.keys()) {
                if (key.toIntOrNull() != null) {
                    val nested = bus.optJSONObject(key)
                    if (nested != null && nested.has("remaining")) {
                        hasNested = true
                        processedData.add(
                            BusInfo(routeNo, dir, lastbus,
                                remaining = nested.optDouble("remaining"))
                        )
                    }
                }
            }
            if (!hasNested) {
                processedData.add(BusInfo(routeNo, dir, lastbus))
            }
        }

        // Filter by requested bus numbers if specified
        val filtered = if (busNumbers.isNotEmpty()) {
            processedData.filter { bus ->
                busNumbers.any { it.trim() == bus.routeNo }
            }
        } else processedData

        return FetchResult(filtered, "Old Proxy API")
    }

    /* ── Format for Telegram ── */

    fun formatForTelegram(result: FetchResult, stationId: String, busNumbers: List<String>,
                          cycleNum: Int, maxCycles: Int): String {
        val sb = StringBuilder()

        if (result.buses.isEmpty()) {
            sb.appendLine("No bus information available")
        } else {
            // Group by route + direction
            val grouped = result.buses.groupBy { "${it.routeNo}_${it.dir}" }
            for ((key, buses) in grouped) {
                val routeNo = key.substringBefore("_")
                // Sort by distance (remaining stops or minutes)
                val sorted = buses.sortedBy { it.remaining ?: it.lastbus.toDouble() }

                val d = sorted.take(2).map { bus ->
                    when {
                        bus.remaining != null -> {
                            val r = bus.remaining
                            if (r == 0.0) "Now" else "${r.toInt()}"
                        }
                        bus.lastbus == -1 -> "Now"
                        else -> "${bus.lastbus}"
                    }
                }
                sb.appendLine("Bus $routeNo : ${d.joinToString(" -> ")}")
            }
        }

        val timeStr = java.text.SimpleDateFormat("yyyy/MM/dd HH:mm:ss",
            java.util.Locale.US).apply {
            timeZone = java.util.TimeZone.getTimeZone("Asia/Macau")
        }.format(java.util.Date())

        sb.appendLine("---------------")
        sb.appendLine("Station: $stationId")
        sb.appendLine("Update: $cycleNum/$maxCycles at $timeStr")
        sb.appendLine("Looking for: ${busNumbers.joinToString(", ")}")
        sb.appendLine("Source: ${result.source}")

        return sb.toString()
    }
}
