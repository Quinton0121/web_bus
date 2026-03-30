package com.busmonitor.app

import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.*

/**
 * Generates the dynamic security token required by DSAT official API.
 * 
 * Logic:
 * 1. MD5(action=dy&routeName=...&dir=0&lang=zh-tw&routeType=2&device=web)
 * 2. Get timestamp YYYYMMDDHHmm in Macau time (UTC+8).
 * 3. Insert YYYY at index 4 of MD5.
 * 4. Insert MMDD at index 12 of original MD5 (index 16 of current string).
 * 5. Insert HHmm at index 24 of original MD5 (index 32 of current string).
 */
object DSATTokenGenerator {

    /**
     * @param params Map of request parameters (order is critical!)
     */
    fun generate(params: Map<String, String>): String {
        // 1. Build the base string
        val orderedKeys = listOf("action", "routeName", "dir", "lang", "routeType", "device")
        val baseStr = orderedKeys.joinToString("&") { key ->
            "$key=${params[key] ?: ""}"
        }

        // 2. MD5 hash
        val md5 = md5(baseStr)

        // 3. Timestamp in Macau time (UTC+8)
        val sdf = SimpleDateFormat("yyyyMMddHHmm", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("Asia/Macau")
        val ts = sdf.format(Date())

        // 4. Splicing logic: md5[:4] + YYYY + md5[4:12] + MMDD + md5[12:24] + HHmm + md5[24:]
        return buildString {
            append(md5.substring(0, 4))
            append(ts.substring(0, 4))      // YYYY
            append(md5.substring(4, 12))
            append(ts.substring(4, 8))      // MMDD
            append(md5.substring(12, 24))
            append(ts.substring(8, 12))     // HHmm
            append(md5.substring(24))
        }
    }

    private fun md5(input: String): String {
        val bytes = MessageDigest.getInstance("MD5").digest(input.toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
