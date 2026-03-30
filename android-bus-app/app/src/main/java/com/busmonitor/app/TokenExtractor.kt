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

    private const val TIMEOUT_MS = 20_000L

    /**
     * Extract DSAT cookies by loading the route page in a hidden WebView.
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

                val finalize = {
                    if (!completed) {
                        completed = true
                        CookieManager.getInstance().flush()
                        val cookieStr = CookieManager.getInstance()
                            .getCookie("https://bis.dsat.gov.mo:37812") ?: ""
                        
                        android.util.Log.d("TokenExtractor", "Cookie captured: ${cookieStr.take(60)}...")
                        
                        destroyWebView(webView)
                        webView = null
                        if (cont.isActive) cont.resume(Credentials("", cookieStr))
                    }
                }

                val timeoutRunnable = Runnable { finalize() }
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
                    override fun onPageFinished(view: WebView?, url: String?) {
                        // Once page is finished, we likely have the huid cookie
                        finalize()
                    }

                    override fun onReceivedError(
                        view: WebView?, request: WebResourceRequest?,
                        error: WebResourceError?
                    ) {
                        if (request?.isForMainFrame == true) finalize()
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
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
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
