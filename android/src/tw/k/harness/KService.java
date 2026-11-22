package tw.k.harness;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Keeps one small connection to the PC's K while switched on, and shows its state
 * in an ongoing notification: unread finished rooms (with a red number) and how
 * many rooms are working. Each unread room also gets its own notification, so the
 * launcher icon shows the same count the desktop taskbar does.
 * Switched off only with the notification's 結束 button (swiping it away puts it
 * straight back, since Android 14+ lets ongoing notifications be swiped); opening K
 * switches it on.
 */
public class KService extends Service {
    static final String ACTION_STOP = "tw.k.harness.STOP";
    private static final String ACTION_REPOST = "tw.k.harness.REPOST";
    static final String EXTRA_THREAD = "threadId";

    private static final String CHANNEL_STATUS = "status";
    private static final String CHANNEL_DONE = "done";
    private static final int STATUS_ID = 1;
    private static final int DONE_ID = 2;

    private enum Link { CONNECTING, CONNECTED, OFFLINE, LOGIN, OUTDATED }

    private static volatile KService instance;

    private final Object lock = new Object();
    // Posting and clearing notifications happen under this lock, so 結束 cannot be
    // followed by a late notification from the connection thread.
    private final Object postLock = new Object();
    private boolean wakeRequested; // guarded by lock
    private volatile boolean running;
    private volatile HttpURLConnection current;
    private volatile Thread worker;
    private NotificationManager notifications;
    private ConnectivityManager.NetworkCallback networkCallback;

    // Written by the worker thread; read when (re)building the ongoing notification.
    private volatile Link link = Link.CONNECTING;
    private volatile JSONArray unread = new JSONArray();
    private volatile int working;
    private final Map<String, Integer> shown = new HashMap<>();
    private boolean cleanedLeftovers;

    /** Switches the notification on (or wakes a waiting retry); called when K comes to the front. */
    static void start(Context context) {
        try {
            context.startForegroundService(new Intent(context, KService.class));
        } catch (RuntimeException notAllowedInBackground) {
            // Opening K again switches it on.
        }
    }

