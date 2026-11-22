package tw.k.harness;

import android.net.Uri;
import android.webkit.CookieManager;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** The owner's private K address and the login the K page already holds. */
final class Shell {
    /** Tailscale Serve (private HTTPS, never Funnel) in front of the PC's K. */
    static final String ORIGIN = ServerConfig.ORIGIN;

    private Shell() {}

    static boolean isK(Uri uri) {
        Uri k = Uri.parse(ORIGIN);
        return uri != null
                && "https".equals(uri.getScheme())
                && k.getHost().equalsIgnoreCase(uri.getHost())
                && uri.getPort() == k.getPort();
    }

    /** The K remote login cookie, shared with the page shown in this app. */
    static String cookie() {
        return CookieManager.getInstance().getCookie(ORIGIN);
    }

    static HttpURLConnection open(String path) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + path).openConnection();
        String cookie = cookie();
        if (cookie != null) connection.setRequestProperty("Cookie", cookie);
        connection.setConnectTimeout(15000);
        connection.setUseCaches(false);
        return connection;
    }

    /** A short response body (at most 64 KB); empty when there is none or it cannot be read. */
    static String readAll(InputStream in) {
        if (in == null) return "";
        try (InputStream stream = in) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int n;
            while ((n = stream.read(buffer)) > 0 && bytes.size() < 65536) bytes.write(buffer, 0, n);
            return bytes.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            return "";
        }
    }
}
