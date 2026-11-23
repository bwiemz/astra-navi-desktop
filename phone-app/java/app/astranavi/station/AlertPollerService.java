package app.astranavi.station;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Periodically polls the paired desktop's GET /alerts endpoint over pinned TLS so
 * triggered standing orders notify the user's phone without exposing PC chat or screen data.
 *
 * Uses Android's JobScheduler (JobService) rather than a foreground service, avoiding
 * Android 15+ foreground-service (dataSync/shortService) timeout restrictions while enforcing
 * strict per-poll HTTP timeouts and immediate socket teardown in onStopJob().
 */
public final class AlertPollerService extends JobService {
    private static final int JOB_ID = 47821;
    private static final int JOB_ID_NOW = 47822;
    private static final String CHANNEL_ID = "standing_orders";
    private static final long POLL_INTERVAL_MS = 15L * 60L * 1000L;
    private static final int CONNECT_TIMEOUT_MS = 5_000;
    private static final int READ_TIMEOUT_MS = 8_000;

    private volatile Thread worker;
    private volatile HttpsURLConnection activeConnection;

    static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        JobInfo job =
                new JobInfo.Builder(JOB_ID, new ComponentName(context, AlertPollerService.class))
                        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                        .setPeriodic(POLL_INTERVAL_MS)
                        .setPersisted(false)
                        .build();
        scheduler.schedule(job);
    }

    static void pollNow(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        JobInfo job =
                new JobInfo.Builder(JOB_ID_NOW, new ComponentName(context, AlertPollerService.class))
                        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                        .setMinimumLatency(500L)
                        .setOverrideDeadline(10_000L)
                        .setBackoffCriteria(30_000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                        .setPersisted(false)
                        .build();
        scheduler.schedule(job);
    }

    static void cancel(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        scheduler.cancel(JOB_ID);
        scheduler.cancel(JOB_ID_NOW);
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
        if (!prefs.getBoolean(MainActivity.KEY_ALERT_ENABLED, false)) {
            return false;
        }
        final String address = prefs.getString(MainActivity.KEY_ADDRESS, null);
        final String fingerprint = prefs.getString(MainActivity.KEY_FINGERPRINT, null);
        final String token = prefs.getString(MainActivity.KEY_ALERT_TOKEN, null);
        if (address == null || fingerprint == null || token == null || token.isEmpty()) {
            return false;
        }

        Thread t =
                new Thread(
                        () -> {
                            try {
                                fetchAndNotify(prefs, address, fingerprint, token);
                            } finally {
                                worker = null;
                                jobFinished(params, false);
                            }
                        },
                        "astranavi-alert-poll");
        worker = t;
        t.setDaemon(true);
        t.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Thread t = worker;
        worker = null;
        if (t != null) t.interrupt();
        final HttpsURLConnection conn = activeConnection;
        activeConnection = null;
        if (conn != null) {
            Thread closer = new Thread(conn::disconnect, "astranavi-alert-close");
            closer.setDaemon(true);
            closer.start();
        }
        return false;
    }

    private void fetchAndNotify(
            SharedPreferences prefs, String address, String fingerprint, String token) {
        String since = prefs.getString(MainActivity.KEY_LAST_ALERT_ID, null);
        String path = since != null && !since.isEmpty() ? "/alerts?since=" + Uri.encode(since) : "/alerts";
        HttpsURLConnection conn = null;
        try {
            if (Thread.currentThread().isInterrupted()) return;
            conn = PinnedTls.openPinned(address, fingerprint, path);
            activeConnection = conn;
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            int status = conn.getResponseCode();
            if (status == 401) {
                // Unpaired on the PC: stop polling and drop token cleanly.
                prefs.edit()
                        .remove(MainActivity.KEY_ALERT_ENABLED)
                        .remove(MainActivity.KEY_ALERT_TOKEN)
                        .remove(MainActivity.KEY_LAST_ALERT_ID)
                        .apply();
                cancel(this);
                return;
            }
            if (status != 200) return;

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader =
                    new BufferedReader(
                            new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                char[] buf = new char[2048];
                int read;
                while (!Thread.currentThread().isInterrupted()
                        && (read = reader.read(buf)) != -1
                        && body.length() < 128_000) {
                    body.append(buf, 0, read);
                }
            }
            if (Thread.currentThread().isInterrupted()) return;
            JSONObject json = new JSONObject(body.toString());
            JSONArray alerts = json.optJSONArray("alerts");
            if (alerts == null || alerts.length() == 0) return;

            boolean seeded = since != null && !since.isEmpty();
            String newestId = since;
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) ensureChannel(nm);

            for (int i = 0; i < alerts.length(); i++) {
                JSONObject entry = alerts.optJSONObject(i);
                if (entry == null) continue;
                String id = entry.optString("id", "");
                if (!id.isEmpty()) newestId = id;
                if (!seeded && i < alerts.length() - 1) {
                    // First baseline sync: only show the most recent existing alert, not a storm.
                    continue;
                }
                if (nm != null && canPostNotifications()) {
                    String title = entry.optString("title", "").trim();
                    if (title.isEmpty()) title = getString(R.string.alerts_fallback_title);
                    String text = entry.optString("body", "").trim();
                    Intent open = new Intent(this, MainActivity.class);
                    PendingIntent pi =
                            PendingIntent.getActivity(
                                    this,
                                    0,
                                    open,
                                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    Notification note =
                            new Notification.Builder(this, CHANNEL_ID)
                                    .setSmallIcon(R.mipmap.ic_launcher)
                                    .setContentTitle(title)
                                    .setContentText(text)
                                    .setStyle(new Notification.BigTextStyle().bigText(text))
                                    .setContentIntent(pi)
                                    .setAutoCancel(true)
                                    .build();
                    nm.notify((id.hashCode() & 0x7fffffff) + 1000, note);
                }
            }
            if (newestId != null && !newestId.isEmpty()) {
                prefs.edit().putString(MainActivity.KEY_LAST_ALERT_ID, newestId).apply();
            }
        } catch (Exception ignored) {
            // Away from LAN/VPN, PC asleep, or job interrupted: wait cleanly until next run.
        } finally {
            activeConnection = null;
            if (conn != null) conn.disconnect();
        }
    }

    private void ensureChannel(NotificationManager nm) {
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel =
                new NotificationChannel(
                        CHANNEL_ID,
                        getString(R.string.alerts_channel_name),
                        NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(getString(R.string.alerts_channel_desc));
        nm.createNotificationChannel(channel);
    }

    private boolean canPostNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }
}
