package tw.k.harness;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.security.MessageDigest;

/**
 * Checks the PC's K for a newer build of this app and installs it after the owner
 * agrees. Android always asks once more before installing an app outside the store.
 */
final class ShellUpdater {
    /** One check, one question and one download at a time. Read and written on the UI thread only. */
    private enum Step { IDLE, CHECKING, ASKING, DOWNLOADING }

    private static Step step = Step.IDLE;
    private static boolean askAfterPermission;
    private static AlertDialog question;
    private static Activity questionOwner;

    private ShellUpdater() {}

    /**
     * Checked when K is opened and when the owner presses App 更新 in the K page;
     * only a manual check also reports "up to date" or a failure. Call on the UI thread.
     */
    static void check(Activity activity, boolean manual) {
        if (step != Step.IDLE) {
            if (manual && step == Step.DOWNLOADING)
                Toast.makeText(activity, "正在下載新版 K App…", Toast.LENGTH_SHORT).show();
            return;
        }
        step = Step.CHECKING;
        new Thread(() -> {
            String note;
            try {
                HttpURLConnection connection = Shell.open("/api/android/shell");
                connection.setReadTimeout(15000);
                if (connection.getResponseCode() != 200) throw new Exception();
                JSONObject info = new JSONObject(Shell.readAll(connection.getInputStream()));
                PackageInfo mine = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
                if (info.optBoolean("available") && info.optLong("versionCode") > mine.getLongVersionCode()) {
                    activity.runOnUiThread(() -> offer(activity, info));
                    return;
                }
                note = "K App 已是最新版（" + mine.versionName + "）";
            } catch (Exception e) {
                note = "連不到電腦上的 K，稍後再試";
            }
            String message = note;
            activity.runOnUiThread(() -> {
                step = Step.IDLE;
                if (manual) Toast.makeText(activity, message, Toast.LENGTH_SHORT).show();
            });
        }, "k-shell-check").start();
    }

    /** Back from the "install unknown apps" setting: offer the update again. */
    static void resumed(Activity activity) {
        if (!askAfterPermission) return;
        askAfterPermission = false;
        check(activity, false);
    }

    private static void offer(Activity activity, JSONObject info) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            step = Step.IDLE;
            return;
        }
        step = Step.ASKING;
        questionOwner = activity;
        question = new AlertDialog.Builder(activity)
                .setTitle("手機 K App 有新版本")
                .setMessage("要更新到 " + info.optString("versionName") + " 嗎？\n下載後 Android 會請你按一次「安裝」。")
                .setPositiveButton("更新", (dialog, which) -> download(activity, info))
                .setNegativeButton("稍後", null)
                // Dismissed by 稍後 or back; after 更新 the step has already moved on.
                .setOnDismissListener(dialog -> {
                    if (dialog != question) return; // already cleared by destroyed()
                    question = null;
                    questionOwner = null;
                    if (step == Step.ASKING) step = Step.IDLE;
                })
                .show();
    }

    /** K's screen is going away: close its question too, so the next screen can ask again. */
    static void destroyed(Activity activity) {
        if (question == null || questionOwner != activity) return;
        AlertDialog closing = question;
        question = null;
        questionOwner = null;
        if (step == Step.ASKING) step = Step.IDLE;
        closing.dismiss();
    }

    private static void download(Activity activity, JSONObject info) {
        if (step != Step.ASKING) return;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            step = Step.IDLE;
            askAfterPermission = true;
            Toast.makeText(activity, "請允許 K 安裝更新，回到 K 後會再問一次", Toast.LENGTH_LONG).show();
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
            return;
        }
        step = Step.DOWNLOADING;
        Toast.makeText(activity, "正在下載新版 K App…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            String failure = null;
            PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
            int sessionId = -1;
            try {
                HttpURLConnection connection =
                        Shell.open("/api/android/shell.apk?versionCode=" + info.optLong("versionCode"));
                connection.setReadTimeout(30000);
                if (connection.getResponseCode() != 200) throw new Exception("電腦回覆 " + connection.getResponseCode());
                sessionId = installer.createSession(
                        new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL));
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                    try (InputStream in = connection.getInputStream();
                         OutputStream out = session.openWrite("k.apk", 0, info.optLong("size", -1))) {
                        byte[] buffer = new byte[65536];
                        int n;
                        while ((n = in.read(buffer)) > 0) {
                            digest.update(buffer, 0, n);
                            out.write(buffer, 0, n);
                        }
                        session.fsync(out);
                    }
                    if (!hex(digest.digest()).equalsIgnoreCase(info.optString("sha256")))
                        throw new Exception("下載的檔案不完整");
                    Intent status = new Intent(activity, InstallStatusActivity.class);
                    session.commit(PendingIntent.getActivity(activity, 2, status,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE).getIntentSender());
                    sessionId = -1;
                }
            } catch (Exception e) {
                failure = e.getMessage();
                if (sessionId >= 0) {
                    try {
                        installer.abandonSession(sessionId);
                    } catch (Exception ignored) {
                    }
                }
            }
            String message = failure == null ? null : "更新沒有完成：" + failure;
            activity.runOnUiThread(() -> {
                step = Step.IDLE;
                if (message != null) Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
            });
        }, "k-shell-download").start();
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder();
        for (byte b : bytes) text.append(String.format("%02x", b));
        return text.toString();
    }
}
