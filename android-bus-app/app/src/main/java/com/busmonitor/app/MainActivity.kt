package com.busmonitor.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import org.json.JSONArray
import org.json.JSONObject

/**
 * Single-activity app.
 * Loads a local HTML page in a WebView and bridges to Kotlin via @JavascriptInterface.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
            addJavascriptInterface(Bridge(), "Android")
        }
        setContentView(webView)
        webView.loadUrl("file:///android_asset/index.html")

        // Observe logs and monitoring state from the Service via EventBus
        observeEventBus()

        // Request notification permission for Android 13+
        requestNotificationPermission()
    }

    private fun observeEventBus() {
        scope.launch {
            MonitoringEventBus.logs.collect { msg ->
                jsLog(msg)
            }
        }
        scope.launch {
            MonitoringEventBus.isMonitoring.collectLatest { active ->
                jsSetMonitoring(active)
            }
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        webView.destroy()
        super.onDestroy()
    }

    /* ─── JavaScript ↔ Kotlin bridge ─── */

    inner class Bridge {

        /** Called from JS when user presses "Request Bus Data" on a stop card. */
        @JavascriptInterface
        fun startMonitoring(stationId: String, busNumbersJson: String) {
            val busNumbers = try {
                val arr = JSONArray(busNumbersJson)
                ArrayList((0 until arr.length()).map { arr.getString(it) })
            } catch (_: Exception) {
                arrayListOf(busNumbersJson)
            }

            val intent = Intent(this@MainActivity, MonitoringService::class.java).apply {
                action = MonitoringService.ACTION_START
                putExtra(MonitoringService.EXTRA_STATION_ID, stationId)
                putStringArrayListExtra(MonitoringService.EXTRA_BUS_NUMBERS, busNumbers)
            }
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        }

        /** Called from JS when user presses "Stop Monitoring". */
        @JavascriptInterface
        fun stopMonitoring() {
            val intent = Intent(this@MainActivity, MonitoringService::class.java).apply {
                action = MonitoringService.ACTION_STOP
            }
            startService(intent)
        }

        /** Load config to populate the UI. */
        @JavascriptInterface
        fun loadConfig(): String {
            val stops = AppConfig.getBusStops(applicationContext)
            val arr = JSONArray()
            stops.forEach { stop ->
                arr.put(JSONObject().apply {
                    put("stationId", stop.stationId)
                    put("busNumbers", JSONArray(stop.busNumbers))
                    put("note", stop.note)
                })
            }
            val cfg = JSONObject().apply {
                put("busStops", arr)
                put("hasTelegram", AppConfig.hasTelegramCredentials(applicationContext))
            }
            return cfg.toString()
        }

        /** Save Telegram credentials from the settings form. */
        @JavascriptInterface
        fun saveTelegramSettings(botToken: String, chatId: String) {
            AppConfig.setTelegramCredentials(applicationContext, botToken, chatId)
            runOnUiThread { jsLog("✅ Telegram settings saved") }
        }

        /** Load Telegram credentials for pre-filling the form. */
        @JavascriptInterface
        fun loadTelegramSettings(): String {
            val obj = JSONObject().apply {
                put("botToken", AppConfig.getTelegramBotToken(applicationContext))
                put("chatId", AppConfig.getTelegramChatId(applicationContext))
            }
            return obj.toString()
        }

        /** Add a new bus stop. */
        @JavascriptInterface
        fun addBusStop(stationId: String, busNumbersJson: String, note: String) {
            val busNumbers = try {
                val arr = JSONArray(busNumbersJson)
                (0 until arr.length()).map { arr.getString(it) }
            } catch (_: Exception) {
                busNumbersJson.split(",").map { it.trim() }.filter { it.isNotEmpty() }
            }
            val stops = AppConfig.getBusStops(applicationContext).toMutableList()
            stops.add(AppConfig.BusStop(stationId, busNumbers, note))
            AppConfig.saveBusStops(applicationContext, stops)
            runOnUiThread { jsLog("✅ Bus stop added: $stationId") }
        }

        /** Remove a bus stop by stationId. */
        @JavascriptInterface
        fun removeBusStop(stationId: String) {
            val stops = AppConfig.getBusStops(applicationContext).toMutableList()
            stops.removeAll { it.stationId == stationId }
            AppConfig.saveBusStops(applicationContext, stops)
        }
    }

    /* ─── helpers to call JS from Kotlin ─── */

    private fun jsLog(msg: String) {
        val escaped = msg.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
        webView.evaluateJavascript("if(window.addLog) window.addLog('$escaped')", null)
    }

    private fun jsSetMonitoring(active: Boolean) {
        webView.evaluateJavascript(
            "if(window.setMonitoringState) window.setMonitoringState($active)", null
        )
    }
}
