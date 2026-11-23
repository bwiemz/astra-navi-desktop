package app.astranavi.station;

import android.Manifest;
import android.animation.Animator;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.animation.StateListAnimator;
import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.StateListDrawable;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.UnrecoverableKeyException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The whole app: a window onto the page Astra Navi's desktop app serves on the home network.
 *
 * It does two things a browser does not. It remembers where she is, so there is no
 * address to type each time. And it trusts exactly one certificate, hers, recognised by
 * its fingerprint: the page opens without a warning when the PC that answers is the one
 * that was paired, and does not open at all when it is not.
 *
 * Nothing is kept here but her address, that fingerprint, what the page itself stores
 * (the pairing token) and, when the user has switched that on, a key that signs this
 * phone in to her, sealed behind the phone's own fingerprint or face check. The name and
 * password are never kept. The app asks for the network and for that check, nothing else.
 *
 * Whenever the app leaves the screen her page is told to sign out, so that whoever opens
 * the app next is asked again; and the app's window is kept out of screenshots and the
 * list of recent apps.
 */
public final class MainActivity extends Activity {
    static final String PREFS = "station";
    static final String KEY_ADDRESS = "address";
    static final String KEY_FINGERPRINT = "fingerprint";
    static final String KEY_ALERT_ENABLED = "alert_enabled";
    static final String KEY_ALERT_TOKEN = "alert_token";
    static final String KEY_LAST_ALERT_ID = "last_alert_id";
    private static final String KEY_OUTBOX = "native_outbox";
    private static final Pattern DEVICE_TOKEN = Pattern.compile("^[A-Za-z0-9_-]{20,100}$");
    private static final int MAX_OUTBOX = 20;
    private static final int VOICE_RATE = 16000;
    private static final int MAX_VOICE_PCM_BYTES = 1_920_000;
    private static final int REQ_RECORD_AUDIO = 101;
    private static final int REQ_POST_NOTIFICATIONS = 102;

    /** An address on a home network with its port: 192.168.1.20:47821. */
    private static final Pattern ADDRESS =
            Pattern.compile("^(?:\\d{1,3}\\.){3}\\d{1,3}:\\d{2,5}$");
    /** A SHA-256 fingerprint as 64 hex digits. */
    private static final Pattern FINGERPRINT = Pattern.compile("^[0-9A-F]{64}$");
    /** The one-time code that carries a pairing over from the browser. */
    private static final Pattern CODE = Pattern.compile("^[A-Za-z0-9_-]{6,64}$");

