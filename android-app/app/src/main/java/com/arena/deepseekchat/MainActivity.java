package com.arena.deepseekchat;

import android.animation.ValueAnimator;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
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
    private FrameLayout root;
    private View splash;
    private long splashAt;
    private boolean splashGone;
    private float safeTop, safeRight, safeBottom, safeLeft;
    private boolean hasInsets;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        boolean night = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int appBg = Color.parseColor(night ? "#17150F" : "#F7F5F0");

        webView = new WebView(this);
        webView.setBackgroundColor(appBg);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);

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

        // 关掉 WebView 边缘回弹：页面被整体拖拽位移是输入框脱离键盘的根源之一
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

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
                injectSafeArea();
                hideSplash();
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

        root = new FrameLayout(this);
        root.setBackgroundColor(appBg);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(root);

        buildSplash(night);

        applyInsets(root);
        setLightBars(!night);

        webView.loadUrl(START_URL);
    }

    /**
     * 启动画面：纸墨底色 + 鹈鹕线稿呼吸浮现 + 细线加载条。
     * 页面 onPageFinished 后淡出交给 WebView，至少展示 900ms 保证动画可读。
     */
    private void buildSplash(boolean night) {
        float d = getResources().getDisplayMetrics().density;
        int accent = Color.parseColor(night ? "#CD8055" : "#9E5330");
        int dim = Color.parseColor(night ? "#A29A8B" : "#6A6358");

        FrameLayout box = new FrameLayout(this);
        box.setBackgroundColor(Color.parseColor(night ? "#17150F" : "#F7F5F0"));
        box.setClickable(true);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        FrameLayout.LayoutParams colLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER);
        box.addView(col, colLp);

        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.ic_launcher_foreground);
        col.addView(mark, new LinearLayout.LayoutParams((int) (96 * d), (int) (96 * d)));

        TextView name = new TextView(this);
        name.setText(R.string.app_name);
        name.setTextColor(dim);
        name.setTextSize(15);
        name.setLetterSpacing(0.18f);
        LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nameLp.topMargin = (int) (10 * d);
        col.addView(name, nameLp);

        // 细线加载条：浅色轨道 + 一段滑动的品牌色
        int trackW = (int) (52 * d), trackH = (int) (3 * d), segW = (int) (20 * d);
        GradientDrawable trackBg = new GradientDrawable();
        trackBg.setColor(night ? Color.parseColor("#33CD8055") : Color.parseColor("#229E5330"));
        trackBg.setCornerRadius(trackH);
        GradientDrawable segBg = new GradientDrawable();
        segBg.setColor(accent);
        segBg.setCornerRadius(trackH);
        FrameLayout track = new FrameLayout(this);
        track.setBackground(trackBg);
        View seg = new View(this);
        seg.setBackground(segBg);
        track.addView(seg, new FrameLayout.LayoutParams(segW, trackH));
        LinearLayout.LayoutParams trackLp = new LinearLayout.LayoutParams(trackW, trackH);
        trackLp.topMargin = (int) (26 * d);
        col.addView(track, trackLp);

        // 入场：图标缩放浮现 → 名字上浮 → 加载条淡入并开始循环
        mark.setAlpha(0f);
        mark.setScaleX(0.84f);
        mark.setScaleY(0.84f);
        mark.animate().alpha(1f).scaleX(1f).scaleY(1f)
                .setDuration(430).setInterpolator(new DecelerateInterpolator()).start();
        name.setAlpha(0f);
        name.setTranslationY(10 * d);
        name.animate().alpha(1f).translationY(0f)
                .setStartDelay(150).setDuration(380)
                .setInterpolator(new DecelerateInterpolator()).start();
        track.setAlpha(0f);
        track.animate().alpha(1f).setStartDelay(280).setDuration(300).start();
        ValueAnimator loop = ValueAnimator.ofFloat(-segW, trackW);
        loop.setDuration(1150);
        loop.setRepeatCount(ValueAnimator.INFINITE);
        loop.setStartDelay(320);
        loop.setInterpolator(new AccelerateDecelerateInterpolator());
        loop.addUpdateListener(a -> seg.setTranslationX((float) a.getAnimatedValue()));
        loop.start();

        splash = box;
        splashAt = SystemClock.uptimeMillis();
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void hideSplash() {
        if (splash == null || splashGone) return;
        splashGone = true;
        long wait = Math.max(0, 900 - (SystemClock.uptimeMillis() - splashAt));
        splash.postDelayed(() -> {
            if (splash == null) return;
            splash.animate().alpha(0f).setDuration(300).withEndAction(() -> {
                if (splash != null) {
                    root.removeView(splash);
                    splash = null;
                }
            }).start();
        }, wait);
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
            // edge-to-edge 下 adjustResize 不生效，键盘避让靠这里把 ime.bottom
            // 注入 --safe-bottom 让前端抬升输入区
            int bottom = Math.max(bars.bottom, ime.bottom);
            v.setPadding(0, 0, 0, 0);
            // insets 是物理像素，WebView 的 CSS px 是 dp，必须换算后再注入
            float d = v.getResources().getDisplayMetrics().density;
            safeTop = bars.top / d;
            safeRight = bars.right / d;
            safeBottom = bottom / d;
            safeLeft = bars.left / d;
            hasInsets = true;
            injectSafeArea();
            return insets;
        });
    }

    /**
     * 把最近一次 insets 写进页面 CSS 变量。页面还没加载完时 evaluateJavascript
     * 会落在旧文档上、随导航被丢弃，所以 onPageFinished 里要重放一次。
     */
    private void injectSafeArea() {
        if (!hasInsets || webView == null) return;
        String js = "(function(){var r=document.documentElement.style;"
                + "r.setProperty('--safe-top','" + safeTop + "px');"
                + "r.setProperty('--safe-right','" + safeRight + "px');"
                + "r.setProperty('--safe-bottom','" + safeBottom + "px');"
                + "r.setProperty('--safe-left','" + safeLeft + "px');"
                + "window.dispatchEvent(new CustomEvent('safearea'));})()";
        webView.evaluateJavascript(js, null);
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
            int bg = Color.parseColor(light ? "#F7F5F0" : "#17150F");
            webView.setBackgroundColor(bg);
            // 状态栏区域露的是 root 背景，必须跟着换色
            root.setBackgroundColor(bg);
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