    /** Reconnects now if switched on (e.g. right after logging in); never switches it on. */
    static void wakeIfRunning() {
        KService service = instance;
        if (service != null) service.wake();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notifications = getSystemService(NotificationManager.class);
        NotificationChannel status =
                new NotificationChannel(CHANNEL_STATUS, "K 連線狀態", NotificationManager.IMPORTANCE_LOW);
        status.setDescription("K 開著時常駐，顯示完成數量與工作中的聊天室");
        status.setShowBadge(false);
        NotificationChannel done =
                new NotificationChannel(CHANNEL_DONE, "工作完成", NotificationManager.IMPORTANCE_DEFAULT);
        done.setDescription("聊天室工作完成或需要你看一下");
        done.setShowBadge(true);
        notifications.createNotificationChannel(status);
        notifications.createNotificationChannel(done);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            shutDown();
            return START_NOT_STICKY;
        }
        if (ACTION_REPOST.equals(action)) {
            synchronized (postLock) {
                if (running) notifications.notify(STATUS_ID, statusNotification());
            }
            if (!running) stopSelf();
            return running ? START_STICKY : START_NOT_STICKY;
        }
        try {
            if (Build.VERSION.SDK_INT >= 34)
                startForeground(STATUS_ID, statusNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(STATUS_ID, statusNotification());
        } catch (RuntimeException notAllowed) {
            // Android refused a background start (e.g. battery restrictions); K stays off until opened.
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            instance = this;
            watchNetwork();
            worker = new Thread(this::loop, "k-attention");
            worker.start();
        } else wake();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        instance = null;
        disconnect();
        if (networkCallback != null) {
            try {
                getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {
            }
            networkCallback = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void shutDown() {
        instance = null;
        synchronized (postLock) {
            running = false;
            notifications.cancel(STATUS_ID);
            for (StatusBarNotification n : notifications.getActiveNotifications())
                if (n.getId() == DONE_ID) notifications.cancel(n.getTag(), DONE_ID);
        }
        disconnect();
        wake();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void disconnect() {
        HttpURLConnection connection = current;
        if (connection != null) connection.disconnect();
    }

    private void wake() {
        synchronized (lock) {
            wakeRequested = true; // kept if the loop is not waiting yet
            lock.notifyAll();
        }
    }

    private void watchNetwork() {
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                wake();
            }
        };
        try {
            getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException ignored) {
            networkCallback = null;
        }
    }

    // ---- connection -------------------------------------------------------------

    /** False for a connection thread left over from before 結束, even after K is switched on again. */
    private boolean isActiveWorker() {
        return running && worker == Thread.currentThread();
    }

    private void loop() {
        long delay = 2000;
        while (isActiveWorker()) {
            Link result = connectOnce();
            if (!isActiveWorker()) break;
            if (result == Link.CONNECTED) delay = 2000; // the stream ran and then ended
            setLink(result == Link.CONNECTED ? Link.OFFLINE : result);
            long wait = result == Link.LOGIN || result == Link.OUTDATED ? 5 * 60_000 : delay;
            synchronized (lock) {
                try {
                    if (isActiveWorker() && !wakeRequested) lock.wait(wait);
                } catch (InterruptedException e) {
                    return;
                }
                wakeRequested = false;
            }
            delay = Math.min(delay * 2, 60_000);
        }
    }

    /** Returns CONNECTED if the stream was open at some point, otherwise why it failed. */
    private Link connectOnce() {
        HttpURLConnection connection = null;
        boolean opened = false;
        try {
            connection = Shell.open("/api/attention/events");
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setReadTimeout(65_000); // the PC sends a heartbeat every 20 s
            current = connection;
            if (!isActiveWorker()) return Link.OFFLINE;
            int code = connection.getResponseCode();
            if (code != 200) {
                String body = Shell.readAll(connection.getErrorStream());
                if (body.contains("K_REMOTE_AUTH_REQUIRED") || body.contains("Remote access denied")) return Link.LOGIN;
                return code == 403 || code == 404 ? Link.OUTDATED : Link.OFFLINE;
            }
            opened = true;
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder data = new StringBuilder();
            boolean first = true;
            String line;
            while (isActiveWorker() && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) {
                        update(new JSONObject(data.toString()), first);
                        first = false;
                        data.setLength(0);
                    }
                } else if (line.startsWith("data:")) data.append(line.substring(5).trim());
            }
        } catch (Exception e) {
            // Network gone, PC asleep, K restarting: the loop retries.
        } finally {
            current = null;
            if (connection != null) connection.disconnect();
        }
        return opened ? Link.CONNECTED : Link.OFFLINE;
    }

    // ---- notifications ----------------------------------------------------------

    /** The first frame of each connection only shows what is already unread, without a sound. */
    private void update(JSONObject summary, boolean first) {
        synchronized (postLock) {
            if (isActiveWorker()) post(summary, first);
        }
    }

    private void post(JSONObject summary, boolean first) {
        JSONArray items = summary.optJSONArray("unread");
        unread = items == null ? new JSONArray() : items;
        working = summary.optInt("working", 0);
        link = Link.CONNECTED;
        notifications.notify(STATUS_ID, statusNotification());

        Set<String> present = new HashSet<>();
        for (int i = 0; i < unread.length(); i++) {
            JSONObject item = unread.optJSONObject(i);
            if (item == null) continue;
            String id = item.optString("threadId");
            int sequence = item.optInt("sequence");
            present.add(id);
            Integer before = shown.get(id);
            if (before != null && before == sequence) continue;
            shown.put(id, sequence);
            notifications.notify(id, DONE_ID, doneNotification(item, !first));
        }
        for (String id : new HashSet<>(shown.keySet()))
            if (!present.contains(id)) {
                shown.remove(id);
                notifications.cancel(id, DONE_ID);
            }
        // Notifications left from before this process (e.g. after an app update) and already read.
        if (!cleanedLeftovers) {
            cleanedLeftovers = true;
            for (StatusBarNotification n : notifications.getActiveNotifications())
                if (n.getId() == DONE_ID && !present.contains(n.getTag())) notifications.cancel(n.getTag(), DONE_ID);
        }
    }

