package com.cuscam.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * Activity única que muestra el frontend web de cuscam dentro de un WebView.
 * Reusa toda la UI web (grid, PTZ, HD/SD, modales). El video va por HLS.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true            // necesario para localStorage (modo WebRTC/HLS)
                mediaPlaybackRequiresUserGesture = false // autoplay del video
                useWideViewPort = true
                loadWithOverviewMode = true
                cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            }
            // Mantener la navegación dentro del WebView.
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
        }

        setContentView(webView)

        // Cargar la URL configurada en strings.xml (cuscam_url).
        webView.loadUrl(getString(R.string.cuscam_url))

        // El botón Atrás navega en el historial del WebView antes de salir.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
