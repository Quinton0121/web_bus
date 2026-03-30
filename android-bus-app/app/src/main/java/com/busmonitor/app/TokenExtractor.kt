package com.busmonitor.app

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.*
import kotlinx.coroutines.*
import kotlin.coroutines.resume

/**
 * Replaces Puppeteer: uses a hidden Android WebView to load the DSAT page
 * and intercept the token from the XHR request to /macauweb/routestation/bus.
 *
 * After extraction the WebView is fully destroyed to free resources.
 */
object TokenExtractor {

    data class Credentials(val token: String, val cookie: String)

    private const val TIMEOUT_MS = 30_000L

    /**
     * Extract DSAT token + cookies by loading the route page in a hidden WebView.
     * Must be called from a coroutine; internally posts to main thread for WebView ops.
     */
    suspend fun extract(context: Context, routeName: String = "11"): Credentials =
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine { cont ->
                val targetUrl =
                    "https://bis.dsat.gov.mo:37812/macauweb/routeLine.html" +
                    "?routeName=$routeName&direction=0&language=zh-tw&ver=3.8.6" +
                    "&routeType=2&fromDzzp=false"

                var webView: WebView? = createWebView(context)
                var completed = false

                val timeoutRunnable = Runnable {
                    if (!completed) {
                        completed = true
                        destroyWebView(webView)
                        webView = null
                        if (cont.isActive) cont.resume(
                            Credentials("", "")  // empty = failed
                        )
                    }
                }
                Handler(Looper.getMainLooper()).postDelayed(timeoutRunnable, TIMEOUT_MS)

                cont.invokeOnCancellation {
                    completed = true
                    Handler(Looper.getMainLooper()).removeCallbacks(timeoutRunnable)
                    Handler(Looper.getMainLooper()).post {
                        destroyWebView(webView)
                        webView = null
                    }
                }

                webView?.webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView?,
                        request: WebResourceRequest?
                    ): WebResourceResponse? {
                        val url = request?.url?.toString() ?: ""
                        if (url.contains("/macauweb/routestation/bus") && !completed) {
                            val token = request?.requestHeaders?.get("token") ?: ""
                            if (token.isNotBlank()) {
                                completed = true
                                Handler(Looper.getMainLooper()).removeCallbacks(timeoutRunnable)

                                // Read cookies from CookieManager
                                // (WebResourceRequest.getRequestHeaders() does NOT include cookies on Android)
                                CookieManager.getInstance().flush()
                                val cookieStr = CookieManager.getInstance()
                                    .getCookie("https://bis.dsat.gov.mo:37812") ?: ""

                                android.util.Log.d("TokenExtractor",
                                    "Token: ${token.take(20)}... Cookie: ${cookieStr.take(80)}...")

                                Handler(Looper.getMainLooper()).post {
                                    destroyWebView(webView)
                                    webView = null
                                }

                                if (cont.isActive) cont.resume(Credentials(token, cookieStr))
                            }
                        }
                        return super.shouldInterceptRequest(view, request)
                    }

                    override fun onReceivedError(
                        view: WebView?, request: WebResourceRequest?,
                        error: WebResourceError?
                    ) {
                        // Only fail on main frame errors
                        if (request?.isForMainFrame == true && !completed) {
                            completed = true
                            Handler(Looper.getMainLooper()).removeCallbacks(timeoutRunnable)
                            Handler(Looper.getMainLooper()).post {
                                destroyWebView(webView)
                                webView = null
                            }
                            if (cont.isActive) cont.resume(Credentials("", ""))
                        }
                    }
                }

                webView?.loadUrl(targetUrl)
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(context: Context): WebView {
        return WebView(context.applicationContext).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.userAgentString =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            // Accept cookies
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        }
    }

    private fun destroyWebView(wv: WebView?) {
        wv?.run {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
            removeAllViews()
            destroy()
        }
    }
}
