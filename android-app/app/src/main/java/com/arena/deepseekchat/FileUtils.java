package com.arena.deepseekchat;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public final class FileUtils {

    private FileUtils() {
    }

    static String displayName(Context ctx, Uri uri) {
        String name = null;
        try (Cursor c = ctx.getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = c.getString(idx);
            }
        } catch (Exception ignored) {
        }
        if (name == null || name.isEmpty()) {
            name = uri.getLastPathSegment();
            if (name != null && name.contains("/")) {
                name = name.substring(name.lastIndexOf('/') + 1);
            }
        }
        if (name == null || name.isEmpty() || !name.contains(".")) {
            // 拍照等场景 lastPathSegment 可能是 "photos/photo_123.jpg" 之类，取文件名
            if (name == null || !name.contains(".")) {
                String mime = null;
                try {
                    mime = ctx.getContentResolver().getType(uri);
                } catch (Exception ignored) {
                }
                if (mime != null && mime.startsWith("image/")) {
                    String ext = mime.substring("image/".length());
                    if (ext.equals("jpeg")) ext = "jpg";
                    return "photo_" + System.currentTimeMillis() + "." + ext;
                }
            }
        }
        return (name == null || name.isEmpty()) ? "file" : name;
    }

    static long sizeOf(Context ctx, Uri uri) {
        try (Cursor c = ctx.getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.SIZE);
                if (idx >= 0 && !c.isNull(idx)) return c.getLong(idx);
            }
        } catch (Exception ignored) {
        }
        // FileProvider 的 content:// 常常查不到 SIZE，用文件描述符拿长度
        try (android.content.res.AssetFileDescriptor afd =
                     ctx.getContentResolver().openAssetFileDescriptor(uri, "r")) {
            if (afd != null && afd.getLength() > 0) return afd.getLength();
        } catch (Exception ignored) {
        }
        try (InputStream in = ctx.getContentResolver().openInputStream(uri)) {
            return in == null ? 0 : in.available();
        } catch (Exception e) {
            return 0;
        }
    }

    static byte[] readAll(Context ctx, Uri uri) throws Exception {
        ContentResolver cr = ctx.getContentResolver();
        try (InputStream in = cr.openInputStream(uri);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (in == null) throw new IllegalStateException("无法打开文件");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    static String guessMime(String name) {
        if (name == null) return "application/octet-stream";
        int dot = name.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = name.substring(dot + 1).toLowerCase();
        switch (ext) {
            case "pdf": return "application/pdf";
            case "doc": return "application/msword";
            case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "ppt": return "application/vnd.ms-powerpoint";
            case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            case "xls": return "application/vnd.ms-excel";
            case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "txt": return "text/plain";
            case "md": return "text/markdown";
            case "csv": return "text/csv";
            case "json": return "application/json";
            case "epub": return "application/epub+zip";
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "gif": return "image/gif";
            default: {
                String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                return m == null ? "application/octet-stream" : m;
            }
        }
    }
}
