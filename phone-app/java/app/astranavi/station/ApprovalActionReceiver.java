package app.astranavi.station;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/**
 * Handles inline Approve / Decline notification actions over certificate-pinned LAN TLS
 * via POST /approve, then clears the notification without launching a full WebView session.
 */
public final class ApprovalActionReceiver extends BroadcastReceiver {
    static final String ACTION_RESPOND = "app.astranavi.station.APPROVAL_RESPOND";
    static final String EXTRA_APPROVAL_ID = "approval_id";
    static final String EXTRA_ALLOW = "allow";
    static final String EXTRA_NOTIFY_ID = "notify_id";
    private static final Pattern APPROVAL_ID = Pattern.compile("^[A-Za-z0-9_-]{16,40}$");

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_RESPOND.equals(intent.getAction())) return;
        final String approvalId = intent.getStringExtra(EXTRA_APPROVAL_ID);
        if (approvalId == null || !APPROVAL_ID.matcher(approvalId).matches()) return;
        if (!intent.hasExtra(EXTRA_ALLOW)) return;
        final boolean allow = intent.getBooleanExtra(EXTRA_ALLOW, false);
        final int notifyId = intent.getIntExtra(EXTRA_NOTIFY_ID, 0);

        final NotificationManager nm = context.getSystemService(NotificationManager.class);
        final SharedPreferences prefs =
                context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        final String address = prefs.getString(MainActivity.KEY_ADDRESS, null);
        final String fingerprint = prefs.getString(MainActivity.KEY_FINGERPRINT, null);
        final String token = prefs.getString(MainActivity.KEY_ALERT_TOKEN, null);
        final String sessionToken = prefs.getString(MainActivity.KEY_SESSION_TOKEN, null);
        if (address == null || fingerprint == null || token == null || token.isEmpty()) {
            return;
        }

        final PendingResult pending = goAsync();
        Thread worker =
                new Thread(
                        () -> {
                            HttpsURLConnection conn = null;
                            try {
                                conn = PinnedTls.openPinned(address, fingerprint, "/approve");
                                conn.setRequestMethod("POST");
                                conn.setDoOutput(true);
                                conn.setRequestProperty("Authorization", "Bearer " + token);
                                if (sessionToken != null
                                        && sessionToken.matches("^[A-Za-z0-9_-]{40,50}$")) {
                                    conn.setRequestProperty("X-Session", sessionToken);
                                }
                                conn.setRequestProperty("Content-Type", "application/json");
                                byte[] payload =
                                        new JSONObject()
                                                .put("id", approvalId)
                                                .put("allow", allow)
                                                .toString()
                                                .getBytes(StandardCharsets.UTF_8);
                                conn.setFixedLengthStreamingMode(payload.length);
                                try (OutputStream out = conn.getOutputStream()) {
                                    out.write(payload);
                                }
                                int status = conn.getResponseCode();
                                if (status >= 200 && status < 300) {
                                    if (nm != null && notifyId != 0) {
                                        nm.cancel(notifyId);
                                    }
                                } else if (status == 401) {
                                    prefs.edit().remove(MainActivity.KEY_SESSION_TOKEN).apply();
                                    Intent authIntent =
                                            new Intent(context, MainActivity.class)
                                                    .addFlags(
                                                            Intent.FLAG_ACTIVITY_NEW_TASK
                                                                    | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                                                    .putExtra(EXTRA_APPROVAL_ID, approvalId)
                                                    .putExtra(EXTRA_ALLOW, allow);
                                    context.startActivity(authIntent);
                                }
                            } catch (Exception ignored) {
                                // Best-effort when away from LAN; mission remains safely paused.
                            } finally {
                                if (conn != null) conn.disconnect();
                                pending.finish();
                            }
                        },
                        "astra-approval-action");
        worker.start();
    }
}