    /** Where the key that seals the sign-in key lives: in the phone's own keystore, never in a file. */
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String SEAL_ALIAS = "station-unlock";
    /** The sign-in key as sealed, and what its sealing started from; both useless without the check. */
    private static final String KEY_SEALED = "unlock.sealed";
    private static final String KEY_SEAL_START = "unlock.start";
    /** The key her PC hands out for signing in by the phone's own check. */
    private static final Pattern UNLOCK_KEY = Pattern.compile("^[A-Za-z0-9_-]{40,50}$");

    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    /** A pairing code handed over by a link, used on the next load and then forgotten. */
    private String pendingCode;
    /** The question on screen, if any, so it can be taken down with the app. */
    private Dialog asking;
    /** The screen of this app's own that is up, if one is, so it can be drawn again. */
    private Runnable screen;
    /** Whether the phone was in its dark mode when the colours were last read. */
    private boolean night;
    /** The phone's fingerprint or face check, while it is up, so it can be taken down. */
    private CancellationSignal checking;
    /** Ends the check that is up as not passed, telling whoever asked for it; null when none is up. */
    private Runnable endChecking;
    /** The app has been off the screen since her page was last told it was in front. */
    private boolean wasAway;
    private final Object outboxLock = new Object();
    private AudioRecord voiceRecorder;
    private Thread voiceThread;
    private volatile boolean voiceActive;
    private ByteArrayOutputStream voicePcm;
    private WebView voiceTargetPage;
    private NsdManager nsdManager;
    private NsdManager.DiscoveryListener nsdDiscovery;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // Her words and the sign-in screen stay out of screenshots, screen recordings and
        // the picture of this app in the list of recent ones.
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        night = getResources().getBoolean(R.bool.night);
        root = new FrameLayout(this);
        configureWindowInsets();
        root.setBackgroundColor(getColor(R.color.page));
        setContentView(root);
        paintBars();
        if (!takeLink(getIntent())) render();
    }

    @SuppressWarnings("deprecation")
    private void configureWindowInsets() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((View v, WindowInsets windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                        WindowInsets.Type.systemBars()
                                | WindowInsets.Type.displayCutout()
                                | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            root.setFitsSystemWindows(true);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        takeLink(intent);
    }

    /**
     * The phone went into or out of its dark mode while the app was open. The app is not
     * started again for that (her page would lose its place), so what was coloured for
     * the old mode is coloured again here.
     */
    @Override
    public void onConfigurationChanged(Configuration now) {
        super.onConfigurationChanged(now);
        boolean dark = getResources().getBoolean(R.bool.night);
        if (dark == night) return;
        night = dark;
        paintBars();
        root.setBackgroundColor(getColor(R.color.page));
        if (web != null) web.setBackgroundColor(getColor(R.color.page));
        else if (screen != null && (asking == null || !asking.isShowing())) screen.run();
    }

    /**
     * Colours the phone's own two bars as the theme does when the app starts. These calls
     * are marked as on their way out from Android 15, for apps that target it and draw
     * behind the bars; this one targets Android 14, where they are still the way to do
     * it, and on Android 10 the older flag is the only way to darken the bottom bar's icons.
     */
    @SuppressWarnings("deprecation")
    private void paintBars() {
        Window window = getWindow();
        window.setStatusBarColor(getColor(R.color.top));
        window.setNavigationBarColor(getColor(R.color.card));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController bars = window.getInsetsController();
            if (bars != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                bars.setSystemBarsAppearance(night ? 0 : light, light);
            }
        } else {
            View decor = window.getDecorView();
            int flags = decor.getSystemUiVisibility();
            int light = View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(night ? flags & ~light : flags | light);
        }
    }

    /**
     * The app has left the screen. Her page is told to sign out, so that whoever opens the
     * app next has to be let in again. (The phone's own check does not count as leaving:
     * it is drawn over the app, which stays where it is.)
     */
    @Override
    protected void onStop() {
        stopNsdDiscovery();
        cancelVoiceNow();
        endCheck();
        wasAway = true;
        if (web != null) {
            web.evaluateJavascript("window.astraNaviLock && window.astraNaviLock()", null);
        }
        super.onStop();
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (wasAway && web != null) {
            web.evaluateJavascript("window.astraNaviShown && window.astraNaviShown()", null);
        }
        wasAway = false;
    }

    @Override
    protected void onDestroy() {
        stopNsdDiscovery();
        cancelVoiceNow();
        endCheck();
        if (asking != null) asking.dismiss();
        asking = null;
        dropWeb();
        super.onDestroy();
    }

    /** True while the app is still there to be drawn on. */
    private boolean alive() {
        return !isFinishing() && !isDestroyed();
    }

    /**
     * True for an address on a home network (or a private mesh), with real numbers in
     * it. She is only ever served from such an address, so nothing else is accepted,
     * typed or linked.
     */
    static boolean isHomeAddress(String at) {
        if (at == null || !ADDRESS.matcher(at).matches()) return false;
        String[] halves = at.split(":");
        String[] parts = halves[0].split("\\.");
        int[] n = new int[4];
        try {
            for (int index = 0; index < 4; index++) {
                n[index] = Integer.parseInt(parts[index]);
                if (n[index] > 255) return false;
            }
            int port = Integer.parseInt(halves[1]);
            if (port < 1 || port > 65535) return false;
        } catch (NumberFormatException problem) {
            return false;
        }
        return n[0] == 10
                || (n[0] == 172 && n[1] >= 16 && n[1] <= 31)
                || (n[0] == 192 && n[1] == 168)
                || (n[0] == 169 && n[1] == 254)
                || (n[0] == 100 && n[1] >= 64 && n[1] <= 127);
    }

    private String address() {
        return prefs.getString(KEY_ADDRESS, null);
    }

    private void render() {
        if (address() == null) showSetup();
        else showStation();
    }

    // ---------------------------------------------------------------- the link from her page

    /**
     * Handles astranavi://station?at=…&fp=…&code=…, the link her page offers once a browser
     * is paired. Returns true when the link was taken (or is being asked about), so the
     * caller does not also draw the ordinary screen.
     */
    private boolean takeLink(Intent intent) {
        Uri link = intent == null ? null : intent.getData();
        String scheme = link == null ? null : link.getScheme();
        if (link == null
                || (!"astranavi".equals(scheme) && !"aichan".equals(scheme))
                || !"station".equals(link.getHost())) {
            return false;
        }
        // The link has been read; it must not be acted on again if the screen is rebuilt.
        intent.setData(null);
        final String at = link.getQueryParameter("at");
        final String print = upper(link.getQueryParameter("fp"));
        final String code = link.getQueryParameter("code");
        if (!isHomeAddress(at) || print == null || !FINGERPRINT.matcher(print).matches()) {
            return false;
        }
        final String carried = code != null && CODE.matcher(code).matches() ? code : null;
        if (at.equals(address()) && print.equals(prefs.getString(KEY_FINGERPRINT, null))) {
            // The PC this app already knows: nothing to decide.
            adopt(at, print, carried);
            return true;
        }
        // Any page or app on the phone can fire such a link. This app is only ever pointed
        // at a PC, the first time or any other, with a yes from whoever is holding it.
        ask(R.string.link_before, R.string.link_after, at, print, () -> {
            WebStorage.getInstance().deleteAllData();
            adopt(at, print, carried);
        }, this::render);
        return true;
    }

    /**
     * Puts up the one question this app asks: is the PC at this address, with this
     * certificate, hers? Nothing but its two buttons answers it: not a tap beside it and
     * not the back button. Each button answers once.
     */
    private void ask(int before, int after, String at, String print, Runnable yes, Runnable no) {
        if (!alive()) return;
        if (asking != null) asking.dismiss();
        final Dialog question = new Dialog(this);
        question.requestWindowFeature(Window.FEATURE_NO_TITLE);
        question.setCancelable(false);
        question.setCanceledOnTouchOutside(false);

        LinearLayout panel = panel();
        panel.addView(words(getString(R.string.trust_title), 24f, true));
        panel.addView(words(getString(before, at), 16f, false));
        panel.addView(ending(print));
        panel.addView(words(getString(after), 16f, false));
        final boolean[] answered = {false};
        Button match = button(R.string.trust_yes, true);
        match.setOnClickListener((View view) -> {
            if (answered[0]) return;
            answered[0] = true;
            question.dismiss();
            yes.run();
        });
        panel.addView(match);
        Button cancel = button(R.string.trust_no, false);
        cancel.setOnClickListener((View view) -> {
            if (answered[0]) return;
            answered[0] = true;
            question.dismiss();
            no.run();
        });
        panel.addView(cancel);

        FrameLayout.LayoutParams place = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        place.setMargins(dp(18), dp(18), dp(18), dp(18));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(panel, place);
        question.setContentView(scroll);
        Window window = question.getWindow();
        if (window != null) {
            // The panel is the whole of the question; the phone's own dialog box is not drawn.
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        }
        asking = question;
        question.show();
        // Some phones size a dialog afresh as it is shown; said again so that it stays wide.
        if (window != null) {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        }
    }

    /** The end of a fingerprint, set apart in letters of one width so two can be compared. */
    private TextView ending(String print) {
        final TextView view = words(tail(print), 18f, true);
        view.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
        view.setTextColor(getColor(R.color.ink));
        view.setGravity(Gravity.CENTER_HORIZONTAL);
        view.setBackground(box(getColor(R.color.sun), 2.5f));
        view.setPadding(dp(8), dp(12), dp(8), dp(12));
        LinearLayout.LayoutParams place = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        place.setMargins(0, 0, 0, dp(14));
        view.setLayoutParams(place);
        // Its two rows have to stay two rows, on a narrow phone or with large letters:
        // once the width is known, the letters are made smaller until a row fits.
        view.addOnLayoutChangeListener((seen, l, t, r, b, ol, ot, or, ob) -> {
            float room = (r - l) - view.getPaddingLeft() - view.getPaddingRight();
            float widest = 0f;
            for (String row : view.getText().toString().split("\n")) {
                widest = Math.max(widest, view.getPaint().measureText(row));
            }
            if (room > 0f && widest > room) {
                view.setTextSize(TypedValue.COMPLEX_UNIT_PX, view.getTextSize() * room / widest * 0.98f);
            }
        });
        return view;
    }

    private void adopt(String at, String print, String code) {
        // A sign-in key was made for one PC. Pointed at another, or at another certificate,
        // the app must not hold it out: the new page could ask for it.
        if (!at.equals(address()) || !print.equals(prefs.getString(KEY_FINGERPRINT, null))) {
            forgetUnlock();
            AlertPollerService.cancel(this);
            synchronized (outboxLock) {
                prefs.edit()
                        .remove(KEY_ALERT_ENABLED)
                        .remove(KEY_ALERT_TOKEN)
                        .remove(KEY_LAST_ALERT_ID)
                        .remove(KEY_OUTBOX)
                        .apply();
            }
        }
        prefs.edit().putString(KEY_ADDRESS, at).putString(KEY_FINGERPRINT, print).apply();
        pendingCode = code;
        showStation();
    }

    // ---------------------------------------------------------------- her page

    private void showStation() {
        final String at = address();
        if (at == null) {
            showSetup();
            return;
        }
        stopNsdDiscovery();
        dropWeb();
        screen = null;
        final String origin = "https://" + at;
        web = new WebView(this);
        // A tap that comes through another app's window drawn over this one is thrown
        // away: such a window could show one thing and have "Allow" tapped beneath it.
        web.setFilterTouchesWhenObscured(true);
        // The phone remembers earlier answers about a certificate, yes and no alike, and
        // would not ask again. Every page load is to be judged afresh against the pin.
        web.clearSslPreferences();
        web.setBackgroundColor(getColor(R.color.page));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); // her page is a script; it is the only page ever loaded
        settings.setDomStorageEnabled(true); // where the page keeps its pairing token
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Tells her page it is inside the app, so it does not offer the app again.
        settings.setUserAgentString(settings.getUserAgentString() + " AstraNaviApp/1");
        // What her page may ask of the phone: to keep a sign-in key behind the phone's own
        // check, and to hand it back after that check. Offered only once her certificate
        // is pinned: before that, whatever answers at the address has not been agreed to
        // be her. Nothing but her page is ever opened in here (see below), and every
        // request is checked again against the page and its certificate when it is made.
        if (prefs.getString(KEY_FINGERPRINT, null) != null) {
            web.addJavascriptInterface(new Bridge(web, origin), "AstraNaviApp");
        }
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Nothing but her own page is ever opened in here.
                Uri to = request.getUrl();
                return !("https".equals(to.getScheme()) && at.equals(to.getAuthority()));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Her certificate is one she made herself, so the phone does not know it and
                // asks here. It is let through only if it is the one that was paired.
                String url = error.getUrl();
                String seen = fingerprintOf(error.getCertificate());
                String pinned = prefs.getString(KEY_FINGERPRINT, null);
                if (seen == null || url == null || !(url.equals(origin) || url.startsWith(origin + "/"))) {
                    handler.cancel();
                    return;
                }
                // The screen is changed a moment later, not from inside this call: the
                // page view must not be taken apart while it is still talking to us.
                if (pinned == null) {
                    handler.cancel();
                    root.post(() -> {
                        if (alive() && view == web) askWhetherItIsHer(at, seen);
                    });
                } else if (pinned.equals(seen)) {
                    handler.proceed();
                } else {
                    handler.cancel();
                    root.post(() -> notHer(view, at));
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // A certificate the phone already trusts never comes past the question
                // above. So what the page was actually served with is checked here too:
                // anything but her certificate, and the page is taken away again.
                String served = fingerprintOf(view.getCertificate());
                String pinned = prefs.getString(KEY_FINGERPRINT, null);
                if (view != web || served == null) return;
                if (pinned == null) {
                    root.post(() -> {
                        if (alive() && view == web) askWhetherItIsHer(at, served);
                    });
                } else if (!pinned.equals(served)) {
                    root.post(() -> notHer(view, at));
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The part of the phone that draws pages died (out of memory, usually).
                // Left alone that would take the whole app with it.
                root.post(() -> {
                    if (alive() && view == web) {
                        showProblem(R.string.unreachable_title, R.string.unreachable_words, at, true);
                    }
                });
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // A certificate that was refused above also lands here; that case has
                // already put its own screen up and taken the page away.
                if (!request.isForMainFrame()) return;
                root.post(() -> {
                    if (alive() && view == web) {
                        showProblem(R.string.unreachable_title, R.string.unreachable_words, at, true);
                    }
                });
            }
        });
        root.removeAllViews();
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        String code = pendingCode;
        pendingCode = null;
        web.loadUrl(origin + "/" + (code == null ? "" : "#pair=" + code));
    }

    // ---------------------------------------------------------------- the phone's own check

    /**
     * What her page may ask of the app. The page calls these off the main thread; whatever
     * does something is handed to the main thread and checked there first.
     */
    private final class Bridge {
        private final WebView page;
        private final String origin;

        Bridge(WebView page, String origin) {
            this.page = page;
            this.origin = origin;
        }

        /** True when this phone has a fingerprint or face enrolled that is strong enough to guard a key. */
        @JavascriptInterface
        public boolean canUnlock() {
            return hasStrongCheck();
        }

        /** True when a sign-in key is kept on this phone. */
        @JavascriptInterface
        public boolean hasKey() {
            return prefs.contains(KEY_SEALED) && prefs.contains(KEY_SEAL_START);
        }

        /** Seals a sign-in key behind the phone's check. The page is told how it went. */
        @JavascriptInterface
        public void keepKey(final String key) {
            root.post(() -> {
                if (herPage(page, origin)) keepKeyNow(page, key);
            });
        }

        /** Puts the phone's check up and, when it is passed, hands the key to the page. */
        @JavascriptInterface
        public void unlock() {
            root.post(() -> {
                if (herPage(page, origin)) unlockNow(page, origin);
            });
        }

        @JavascriptInterface
        public void forgetKey() {
            root.post(() -> {
                if (herPage(page, origin)) forgetUnlock();
            });
        }

        /** Hands queued offline drafts to the web page once back in LAN/VPN range and clears the native box. */
        @JavascriptInterface
        public String takeNativeOutbox() {
            synchronized (outboxLock) {
                if (prefs.getString(KEY_FINGERPRINT, null) == null) return "[]";
                String raw = prefs.getString(KEY_OUTBOX, null);
                prefs.edit().remove(KEY_OUTBOX).apply();
                return raw != null && raw.startsWith("[") ? raw : "[]";
            }
        }

        @JavascriptInterface
        public boolean canPollAlerts() {
            return true;
        }

        @JavascriptInterface
        public boolean isAlertPollingOn() {
            return prefs.getBoolean(KEY_ALERT_ENABLED, false);
        }

        @JavascriptInterface
        public void setAlertPolling(final boolean on, final String token) {
            root.post(() -> {
                if (herPage(page, origin)) setAlertPollingNow(on, token);
            });
        }

        @JavascriptInterface
        public boolean canRecordVoice() {
            return true;
        }

        @JavascriptInterface
        public void startVoice() {
            root.post(() -> {
                if (herPage(page, origin)) startVoiceNow(page);
            });
        }

        @JavascriptInterface
        public void stopVoice() {
            root.post(() -> {
                if (herPage(page, origin)) stopVoiceNow(page);
            });
        }

        @JavascriptInterface
        public void cancelVoice() {
            root.post(() -> cancelVoiceNow());
        }
    }

    private void setAlertPollingNow(boolean on, String token) {
        if (!on || token == null || !DEVICE_TOKEN.matcher(token).matches()) {
            prefs.edit()
                    .remove(KEY_ALERT_ENABLED)
                    .remove(KEY_ALERT_TOKEN)
                    .remove(KEY_LAST_ALERT_ID)
                    .apply();
            AlertPollerService.cancel(this);
            return;
        }
        prefs.edit()
                .putBoolean(KEY_ALERT_ENABLED, true)
                .putString(KEY_ALERT_TOKEN, token)
                .apply();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS);
        }
        AlertPollerService.schedule(this);
        AlertPollerService.pollNow(this);
    }

    private void startVoiceNow(WebView page) {
        cancelVoiceNow();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            voiceTargetPage = page;
            requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
            tell(
                    page,
                    "window.astraNaviVoiceError && window.astraNaviVoiceError("
                            + JSONObject.quote("Allow microphone access, then hold again.")
                            + ")");
            return;
        }
        int minBuf =
                AudioRecord.getMinBufferSize(
                        VOICE_RATE,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT);
        int bufSize = Math.max(minBuf > 0 ? minBuf * 2 : 6400, 6400);
        try {
            AudioFormat format =
                    new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(VOICE_RATE)
                            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                            .build();
            AudioRecord recorder =
                    new AudioRecord.Builder()
                            .setAudioSource(MediaRecorder.AudioSource.MIC)
                            .setAudioFormat(format)
                            .setBufferSizeInBytes(bufSize)
                            .build();
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                recorder.release();
                tell(
                        page,
                        "window.astraNaviVoiceError && window.astraNaviVoiceError("
                                + JSONObject.quote("Microphone is not ready.")
                                + ")");
                return;
            }
            ByteArrayOutputStream pcm = new ByteArrayOutputStream(32_000);
            voiceRecorder = recorder;
            voicePcm = pcm;
            voiceTargetPage = page;
            voiceActive = true;
            recorder.startRecording();
            Thread t =
                    new Thread(
                            () -> {
                                byte[] chunk = new byte[2048];
                                while (voiceActive) {
                                    int n = recorder.read(chunk, 0, chunk.length);
                                    if (n > 0) {
                                        if (pcm.size() + n > MAX_VOICE_PCM_BYTES) break;
                                        pcm.write(chunk, 0, n);
                                    } else if (n < 0) {
                                        break;
                                    }
                                }
                            },
                            "astranavi-voice-rec");
            voiceThread = t;
            t.start();
        } catch (SecurityException | IllegalStateException | IllegalArgumentException e) {
            cancelVoiceNow();
            tell(
                    page,
                    "window.astraNaviVoiceError && window.astraNaviVoiceError("
                            + JSONObject.quote("Could not start microphone recording.")
                            + ")");
        }
    }

    private void stopVoiceNow(WebView page) {
        AudioRecord recorder = voiceRecorder;
        Thread t = voiceThread;
        ByteArrayOutputStream pcm = voicePcm;
        voiceActive = false;
        voiceRecorder = null;
        voiceThread = null;
        voicePcm = null;
        voiceTargetPage = null;
        if (recorder != null) {
            try {
                if (recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    recorder.stop();
                }
            } catch (IllegalStateException ignored) {
                // already stopped
            }
            recorder.release();
        }
        if (t != null) {
            try {
                t.join(500L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        if (pcm == null || pcm.size() < 1600) {
            tell(
                    page,
                    "window.astraNaviVoiceError && window.astraNaviVoiceError("
                            + JSONObject.quote("Hold a bit longer while speaking.")
                            + ")");
            return;
        }
        byte[] wav = wrapPcm16MonoWav(pcm.toByteArray());
        String b64 = Base64.encodeToString(wav, Base64.NO_WRAP);
        tell(page, "window.astraNaviVoiceReady && window.astraNaviVoiceReady(" + JSONObject.quote(b64) + ")");
    }

    private void cancelVoiceNow() {
        voiceActive = false;
        AudioRecord recorder = voiceRecorder;
        Thread t = voiceThread;
        voiceRecorder = null;
        voiceThread = null;
        voicePcm = null;
        voiceTargetPage = null;
        if (recorder != null) {
            try {
                if (recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    recorder.stop();
                }
            } catch (IllegalStateException ignored) {
                // ignore
            }
            recorder.release();
        }
        if (t != null) {
            t.interrupt();
        }
    }

    private static byte[] wrapPcm16MonoWav(byte[] pcm) {
        int dataLen = pcm.length;
        int totalLen = 36 + dataLen;
        byte[] out = new byte[44 + dataLen];
        out[0] = 'R';
        out[1] = 'I';
        out[2] = 'F';
        out[3] = 'F';
        writeLeInt(out, 4, totalLen);
        out[8] = 'W';
        out[9] = 'A';
        out[10] = 'V';
        out[11] = 'E';
        out[12] = 'f';
        out[13] = 'm';
        out[14] = 't';
        out[15] = ' ';
        writeLeInt(out, 16, 16);
        writeLeShort(out, 20, 1);
        writeLeShort(out, 22, 1);
        writeLeInt(out, 24, VOICE_RATE);
        writeLeInt(out, 28, VOICE_RATE * 2);
        writeLeShort(out, 32, 2);
        writeLeShort(out, 34, 16);
        out[36] = 'd';
        out[37] = 'a';
        out[38] = 't';
        out[39] = 'a';
        writeLeInt(out, 40, dataLen);
        System.arraycopy(pcm, 0, out, 44, dataLen);
        return out;
    }

    private static void writeLeInt(byte[] buf, int offset, int val) {
        buf[offset] = (byte) (val & 0xff);
        buf[offset + 1] = (byte) ((val >> 8) & 0xff);
        buf[offset + 2] = (byte) ((val >> 16) & 0xff);
        buf[offset + 3] = (byte) ((val >> 24) & 0xff);
    }

    private static void writeLeShort(byte[] buf, int offset, int val) {
        buf[offset] = (byte) (val & 0xff);
        buf[offset + 1] = (byte) ((val >> 8) & 0xff);
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_RECORD_AUDIO && voiceTargetPage != null) {
            boolean granted =
                    grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (!granted) {
                tell(
                        voiceTargetPage,
                        "window.astraNaviVoiceError && window.astraNaviVoiceError("
                                + JSONObject.quote("Microphone permission is needed to record voice notes.")
                                + ")");
            }
            voiceTargetPage = null;
        }
    }

    /**
     * True when the page asking is the one on screen, at her address, served with her
     * pinned certificate. Asked on the main thread each time something is to be done.
     */
    private boolean herPage(WebView page, String origin) {
        if (!alive() || page != web) return false;
        String at = page.getUrl();
        String pinned = prefs.getString(KEY_FINGERPRINT, null);
        return at != null
                && (at.equals(origin) || at.startsWith(origin + "/"))
                && pinned != null
                && pinned.equals(fingerprintOf(page.getCertificate()));
    }

    /** Says something to her page, if it is still the page on screen. */
    private void tell(WebView page, String script) {
        if (alive() && page == web) page.evaluateJavascript(script, null);
    }

    private boolean hasStrongCheck() {
        // The service that answers this came with Android 10.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false;
        BiometricManager manager = getSystemService(BiometricManager.class);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    == BiometricManager.BIOMETRIC_SUCCESS;
        }
        return hasAnyCheck(manager);
    }

    /** Android 10 can only say whether some check is enrolled; the keystore refuses a weak one later. */
    @SuppressWarnings("deprecation")
    private static boolean hasAnyCheck(BiometricManager manager) {
        return manager.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS;
    }

    /** Throws the kept key away, and the keystore key that sealed it. */
    private void forgetUnlock() {
        prefs.edit().remove(KEY_SEALED).remove(KEY_SEAL_START).apply();
        try {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            if (store.containsAlias(SEAL_ALIAS)) store.deleteEntry(SEAL_ALIAS);
        } catch (Exception problem) {
            // Without what was sealed, the keystore key opens nothing.
        }
    }

    /**
     * A new key in the phone's keystore that can be used only straight after a fingerprint
     * or face check, each time, and that stops working if a new fingerprint or face is
     * added to the phone. It never leaves the keystore.
     */
    private static SecretKey newSealKey() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(SEAL_ALIAS)) store.deleteEntry(SEAL_ALIAS);
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
                SEAL_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        }
        KeyGenerator maker = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        maker.init(spec.build());
        return maker.generateKey();
    }

    /** What is done with the cipher once the check has been passed. */
    private interface AfterCheck {
        void with(Cipher ready) throws Exception;
    }

    /**
     * Puts the phone's fingerprint or face check up for one use of this cipher. Exactly
     * one of the two endings is run, once, on the main thread.
     */
    private void check(Cipher cipher, int title, final AfterCheck passed, final Runnable not) {
        // A check still up is ended first, as not passed. Its own answer comes late, after
        // it was cancelled, and by then finds itself ended: it can neither clear this
        // check's signal nor tell the page that this one failed.
        endCheck();
        final boolean[] ended = {false};
        final CancellationSignal cancel = new CancellationSignal();
        final Runnable failed = () -> {
            if (ended[0]) return;
            ended[0] = true;
            if (checking == cancel) {
                checking = null;
                endChecking = null;
            }
            not.run();
        };
        BiometricPrompt.Builder prompt = new BiometricPrompt.Builder(this)
                .setTitle(getString(title))
                .setSubtitle(getString(R.string.check_sub))
                .setNegativeButton(getString(R.string.check_cancel), getMainExecutor(),
                        (dialog, which) -> failed.run());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            prompt.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        }
        checking = cancel;
        endChecking = failed;
        prompt.build().authenticate(new BiometricPrompt.CryptoObject(cipher), cancel,
                getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        if (ended[0]) return;
                        BiometricPrompt.CryptoObject used = result.getCryptoObject();
                        Cipher ready = used == null ? null : used.getCipher();
                        try {
                            if (ready == null) throw new IllegalStateException("no cipher");
                            passed.with(ready);
                            ended[0] = true;
                            if (checking == cancel) {
                                checking = null;
                                endChecking = null;
                            }
                        } catch (Exception problem) {
                            failed.run();
                        }
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence said) {
                        // Cancelled, timed out, too many tries, or no check to make.
                        failed.run();
                    }
                });
    }

    /**
     * Ends whatever check is up as not passed: its asker is told now, and its prompt is
     * taken down. The prompt's own late answer then does nothing.
     */
    private void endCheck() {
        Runnable end = endChecking;
        CancellationSignal signal = checking;
        endChecking = null;
        checking = null;
        if (end != null) end.run();
        if (signal != null) signal.cancel();
    }

    private void keepKeyNow(final WebView page, final String key) {
        // Before anything of this one is made: ending an older keeping throws its key away.
        endCheck();
        final Runnable not = () -> {
            forgetUnlock();
            tell(page, "window.astraNaviKeyKept && window.astraNaviKeyKept(false)");
        };
        if (key == null || !UNLOCK_KEY.matcher(key).matches() || !hasStrongCheck()) {
            not.run();
            return;
        }
        try {
            forgetUnlock();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, newSealKey());
            check(cipher, R.string.check_keep_title, (Cipher ready) -> {
                byte[] sealed = ready.doFinal(key.getBytes(StandardCharsets.UTF_8));
                prefs.edit()
                        .putString(KEY_SEALED, Base64.encodeToString(sealed, Base64.NO_WRAP))
                        .putString(KEY_SEAL_START, Base64.encodeToString(ready.getIV(), Base64.NO_WRAP))
                        .apply();
                tell(page, "window.astraNaviKeyKept && window.astraNaviKeyKept(true)");
            }, not);
        } catch (Exception problem) {
            // No strong check enrolled after all, or the keystore would not make the key.
            not.run();
        }
    }

    private void unlockNow(final WebView page, final String origin) {
        endCheck();
        final Runnable not = () -> tell(page, "window.astraNaviUnlockFailed && window.astraNaviUnlockFailed()");
        String sealed = prefs.getString(KEY_SEALED, null);
        String start = prefs.getString(KEY_SEAL_START, null);
        if (sealed == null || start == null) {
            not.run();
            return;
        }
        try {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            SecretKey seal = (SecretKey) store.getKey(SEAL_ALIAS, null);
            if (seal == null) throw new KeyPermanentlyInvalidatedException("gone");
            final byte[] bytes = Base64.decode(sealed, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, seal,
                    new GCMParameterSpec(128, Base64.decode(start, Base64.NO_WRAP)));
            check(cipher, R.string.check_title, (Cipher ready) -> {
                String key = new String(ready.doFinal(bytes), StandardCharsets.UTF_8);
                if (!UNLOCK_KEY.matcher(key).matches()) throw new IllegalStateException("not a key");
                // The check took a while: the page is judged again now, as it was when it
                // asked. Anything else on screen by this time is not handed the key.
                if (!herPage(page, origin)) throw new IllegalStateException("not her page");
                tell(page, "window.astraNaviUnlocked && window.astraNaviUnlocked(" + JSONObject.quote(key) + ")");
            }, not);
        } catch (InvalidKeyException | UnrecoverableKeyException gone) {
            // A fingerprint or face was added to the phone since (or the screen lock was
            // taken off): the key no longer opens, by design. Some phones say so with the
            // plain refusal and not the one made for it. Either way what is kept is dead:
            // it is thrown away, and the password is asked for.
            forgetUnlock();
            not.run();
        } catch (Exception problem) {
            not.run();
        }
    }

    /** Something other than her certificate answered: the page goes, and the user is told. */
    private void notHer(WebView view, String at) {
        if (alive() && view == web) {
            showProblem(R.string.mismatch_title, R.string.mismatch_words, at, false);
        }
    }

    private void dropWeb() {
        if (web == null) return;
        WebView old = web;
        web = null;
        old.stopLoading();
        if (root != null) root.removeView(old);
        old.destroy();
    }

    /** First contact set up by hand: nothing is pinned yet, so the person compares by eye. */
    private void askWhetherItIsHer(final String at, final String seen) {
        dropWeb();
        ask(R.string.trust_before, R.string.trust_after, at, seen, () -> {
            // A certificate trusted anew is a PC no kept key was made for.
            forgetUnlock();
            prefs.edit().putString(KEY_FINGERPRINT, seen).apply();
            showStation();
        }, this::startOver);
    }

    private void startOver() {
        cancelVoiceNow();
        dropWeb();
        forgetUnlock();
        AlertPollerService.cancel(this);
        synchronized (outboxLock) {
            prefs.edit().clear().apply();
        }
        WebStorage.getInstance().deleteAllData();
        showSetup();
    }

    // ---------------------------------------------------------------- the screens that are not her page
    //
    // Drawn the way her page is: paper panels on the page's colour, one colour for every
    // outline, hard shadows set off down and to the right, her name on a plate in the bar
    // at the top. All of it is made here; there is no layout file.

    private int dp(float value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    /** A flat box: a fill and, when a width is given, an outline in the colour of the text. */
    private GradientDrawable box(int fill, float outline) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        if (outline > 0f) shape.setStroke(dp(outline), getColor(R.color.text));
        return shape;
    }

    /** A box standing off the page: the same box with a hard shadow of the given colour. */
    private LayerDrawable raised(Drawable face, int shadow, int drop) {
        LayerDrawable layers = new LayerDrawable(new Drawable[] {box(shadow, 0f), face});
        layers.setLayerInset(0, drop, drop, 0, 0);
        layers.setLayerInset(1, 0, 0, drop, drop);
        return layers;
    }

    private TextView words(CharSequence text, float size, boolean bold) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        view.setTextColor(getColor(R.color.text));
        view.setLineSpacing(0f, bold ? 1.15f : 1.3f);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setPadding(0, 0, 0, dp(12));
        return view;
    }

    /** One numbered step: the number in its own column, so a second line of words lines up. */
    private LinearLayout step(int number, int text) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        TextView count = words(number + ".", 16f, true);
        count.setLineSpacing(0f, 1.3f);
        row.addView(count, new LinearLayout.LayoutParams(dp(26), ViewGroup.LayoutParams.WRAP_CONTENT));
        row.addView(words(getString(text), 16f, false), new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    /**
     * A button like the ones on her page: an outlined face with a hard shadow, which it
     * moves into while it is held down.
     */
    private Button button(int label, boolean main) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        // The pink is the same in the light and in the dark, so the words on it always are.
        view.setTextColor(getColor(main ? R.color.ink : R.color.text));
        int fill = getColor(main ? R.color.blush : R.color.card);
        int drop = dp(4);
        LayerDrawable held = new LayerDrawable(new Drawable[] {box(fill, 2.5f)});
        held.setLayerInset(0, 0, 0, drop, drop);
        StateListDrawable face = new StateListDrawable();
        face.addState(new int[] {android.R.attr.state_pressed}, held);
        face.addState(new int[] {}, raised(box(fill, 2.5f), getColor(R.color.text), drop));
        view.setBackground(face);
        view.setPadding(dp(18), dp(12), dp(18) + drop, dp(12) + drop);
        view.setMinHeight(dp(58));
        view.setMinimumHeight(dp(58));
        StateListAnimator press = new StateListAnimator();
        press.addState(new int[] {android.R.attr.state_pressed}, slide(view, drop - dp(1)));
        press.addState(new int[] {}, slide(view, 0f));
        view.setStateListAnimator(press);
        LinearLayout.LayoutParams place = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        place.setMargins(0, dp(6), 0, dp(6));
        view.setLayoutParams(place);
        return view;
    }

    private static Animator slide(View view, float to) {
        AnimatorSet both = new AnimatorSet();
        both.playTogether(
                ObjectAnimator.ofFloat(view, View.TRANSLATION_X, to),
                ObjectAnimator.ofFloat(view, View.TRANSLATION_Y, to));
        both.setDuration(70L);
        return both;
    }

    /** A panel of "paper" with its outline and shadow, holding one screen's worth of words. */
    private LinearLayout panel() {
        int drop = dp(5);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackground(raised(box(getColor(R.color.card), 2.5f), getColor(R.color.text), drop));
        panel.setPadding(dp(20), dp(20), dp(20) + drop, dp(14) + drop);
        return panel;
    }

    /** The bar at the top of her page: her name on its plate, and what this project is. */
    private LinearLayout nameBar() {
        int drop = dp(3);
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.setBackgroundColor(getColor(R.color.top));
        bar.setPadding(dp(16), dp(12), dp(16), dp(10));
        TextView plate = new TextView(this);
        plate.setText(R.string.app_name);
        plate.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21f);
        plate.setTypeface(Typeface.DEFAULT_BOLD);
        plate.setTextColor(getColor(R.color.ink));
        GradientDrawable face = new GradientDrawable();
        face.setColor(getColor(R.color.sun));
        face.setStroke(dp(2.5f), getColor(R.color.top_text));
        plate.setBackground(raised(face, getColor(R.color.paper), drop));
        plate.setPadding(dp(12), dp(2), dp(12) + drop, dp(4) + drop);
        plate.setRotation(-1.5f);
        bar.addView(plate, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView fan = new TextView(this);
        fan.setText(R.string.fan_line);
        fan.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        fan.setTypeface(Typeface.DEFAULT_BOLD);
        fan.setTextColor(getColor(R.color.top_text));
        fan.setAlpha(0.8f);
        fan.setPadding(0, dp(4), 0, 0);
        bar.addView(fan);
        return bar;
    }

    /**
     * The fan notice, along the bottom where her page has its composer: on every screen
     * of this app, in the colour the bar below it has, with a line along its top.
     */
    private TextView notice() {
        TextView view = new TextView(this);
        view.setText(R.string.notice);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        view.setTextColor(getColor(R.color.soft));
        view.setLineSpacing(0f, 1.25f);
        LayerDrawable ground = new LayerDrawable(new Drawable[] {
            box(getColor(R.color.text), 0f), box(getColor(R.color.card), 0f)
        });
        ground.setLayerInset(1, 0, dp(2.5f), 0, 0);
        view.setBackground(ground);
        view.setPadding(dp(16), dp(12), dp(16), dp(10));
        return view;
    }

    /**
     * Clears the app for one screen of its own and returns the panel to fill: the bar
     * with her name above it, the fan notice below.
     */
    private LinearLayout sheet() {
        dropWeb();
        LinearLayout whole = new LinearLayout(this);
        whole.setOrientation(LinearLayout.VERTICAL);
        whole.addView(nameBar(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        // The band under her page's header, in the colour it has when she is calm.
        View band = new View(this);
        band.setBackgroundColor(getColor(R.color.paper));
        whole.addView(band, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4)));
        LinearLayout panel = panel();
        FrameLayout.LayoutParams place = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        place.setMargins(dp(16), dp(20), dp(16), dp(20));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(false);
        scroll.addView(panel, place);
        whole.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        whole.addView(notice(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.removeAllViews();
        root.addView(whole, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return panel;
    }

    private void showSetup() {
        screen = this::showSetup;
        LinearLayout sheet = sheet();
        sheet.addView(words(getString(R.string.setup_title), 26f, true));
        sheet.addView(step(1, R.string.setup_step_1));
        sheet.addView(step(2, R.string.setup_step_2));
        TextView label = words(getString(R.string.setup_label), 15f, true);
        label.setPadding(0, dp(6), 0, dp(6));
        sheet.addView(label);
        final EditText where = new EditText(this);
        where.setHint(R.string.setup_hint);
        where.setSingleLine(true);
        where.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        where.setImeOptions(EditorInfo.IME_ACTION_GO);
        where.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19f);
        where.setTextColor(getColor(R.color.text));
        where.setHintTextColor((getColor(R.color.soft) & 0x00FFFFFF) | 0x99000000);
        // Outlined like the boxes on her page, and in pink while it is being typed in.
        GradientDrawable typing = new GradientDrawable();
        typing.setColor(getColor(R.color.card));
        typing.setStroke(dp(3.5f), getColor(R.color.blush));
        StateListDrawable frame = new StateListDrawable();
        frame.addState(new int[] {android.R.attr.state_focused}, typing);
        frame.addState(new int[] {}, box(getColor(R.color.card), 2.5f));
        where.setBackground(frame);
        where.setPadding(dp(14), dp(14), dp(14), dp(14));
        where.setMinHeight(dp(58));
        where.setMinimumHeight(dp(58));
        LinearLayout.LayoutParams wide = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wide.setMargins(0, 0, 0, dp(10));
        sheet.addView(where, wide);
        // Said in the page's way of saying something is wrong: dark words on pink.
        final TextView problem = words("", 15f, true);
        problem.setTextColor(getColor(R.color.ink));
        problem.setBackground(box(getColor(R.color.blush), 2.5f));
        problem.setPadding(dp(12), dp(10), dp(12), dp(10));
        problem.setVisibility(View.GONE);
        final Runnable connect = () -> {
            String typed = where.getText().toString().trim()
                    .replaceFirst("^https?://", "").replaceFirst("/.*$", "");
            if (!isHomeAddress(typed)) {
                problem.setText(R.string.setup_bad_address);
                problem.setVisibility(View.VISIBLE);
                return;
            }
            // Whatever answers there is not yet known to be the PC a kept key was made for.
            forgetUnlock();
            prefs.edit().putString(KEY_ADDRESS, typed).remove(KEY_FINGERPRINT).apply();
            showStation();
        };
        where.setOnEditorActionListener((view, action, event) -> {
            connect.run();
            return true;
        });
        sheet.addView(problem, new LinearLayout.LayoutParams(wide));
        Button go = button(R.string.setup_connect, true);
        go.setOnClickListener((View view) -> connect.run());
        sheet.addView(go);

        final TextView discoveredHeader = words(getString(R.string.setup_discovered), 15f, true);
        discoveredHeader.setPadding(0, dp(10), 0, dp(4));
        discoveredHeader.setVisibility(View.GONE);
        sheet.addView(discoveredHeader);

        final LinearLayout discoveredList = new LinearLayout(this);
        discoveredList.setOrientation(LinearLayout.VERTICAL);
        sheet.addView(discoveredList);
        startNsdDiscovery(discoveredHeader, discoveredList, where, connect);

        TextView network = words(getString(R.string.setup_network), 14f, false);
        network.setTextColor(getColor(R.color.soft));
        network.setPadding(0, dp(10), 0, dp(8));
        sheet.addView(network);
        TextView browser = words(getString(R.string.setup_browser), 14f, false);
        browser.setTextColor(getColor(R.color.soft));
        browser.setPadding(0, 0, 0, dp(8));
        sheet.addView(browser);
    }

    private static String sanitizeNsdLabel(String raw) {
        if (raw == null) return "Astra Navi";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            if (ch >= 0x20 && ch != 0x7f) sb.append(ch);
            if (sb.length() >= 40) break;
        }
        String clean = sb.toString().trim();
        return clean.isEmpty() ? "Astra Navi" : clean;
    }

    @SuppressWarnings("deprecation")
    private void startNsdDiscovery(
            final TextView header,
            final LinearLayout container,
            final EditText addressInput,
            final Runnable connectAction) {
        stopNsdDiscovery();
        // Never allow passive LAN mDNS discovery to override or prompt when already pinned.
        if (prefs.getString(KEY_FINGERPRINT, null) != null) return;
        final NsdManager mgr = getSystemService(NsdManager.class);
        if (mgr == null) return;
        nsdManager = mgr;
        nsdDiscovery =
                new NsdManager.DiscoveryListener() {
                    @Override
                    public void onStartDiscoveryFailed(String serviceType, int errorCode) {}

                    @Override
                    public void onStopDiscoveryFailed(String serviceType, int errorCode) {}

                    @Override
                    public void onDiscoveryStarted(String serviceType) {}

                    @Override
                    public void onDiscoveryStopped(String serviceType) {}

                    @Override
                    public void onServiceFound(NsdServiceInfo serviceInfo) {
                        mgr.resolveService(
                                serviceInfo,
                                new NsdManager.ResolveListener() {
                                    @Override
                                    public void onResolveFailed(NsdServiceInfo si, int errorCode) {}

                                    @Override
                                    public void onServiceResolved(final NsdServiceInfo resolved) {
                                        if (resolved.getHost() == null) return;
                                        java.util.Map<String, byte[]> attrs = resolved.getAttributes();
                                        if (attrs != null) {
                                            byte[] proto = attrs.get("proto");
                                            if (proto != null) {
                                                String protoVal = new String(proto, StandardCharsets.UTF_8);
                                                if (!"https".equalsIgnoreCase(protoVal)) return;
                                            }
                                        }
                                        final String host = resolved.getHost().getHostAddress();
                                        final String candidate = host + ":" + resolved.getPort();
                                        if (!isHomeAddress(candidate)) return;
                                        final String label =
                                                sanitizeNsdLabel(resolved.getServiceName())
                                                        + " ("
                                                        + candidate
                                                        + ")";
                                        root.post(
                                                () -> {
                                                    if (!alive() || container.getChildCount() >= 12) return;
                                                    for (int i = 0; i < container.getChildCount(); i++) {
                                                        View child = container.getChildAt(i);
                                                        if (candidate.equals(child.getTag())) return;
                                                    }
                                                    header.setVisibility(View.VISIBLE);
                                                    Button pick = button(R.string.setup_connect, false);
                                                    pick.setText(label);
                                                    pick.setTag(candidate);
                                                    pick.setOnClickListener(
                                                            (View v) -> {
                                                                addressInput.setText(candidate);
                                                                connectAction.run();
                                                            });
                                                    container.addView(pick);
                                                });
                                    }
                                });
                    }

                    @Override
                    public void onServiceLost(NsdServiceInfo serviceInfo) {}
                };
        try {
            mgr.discoverServices("_astranavi._tcp.", NsdManager.PROTOCOL_DNS_SD, nsdDiscovery);
        } catch (Exception ignored) {
            nsdDiscovery = null;
        }
    }

    private void stopNsdDiscovery() {
        NsdManager mgr = nsdManager;
        NsdManager.DiscoveryListener listener = nsdDiscovery;
        nsdDiscovery = null;
        if (mgr != null && listener != null) {
            try {
                mgr.stopServiceDiscovery(listener);
            } catch (Exception ignored) {
                // ignore if already stopped or torn down
            }
        }
    }

    private void showProblem(int title, int explanation, String at, boolean mayRetry) {
        screen = () -> showProblem(title, explanation, at, mayRetry);
        LinearLayout sheet = sheet();
        sheet.addView(words(getString(title), 24f, true));
        TextView told = words(getString(explanation, at), 16f, false);
        told.setPadding(0, 0, 0, dp(16));
        sheet.addView(told);
        if (mayRetry && prefs.getString(KEY_FINGERPRINT, null) != null) {
            EditText draft = new EditText(this);
            draft.setHint(R.string.outbox_hint);
            draft.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
            draft.setMinLines(2);
            draft.setTextColor(getColor(R.color.text));
            draft.setHintTextColor(getColor(R.color.soft));
            draft.setBackground(box(getColor(R.color.page), 2f));
            draft.setPadding(dp(12), dp(10), dp(12), dp(10));
            sheet.addView(draft, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            final TextView countLabel = words("", 13f, false);
            countLabel.setTextColor(getColor(R.color.soft));
            updateNativeOutboxLabel(countLabel);
            Button queue = button(R.string.outbox_queue, false);
            queue.setOnClickListener((View v) -> {
                String text = draft.getText() == null ? "" : draft.getText().toString().trim();
                if (text.isEmpty()) return;
                enqueueNativeOutbox(text);
                draft.setText("");
                updateNativeOutboxLabel(countLabel);
            });
            sheet.addView(queue);
            sheet.addView(countLabel);
        }
        if (mayRetry) {
            Button again = button(R.string.try_again, true);
            again.setOnClickListener((View view) -> showStation());
            sheet.addView(again);
        }
        Button over = button(R.string.start_over, !mayRetry);
        over.setOnClickListener((View view) -> startOver());
        sheet.addView(over);
    }

    private void enqueueNativeOutbox(String text) {
        String clipped = text.length() > 2000 ? text.substring(0, 2000) : text;
        synchronized (outboxLock) {
            JSONArray list = new JSONArray();
            try {
                String raw = prefs.getString(KEY_OUTBOX, null);
                if (raw != null && raw.startsWith("[")) list = new JSONArray(raw);
            } catch (Exception ignored) {
                list = new JSONArray();
            }
            JSONArray trimmed = new JSONArray();
            int start = Math.max(0, list.length() - (MAX_OUTBOX - 1));
            for (int i = start; i < list.length(); i++) {
                String entry = list.optString(i, "").trim();
                if (!entry.isEmpty()) trimmed.put(entry);
            }
            trimmed.put(clipped);
            prefs.edit().putString(KEY_OUTBOX, trimmed.toString()).apply();
        }
    }

    private void updateNativeOutboxLabel(TextView label) {
        int count = 0;
        synchronized (outboxLock) {
            try {
                String raw = prefs.getString(KEY_OUTBOX, null);
                if (raw != null && raw.startsWith("[")) count = new JSONArray(raw).length();
            } catch (Exception ignored) {
                count = 0;
            }
        }
        if (count <= 0) {
            label.setText("");
        } else if (count == 1) {
            label.setText(R.string.outbox_count_one);
        } else {
            label.setText(getString(R.string.outbox_count_many, count));
        }
    }

    // ---------------------------------------------------------------- fingerprints

    private static String upper(String text) {
        return text == null ? null : text.replace(":", "").toUpperCase(Locale.ROOT);
    }

    /** The SHA-256 fingerprint of a certificate as 64 hex digits, or null when it cannot be read. */
    private static String fingerprintOf(SslCertificate certificate) {
        try {
            X509Certificate real = certificate == null ? null : certificate.getX509Certificate();
            if (real == null) return null;
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(real.getEncoded());
            StringBuilder hex = new StringBuilder(64);
            for (byte part : digest) hex.append(String.format(Locale.ROOT, "%02X", part));
            return hex.toString();
        } catch (Exception problem) {
            return null;
        }
    }

    /**
     * The last sixteen pairs of a fingerprint, written the way her Settings show them, in
     * two rows so they can be compared by eye.
     */
    private static String tail(String print) {
        String end = print.substring(Math.max(0, print.length() - 32));
        StringBuilder shown = new StringBuilder();
        for (int index = 0; index < end.length(); index += 2) {
            if (index == 16) shown.append(":\n");
            else if (shown.length() > 0) shown.append(':');
            shown.append(end, index, Math.min(end.length(), index + 2));
        }
        return shown.toString();
    }
}