    private void setLink(Link next) {
        synchronized (postLock) {
            if (link == next || !isActiveWorker()) return;
            link = next;
            notifications.notify(STATUS_ID, statusNotification());
        }
    }

    private Notification statusNotification() {
        String title, text;
        int count = link == Link.CONNECTED ? unread.length() : 0;
        StringBuilder names = new StringBuilder();
        switch (link) {
            case CONNECTED:
                title = count > 0 ? count + " 個工作完成" : "K 已連線";
                text = working > 0 ? working + " 個聊天室工作中" : "沒有工作在執行";
                for (int i = 0; i < count; i++) {
                    JSONObject item = unread.optJSONObject(i);
                    if (item == null) continue;
                    names.append("attention".equals(item.optString("kind")) ? "⚠ " : "✓ ")
                            .append(item.optString("title"))
                            .append('\n');
                }
                if (names.length() > 0) names.append(text);
                break;
            case LOGIN:
                title = "K 需要重新登入";
                text = "點這裡打開 K 登入";
                break;
            case OUTDATED:
                title = "電腦上的 K 還不支援通知";
                text = "電腦的 K 更新後就會自動連上";
                break;
            case OFFLINE:
                title = "K 未連線";
                text = "確認 Tailscale 與電腦的 K 開著；會自動重試";
                break;
            default:
                title = "K 連線中…";
                text = "";
        }
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_STATUS)
                .setSmallIcon(R.drawable.ic_stat_k)
                .setColor(0xFF2B241D)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setContentIntent(openK(null))
                .setDeleteIntent(PendingIntent.getService(this, 2,
                        new Intent(this, KService.class).setAction(ACTION_REPOST),
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .addAction(new Notification.Action.Builder(null, "結束",
                        PendingIntent.getService(this, 1,
                                new Intent(this, KService.class).setAction(ACTION_STOP),
                                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build());
        if (count > 0) builder.setLargeIcon(countBadge(count));
        if (names.length() > 0) builder.setStyle(new Notification.BigTextStyle().bigText(names.toString().trim()));
        return builder.build();
    }

    private Notification doneNotification(JSONObject item, boolean alert) {
        String id = item.optString("threadId");
        boolean attention = "attention".equals(item.optString("kind"));
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_DONE)
                .setSmallIcon(R.drawable.ic_stat_k)
                .setColor(0xFF2B241D)
                .setContentTitle(item.optString("title"))
                .setContentText(attention ? "需要你看一下" : "工作完成")
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_STATUS)
                .setContentIntent(openK(id));
        // Silent without a separate channel: a group child that only lets its (absent) summary alert.
        if (!alert) builder.setGroup("silent:" + id).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY);
        return builder.build();
    }

    private PendingIntent openK(String threadId) {
        Intent intent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (threadId != null) {
            // The room in the data keeps each room's notification a distinct PendingIntent.
            intent.setData(new Uri.Builder().scheme("k-room").opaquePart(threadId).build());
            intent.putExtra(EXTRA_THREAD, threadId);
        }
        return PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The same red count the desktop taskbar shows. */
    private Bitmap countBadge(int count) {
        int size = (int) (64 * getResources().getDisplayMetrics().density);
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.rgb(220, 55, 45));
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint);
        paint.setColor(Color.WHITE);
        paint.setTypeface(Typeface.DEFAULT_BOLD);
        String label = count > 99 ? "99+" : String.valueOf(count);
        paint.setTextSize(size * (label.length() > 2 ? 0.36f : label.length() > 1 ? 0.46f : 0.56f));
        paint.setTextAlign(Paint.Align.CENTER);
        Paint.FontMetrics metrics = paint.getFontMetrics();
        canvas.drawText(label, size / 2f, size / 2f - (metrics.ascent + metrics.descent) / 2f, paint);
        return bitmap;
    }
}
