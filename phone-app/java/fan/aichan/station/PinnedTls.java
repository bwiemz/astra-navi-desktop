package fan.aichan.station;

import java.io.IOException;
import java.net.URI;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Opens HTTPS connections to the user's station pinned strictly to its paired certificate
 * fingerprint and home-network address. Never trusts any CA store or third-party host.
 */
final class PinnedTls {
    private static final Pattern FINGERPRINT = Pattern.compile("^[0-9A-F]{64}$");

    private PinnedTls() {}

    static HttpsURLConnection openPinned(String address, String expectedHex, String pathAndQuery)
            throws IOException, GeneralSecurityException {
        if (!MainActivity.isHomeAddress(address)) {
            throw new IOException("Station address is not on the local network.");
        }
        String normalized = expectedHex == null ? "" : expectedHex.replace(":", "").toUpperCase(Locale.ROOT);
        if (!FINGERPRINT.matcher(normalized).matches()) {
            throw new IOException("Pinned certificate fingerprint is missing.");
        }
        int colon = address.lastIndexOf(':');
        String expectedHost = colon > 0 ? address.substring(0, colon) : address;
        String cleanPath = pathAndQuery != null && pathAndQuery.startsWith("/") ? pathAndQuery : "/";

        SSLContext ssl = SSLContext.getInstance("TLS");
        ssl.init(null, new TrustManager[] {pinnedTrustManager(normalized)}, new SecureRandom());

        HttpsURLConnection conn =
                (HttpsURLConnection) URI.create("https://" + address + cleanPath).toURL().openConnection();
        conn.setSSLSocketFactory(ssl.getSocketFactory());
        conn.setHostnameVerifier((hostname, session) -> expectedHost.equals(hostname));
        conn.setUseCaches(false);
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(15_000);
        return conn;
    }

    static String sha256Hex(byte[] encoded) throws GeneralSecurityException {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(encoded);
        StringBuilder hex = new StringBuilder(64);
        for (byte part : digest) hex.append(String.format(Locale.ROOT, "%02X", part));
        return hex.toString();
    }

    private static X509TrustManager pinnedTrustManager(final String expectedHex) {
        return new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                throw new CertificateException("Client certificates are not accepted.");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                if (chain == null || chain.length == 0 || chain[0] == null) {
                    throw new CertificateException("Empty server certificate chain.");
                }
                try {
                    String actual = sha256Hex(chain[0].getEncoded());
                    if (!expectedHex.equals(actual)) {
                        throw new CertificateException("Station certificate fingerprint mismatch.");
                    }
                } catch (CertificateException ce) {
                    throw ce;
                } catch (GeneralSecurityException gse) {
                    throw new CertificateException("Could not verify certificate fingerprint.", gse);
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
    }
}
