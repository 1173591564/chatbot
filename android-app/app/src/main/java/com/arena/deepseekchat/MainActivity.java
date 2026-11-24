package com.arena.deepseekchat;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.io.ByteArrayInputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 纯客户端壳：只负责承载 assets/www 下的前端、提供文件/剪贴板等原生能力。
 * 网络请求由前端直接发往 api.deepseek.com。
 */
public class MainActivity extends AppCompatActivity {

    private static final String START_URL = "file:///android_asset/www/index.html";

    private WebView webView;
    private NativeBridge bridge;
    private TextView errorView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#F7F5F0"));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " DeepSeekChat/1.0");

        // file:// 页面要 fetch 远程 API，必须放开同源限制。
        // API 30 起 allowUniversalAccessFromFileURLs 仍可用；30+ 另有 CORS 预处理兜底（见下）。
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setAllowFileAccessFromFileURLs(true);
        // 多窗口关掉：前端所有外链都走 AndroidBridge.openUrl()
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);

        bridge = new NativeBridge(this, webView);
        webView.addJavascriptInterface(bridge, "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {

            /** 外链用系统浏览器打开，不在 WebView 里跳走 */
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
                String host = u.getHost() == null ? "" : u.getHost();

                if (scheme.equals("http") || scheme.equals("https")) {
                    // 本地资源继续在 WebView 内加载
                    if (host.equals("localhost") || host.endsWith("android_asset")) return false;
                    openExternal(u);
                    return true;
                }
                if (scheme.equals("file")) return false;
                if (scheme.equals("mailto") || scheme.equals("tel") || scheme.equals("sms")) {
                    openExternal(u);
                    return true;
                }
                return true;
            }

            /**
             * 给 api.deepseek.com 的请求补 CORS 头。
             * WebView 里 file:// 的 Origin 是 "null"，服务端若不认这个 Origin，
             * 预检就会失败；这里在本地回写 Access-Control-* 兜底。
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                if (!host.endsWith("deepseek.com")) return null;

                String method = request.getMethod() == null ? "GET" : request.getMethod().toUpperCase();
                boolean preflight = "OPTIONS".equals(method);

                Map<String, String> headers = new HashMap<>();
                headers.put("Access-Control-Allow-Origin", "*");
                headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                headers.put("Access-Control-Allow-Headers", "*");
                headers.put("Access-Control-Max-Age", "86400");
                headers.put("Access-Control-Expose-Headers", "*");

                if (preflight) {
                    return new WebResourceResponse("text/plain", "utf-8", 204, "No Content",
                            headers, new ByteArrayInputStream(new byte[0]));
                }
                // 真实请求交给 WebView 自己发，这里只是不能改响应头，
                // 所以真正的 CORS 放行仍依赖服务端 / origin 全放开。
                return null;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (errorView != null && url != null && url.startsWith("about:")) return;
                if (errorView != null) errorView.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                if (request.isForMainFrame() && errorView != null) {
                    errorView.setText("页面加载失败：" + error.getDescription());
                    errorView.setVisibility(View.VISIBLE);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(android.webkit.PermissionRequest request) {
                request.deny();
            }
        });

        errorView = new TextView(this);
        errorView.setTextColor(Color.parseColor("#AC4033"));
        errorView.setTextSize(14);
        errorView.setPadding(48, 96, 48, 48);
        errorView.setVisibility(View.GONE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#F7F5F0"));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(root);

        applyInsets(root);
        setLightBars(true);

        webView.loadUrl(START_URL);
    }

    private void openExternal(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) {
        }
    }

    private void applyInsets(View root) {
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            int bottom = Math.max(bars.bottom, ime.bottom);
            v.setPadding(0, bars.top, 0, 0);
            String js = "(function(){var r=document.documentElement.style;"
                    + "r.setProperty('--safe-top','" + bars.top + "px');"
                    + "r.setProperty('--safe-right','" + bars.right + "px');"
                    + "r.setProperty('--safe-bottom','" + bottom + "px');"
                    + "r.setProperty('--safe-left','" + bars.left + "px');"
                    + "window.dispatchEvent(new CustomEvent('safearea'));})()";
            webView.evaluateJavascript(js, null);
            return insets;
        });
    }

    /** 状态栏/导航栏图标明暗，跟随前端主题 */
    private void setLightBars(boolean light) {
        WindowInsetsControllerCompat c =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setAppearanceLightStatusBars(light);
        c.setAppearanceLightNavigationBars(light);
    }

    /** 前端切换主题时调用（通过 AndroidBridge.setTheme） */
    void onThemeChanged(String theme) {
        boolean light = !"dark".equals(theme);
        runOnUiThread(() -> {
            setLightBars(light);
            webView.setBackgroundColor(Color.parseColor(light ? "#F7F5F0" : "#17150F"));
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (bridge != null) bridge.onActivityResult(requestCode, resultCode, data);
    }

    /**
     * 返回键：先问前端「有没有面板/编辑态要关」。
     * evaluateJavascript 是异步的，手快连按两下时第一次回调还没回来
     * 就会再排一次，最后两次都判成 false 直接退到桌面——用一个闸门挡住。
     */
    private boolean backPending = false;

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (backPending) return;
        backPending = true;
        webView.evaluateJavascript(
                "(function(){return !!(window.__handleBack && window.__handleBack());})()",
                value -> {
                    backPending = false;
                    // 回调一定在 UI 线程，安全
                    if (!"true".equals(value)) finish();
                });
    }

    /** 退到后台时让前端立刻落盘（WebView 可能随后被杀） */
    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.evaluateJavascript(
                    "window.__flushStorage && window.__flushStorage()", null);
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.loadUrl("about:blank");
            webView.destroy();
        }
    }
}
