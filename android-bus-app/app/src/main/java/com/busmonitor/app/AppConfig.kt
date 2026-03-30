package com.busmonitor.app

import android.content.Context
import android.content.SharedPreferences

/**
 * Simple local config stored in SharedPreferences.
 * Holds Telegram credentials and bus stop list.
 */
object AppConfig {

    private const val PREFS_NAME = "bus_monitor_prefs"
    private const val KEY_BOT_TOKEN = "telegram_bot_token"
    private const val KEY_CHAT_ID = "telegram_chat_id"
    private const val KEY_BUS_STOPS = "bus_stops_json"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /* ── Telegram ── */

    fun getTelegramBotToken(ctx: Context): String =
        prefs(ctx).getString(KEY_BOT_TOKEN, "") ?: ""

    fun getTelegramChatId(ctx: Context): String =
        prefs(ctx).getString(KEY_CHAT_ID, "") ?: ""

    fun setTelegramCredentials(ctx: Context, botToken: String, chatId: String) {
        prefs(ctx).edit()
            .putString(KEY_BOT_TOKEN, botToken)
            .putString(KEY_CHAT_ID, chatId)
            .apply()
    }

    fun hasTelegramCredentials(ctx: Context): Boolean =
        getTelegramBotToken(ctx).isNotBlank() && getTelegramChatId(ctx).isNotBlank()

    /* ── Bus Stops ── */

    data class BusStop(
        val stationId: String,
        val busNumbers: List<String>,
        val note: String = ""
    )

    /** Returns the saved list of bus stops, or the default set if none saved. */
    fun getBusStops(ctx: Context): List<BusStop> {
        val json = prefs(ctx).getString(KEY_BUS_STOPS, null) ?: return defaultStops()
        return try {
            val arr = org.json.JSONArray(json)
            (0 until arr.length()).map { i ->
                val obj = arr.getJSONObject(i)
                BusStop(
                    stationId = obj.getString("stationId"),
                    busNumbers = obj.getJSONArray("busNumbers").let { a ->
                        (0 until a.length()).map { a.getString(it) }
                    },
                    note = obj.optString("note", "")
                )
            }
        } catch (_: Exception) {
            defaultStops()
        }
    }

    fun saveBusStops(ctx: Context, stops: List<BusStop>) {
        val arr = org.json.JSONArray()
        stops.forEach { stop ->
            val obj = org.json.JSONObject()
            obj.put("stationId", stop.stationId)
            obj.put("busNumbers", org.json.JSONArray(stop.busNumbers))
            obj.put("note", stop.note)
            arr.put(obj)
        }
        prefs(ctx).edit().putString(KEY_BUS_STOPS, arr.toString()).apply()
    }

    private fun defaultStops(): List<BusStop> = listOf(
        BusStop("T408", listOf("11", "39"), "氹仔中央公園"),
        BusStop("M172", listOf("11", "30", "34"), "亞馬喇前地")
    )
}
