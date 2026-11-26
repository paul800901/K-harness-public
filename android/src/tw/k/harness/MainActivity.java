package tw.k.harness;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Shows the PC's K page (the same page as the browser version) and switches the notification on. */
public class MainActivity extends Activity {
    private static final int REQUEST_FILE = 1;
    private static final int REQUEST_NOTIFICATIONS = 2;
    private static final int REQUEST_MICROPHONE = 3;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingMicrophone;
    /** The room a notification asked for, until the K page takes it (it may still be loading or logging in). */
    private final AtomicReference<String> pendingThread = new AtomicReference<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this) {
            @Override
            public ActionMode startActionMode(ActionMode.Callback callback, int type) {
                return super.startActionMode(
                        type == ActionMode.TYPE_FLOATING ? new QuoteMenu(callback) : callback, type);
            }
        };
        setContentView(web);
        CookieManager.getInstance().setAcceptCookie(true);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setTextZoom(100); // the same text size as the K page in Chrome

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (Shell.isK(request.getUrl())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush(); // the notification connection reads the same login
                KService.wakeIfRunning(); // e.g. just logged in; never switches it back on after 結束
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = params.createIntent()
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(intent, null), REQUEST_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                boolean microphoneOnly = Shell.isK(request.getOrigin()) && request.getResources().length == 1
                        && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(request.getResources()[0]);
                if (!microphoneOnly) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(request.getResources());
                    return;
                }
                if (pendingMicrophone != null) pendingMicrophone.deny();
                pendingMicrophone = request;
                requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE);
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mimeType, length) -> download(url, disposition, mimeType));
        // The K page asks for the room when it is ready and can ask for an update check (frontend/main.jsx).
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public String takeThread() {
                return pendingThread.getAndSet(null);
            }

            @JavascriptInterface
            public void checkUpdate() {
                runOnUiThread(() -> ShellUpdater.check(MainActivity.this, true));
            }

            /** 「加入聊天」 lives in the native selection menu, so the page hides its own toolbar. */
            @JavascriptInterface
            public boolean nativeQuoteMenu() {
                return true;
            }

            @JavascriptInterface
            public boolean selectionCommandHook() {
                return true;
            }
        }, "KApp");

        pendingThread.set(getIntent().getStringExtra(KService.EXTRA_THREAD));
        web.loadUrl(Shell.ORIGIN + "/");
        askNotificationsThenBattery();
        ShellUpdater.check(this, false);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String thread = intent.getStringExtra(KService.EXTRA_THREAD);
        if (thread == null) return;
        pendingThread.set(thread);
        web.evaluateJavascript("window.dispatchEvent(new Event('k-open-thread'))", null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        // The page counts a room as read only while it has focus, as in a browser tab.
        web.requestFocus();
        KService.start(this);
        ShellUpdater.resumed(this);
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ShellUpdater.destroyed(this);
        web.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // The K page uses browser history for its panels; leave K only from the chat itself.
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    /**
     * Wraps the WebView's floating text selection menu (this app only): 「加入聊天」 first, then
     * only copy / select all / share (plus cut / paste in text fields). The owner does not want
     * Gemini, translate or app-management entries inside K. The page reads the selection itself
     * (frontend/main.jsx, k-add-selection). WebView rebuilds the menu when the selection
     * changes, so the menu is trimmed on create and on prepare.
     */
    private final class QuoteMenu extends ActionMode.Callback2 {
        private static final int ID = 0x4b51; // "KQ"
        private final ActionMode.Callback inner;
        private boolean finished;

        QuoteMenu(ActionMode.Callback inner) {
            this.inner = inner;
        }

        private String resourceName(MenuItem item) {
            try {
                return getResources().getResourceEntryName(item.getItemId());
            } catch (android.content.res.Resources.NotFoundException e) {
                return "";
            }
        }

        private boolean keep(MenuItem item) {
            int id = item.getItemId();
            if (id == ID || id == android.R.id.copy || id == android.R.id.selectAll || id == android.R.id.cut
                    || id == android.R.id.paste || id == android.R.id.pasteAsPlainText || id == android.R.id.shareText)
                return true;
            // Chromium's own entries use WebView resource ids whose numbers differ per WebView build,
            // so match them by resource name.
            if (id == 0) return false;
            switch (resourceName(item)) {
                case "select_action_menu_copy":
                case "select_action_menu_select_all":
                case "select_action_menu_cut":
                case "select_action_menu_paste":
                case "select_action_menu_paste_as_plain_text":
                case "select_action_menu_share":
                    return true;
                default:
                    return false;
            }
        }

        /** Returns whether the menu changed. */
        private boolean trim(Menu menu) {
            // removeItem(id) drops the first item with that id, so never remove an id that a kept
            // item also uses (e.g. several entries with id 0).
            java.util.Set<Integer> kept = new java.util.HashSet<>();
            for (int i = 0; i < menu.size(); i++)
                if (keep(menu.getItem(i))) kept.add(menu.getItem(i).getItemId());
            boolean changed = false;
            for (int i = menu.size() - 1; i >= 0; i--) {
                int id = menu.getItem(i).getItemId();
                if (!kept.contains(id)) {
                    menu.removeItem(id);
                    changed = true;
                }
            }
            if (menu.findItem(ID) == null) {
                menu.add(Menu.NONE, ID, 0, "加入聊天").setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS);
                changed = true;
            }
            return changed;
        }

        @Override
        public boolean onCreateActionMode(ActionMode mode, Menu menu) {
            boolean show = inner.onCreateActionMode(mode, menu);
            trim(menu);
            return show;
        }

        @Override
        public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
            boolean changed = inner.onPrepareActionMode(mode, menu);
            return trim(menu) || changed;
        }

        @Override
        public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
            int id = item.getItemId();
            String name = resourceName(item);
            boolean copy = id == android.R.id.copy || name.equals("select_action_menu_copy");
            boolean share = id == android.R.id.shareText || name.equals("select_action_menu_share");
            if (id == android.R.id.selectAll || name.equals("select_action_menu_select_all")) {
                web.evaluateJavascript("window.dispatchEvent(new Event('k-select-all'))", ignored -> {
                    if (!finished) inner.onActionItemClicked(mode, item);
                });
                return true;
            }
            if (copy || share) {
                web.evaluateJavascript("(()=>{const detail={};window.dispatchEvent(new CustomEvent('k-read-selection',{detail}));return detail.text??null})()", value -> {
                    if (finished) return;
                    if (value == null || value.equals("null")) {
                        inner.onActionItemClicked(mode, item);
                        return;
                    }
                    try {
                        String text = (String)new org.json.JSONTokener(value).nextValue();
                        if (text.isEmpty()) {
                            mode.finish();
                            return;
                        }
                        if (copy) {
                            getSystemService(android.content.ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("", text));
                        } else {
                            startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain")
                                    .putExtra(Intent.EXTRA_TEXT, text), null));
                        }
                        mode.finish();
                    } catch (org.json.JSONException | ActivityNotFoundException e) {
                        Toast.makeText(MainActivity.this, "無法完成選取操作", Toast.LENGTH_SHORT).show();
                    }
                });
                return true;
            }
            if (item.getItemId() != ID) return inner.onActionItemClicked(mode, item);
            // Finish only after the page has read the selection.
            web.evaluateJavascript("window.dispatchEvent(new Event('k-add-selection'))", ignored -> mode.finish());
            return true;
        }

        @Override
        public void onDestroyActionMode(ActionMode mode) {
            finished = true;
            inner.onDestroyActionMode(mode);
        }

        @Override
        public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
            if (inner instanceof ActionMode.Callback2) ((ActionMode.Callback2) inner).onGetContentRect(mode, view, outRect);
            else super.onGetContentRect(mode, view, outRect);
        }
    }

    private void showOffline() {
        String html = "<!doctype html><html lang='zh-Hant-TW'><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;min-height:100vh;display:grid;place-items:center;background:#fbf7f0;color:#2b241d;font:16px system-ui'>"
                + "<main style='padding:24px;max-width:360px'><h2>連不到電腦上的 K</h2>"
                + "<p style='color:#71665a;line-height:1.7'>請確認手機的 Tailscale 已連線，而且電腦的 K 開著。</p>"
                + "<button onclick=\"location.href='" + Shell.ORIGIN + "/'\" style='font:inherit;min-height:48px;width:100%;"
                + "border-radius:14px;border:1px solid #2b241d;background:#2b241d;color:#fffdf9'>重新連線</button></main></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void download(String url, String disposition, String mimeType) {
        Uri uri = Uri.parse(url);
        if (!Shell.isK(uri)) {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
            return;
        }
        String name = fileName(url, disposition, mimeType);
        DownloadManager.Request request = new DownloadManager.Request(uri)
                .setTitle(name)
                .setMimeType(mimeType)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        String cookie = Shell.cookie();
        if (cookie != null) request.addRequestHeader("Cookie", cookie);
        getSystemService(DownloadManager.class).enqueue(request);
        Toast.makeText(this, "開始下載：" + name, Toast.LENGTH_SHORT).show();
    }

    /** K sends names as filename*=UTF-8''…, which Android's own guess does not decode. */
    private static String fileName(String url, String disposition, String mimeType) {
        if (disposition != null) {
            Matcher m = Pattern.compile("filename\\*=UTF-8''([^;]+)", Pattern.CASE_INSENSITIVE).matcher(disposition);
            if (m.find()) {
                try {
                    String name = URLDecoder.decode(m.group(1).trim(), StandardCharsets.UTF_8.name())
                            .replaceAll("[\\\\/:*?\"<>|]", "_");
                    if (!name.isEmpty()) return name;
                } catch (Exception ignored) {
                }
            }
        }
        return URLUtil.guessFileName(url, disposition, mimeType);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < result.length; i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) result = new Uri[] {data.getData()};
        }
        if (fileCallback != null) fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ---- first-run permissions ------------------------------------------------------

    private void askNotificationsThenBattery() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        else askBatteryOnce();
    }

    /** Samsung stops background apps to save power; without this the notification would go stale. */
    private void askBatteryOnce() {
        PowerManager power = getSystemService(PowerManager.class);
        SharedPreferences prefs = getSharedPreferences("k", MODE_PRIVATE);
        if (power.isIgnoringBatteryOptimizations(getPackageName()) || prefs.getBoolean("askedBattery", false)) return;
        prefs.edit().putBoolean("askedBattery", true).apply();
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQUEST_NOTIFICATIONS) askBatteryOnce();
        if (requestCode == REQUEST_MICROPHONE && pendingMicrophone != null) {
            if (granted) pendingMicrophone.grant(pendingMicrophone.getResources());
            else pendingMicrophone.deny();
            pendingMicrophone = null;
        }
    }
}
