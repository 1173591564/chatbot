package com.arena.deepseekchat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * WebView 与原生之间的桥。
 * 前端调用 window.AndroidBridge.xxx(...)，结果通过 evaluateJavascript 回调。
 */
public class NativeBridge {

    private final Activity activity;
    private final WebView webView;

    static final int REQ_PICK_FILE = 1001;
    static final int REQ_TAKE_PHOTO = 1002;

    /** 请求队列：主线程入队、后台读文件线程出队，必须用线程安全实现 */
    private final java.util.concurrent.ConcurrentLinkedQueue<String> pendingCallbacks =
            new java.util.concurrent.ConcurrentLinkedQueue<>();
    private Uri pendingPhotoUri = null;

    NativeBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /* ---------------- 文件选择 ---------------- */

    @JavascriptInterface
    public void pickFile(String callbackId) {
        pendingCallbacks.add(callbackId);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/pdf",
                "application/msword",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/vnd.ms-powerpoint",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "application/vnd.ms-excel",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "text/plain",
                "text/markdown",
                "text/csv",
                "application/json",
                "image/*"
        });
        try {
            activity.startActivityForResult(intent, REQ_PICK_FILE);
        } catch (ActivityNotFoundException e) {
            fail("没有找到文件管理器");
        }
    }

    /* ---------------- 拍照 ---------------- */

    @JavascriptInterface
    public void takePhoto(String callbackId) {
        pendingCallbacks.add(callbackId);
        try {
            File dir = new File(activity.getCacheDir(), "photos");
            if (!dir.exists()) dir.mkdirs();
            File photo = new File(dir, "photo_" + System.currentTimeMillis() + ".jpg");
            pendingPhotoUri = FileProvider.getUriForFile(
                    activity,
                    activity.getPackageName() + ".fileprovider",
                    photo
            );
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, pendingPhotoUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            activity.startActivityForResult(intent, REQ_TAKE_PHOTO);
        } catch (Exception e) {
            fail("无法启动相机：" + e.getMessage());
        }
    }

    /* ---------------- 结果处理 ---------------- */

    boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_PICK_FILE && requestCode != REQ_TAKE_PHOTO) return false;
        if (pendingCallbacks.isEmpty()) return true;

        if (resultCode != Activity.RESULT_OK) {
            fail("已取消");
            return true;
        }

        // 读文件 + base64 可能几百毫秒到数秒，绝不能放在主线程（会卡 UI）
        final Uri single = requestCode == REQ_PICK_FILE
                ? (data != null ? data.getData() : null)
                : pendingPhotoUri;
        final android.content.ClipData clip =
                requestCode == REQ_PICK_FILE && data != null ? data.getClipData() : null;

        if (clip == null && single == null) {
            fail("没有拿到文件");
            return true;
        }

        new Thread(() -> {
            try {
                if (clip != null) {
                    org.json.JSONArray items = new org.json.JSONArray();
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        JSONObject one = buildPayload(clip.getItemAt(i).getUri());
                        if (one != null) items.put(one);
                    }
                    if (items.length() == 0) { fail("没有拿到文件"); return; }
                    successMulti(items);
                } else {
                    JSONObject payload = buildPayload(single);
                    if (payload == null) { fail("读取文件失败"); return; }
                    success(payload.toString());
                }
            } catch (Exception e) {
                fail("读取文件失败：" + e.getMessage());
            }
        }, "file-read").start();
        return true;
    }

    /** 把单个 Uri 读成前端可用的 payload；失败返回 null */
    private JSONObject buildPayload(Uri uri) {
        try {
            String name = FileUtils.displayName(activity, uri);
            String mime = activity.getContentResolver().getType(uri);
            if (mime == null) mime = FileUtils.guessMime(name);

            // 小文件直接走 base64；大文件先拷到私有目录再分块读
            long size = FileUtils.sizeOf(activity, uri);
            int maxInline = 8 * 1024 * 1024;

            JSONObject payload = new JSONObject();
            payload.put("name", name);
            payload.put("mime", mime);
            payload.put("size", size);

            if (size <= maxInline) {
                byte[] bytes = FileUtils.readAll(activity, uri);
                payload.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                payload.put("chunked", false);
            } else {
                // 拷进私有目录，前端用 chunk 接口按需读，避免内存爆掉
                File dir = new File(activity.getFilesDir(), "uploads");
                if (!dir.exists()) dir.mkdirs();
                File dest = new File(dir, System.currentTimeMillis() + "_" + name);
                try (InputStream in = activity.getContentResolver().openInputStream(uri);
                     OutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                payload.put("path", dest.getAbsolutePath());
                payload.put("chunked", true);
            }
            return payload;
        } catch (Exception e) {
            return null;
        }
    }

    /** 多选结果：payload 是一组文件 */
    private void successMulti(org.json.JSONArray items) {
        String cb = pendingCallbacks.poll();
        if (cb == null) return;
        String js = "window.__nativeResolve(" + JSONObject.quote(cb)
                + ",{ok:true,payloads:" + items + "})";
        evaluate(js);
    }

    /**
     * 只允许操作 App 私有目录里的文件。
     * 用「路径 + 分隔符」做前缀，否则 .../files_evil 这种兄弟目录会被误判为合法。
     */
    private boolean insideFilesDir(File f) {
        try {
            String base = activity.getFilesDir().getCanonicalPath();
            String p = f.getCanonicalPath();   // 顺带解析 ../ 与符号链接
            return p.equals(base) || p.startsWith(base + File.separator);
        } catch (Exception e) {
            return false;
        }
    }

    /** 大文件分块读取：offset 字节起、length 字节，返回 base64 */
    @JavascriptInterface
    public String readChunk(String path, long offset, int length) {
        try {
            File f = new File(path);
            if (!insideFilesDir(f)) {
                return "";
            }
            try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r")) {
                raf.seek(offset);
                int len = (int) Math.min(length, Math.max(0, f.length() - offset));
                byte[] buf = new byte[len];
                raf.readFully(buf);
                return Base64.encodeToString(buf, Base64.NO_WRAP);
            }
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public void deleteTemp(String path) {
        try {
            File f = new File(path);
            if (insideFilesDir(f)) {
                f.delete();
            }
        } catch (Exception ignored) {
        }
    }

    /* ---------------- 其他 ---------------- */

    @JavascriptInterface
    public void copyText(String text) {
        activity.runOnUiThread(() -> {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) activity.getSystemService(Activity.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(android.content.ClipData.newPlainText("text", text));
            Toast.makeText(activity, "已复制", Toast.LENGTH_SHORT).show();
        });
    }

    /** 用系统浏览器打开链接（引用角标、来源列表都走这里） */
    @JavascriptInterface
    public void openUrl(String url) {
        if (url == null) return;
        String u = url.trim();
        if (!u.startsWith("http://") && !u.startsWith("https://")) return;
        activity.runOnUiThread(() -> {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(i);
            } catch (Exception e) {
                Toast.makeText(activity, "没有可用的浏览器", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /** 前端切换明暗主题时同步状态栏图标颜色 */
    @JavascriptInterface
    public void setTheme(String theme) {
        if (activity instanceof MainActivity) {
            ((MainActivity) activity).onThemeChanged(theme);
        }
    }

    @JavascriptInterface
    public String getVersionName() {
        try {
            return activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1.0.0";
        }
    }


    /* ---------------- 回调辅助 ---------------- */

    private void success(String payloadJson) {
        String cb = pendingCallbacks.poll();
        if (cb == null) return;
        String js = "window.__nativeResolve(" + JSONObject.quote(cb) + ",{ok:true,payload:" + payloadJson + "})";
        evaluate(js);
    }

    private void fail(String message) {
        String cb = pendingCallbacks.poll();
        if (cb == null) return;
        String js = "window.__nativeResolve(" + JSONObject.quote(cb)
                + ",{ok:false,error:" + JSONObject.quote(message) + "})";
        evaluate(js);
    }

    private void evaluate(String js) {
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
