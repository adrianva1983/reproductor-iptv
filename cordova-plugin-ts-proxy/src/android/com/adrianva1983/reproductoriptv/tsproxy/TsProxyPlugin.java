package com.adrianva1983.reproductoriptv.tsproxy;

import android.util.Log;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Servidor HTTP local que reenvía streams remotos añadiendo cabeceras CORS y
 * el User-Agent real del WebView. El WebView aplica CORS a fetch()/XHR (lo
 * que usa mpegts.js), pero el código nativo no tiene ese concepto: pedimos
 * el stream nativamente y se lo servimos al WebView como si lo
 * respondiéramos nosotros mismos.
 *
 * Por defecto escucha solo en 127.0.0.1 (uso local del propio WebView). Para
 * enviar un canal .ts por DLNA a un TV en la misma red (ver
 * cordova-plugin-tv-cast), el TV necesita alcanzar este proxy directamente
 * -confirmado en dispositivo real: el servidor de origen del stream devuelve
 * 403 Forbidden a peticiones sin User-Agent de navegador, y el TV no puede
 * enviar ese User-Agent por su cuenta-. startForLan()/stopLan() abren y
 * cierran una ventana mínima en la que el proxy escucha en la red (todas las
 * interfaces), protegida con un token de un solo uso por sesión para que no
 * cualquier otro dispositivo de la LAN pueda usarlo como relé a ciegas.
 */
public class TsProxyPlugin extends CordovaPlugin {

    private static final String TAG = "TsProxyPlugin";

    private ServerSocket serverSocket;
    private volatile boolean running = false;
    private volatile boolean lanMode = false;
    private volatile int port = -1;
    private volatile String lanToken = null;
    // Algunos servidores IPTV rechazan (403) peticiones con User-Agent genérico;
    // se usa el del WebView real, recibido desde JS, en vez de uno fijo.
    private volatile String userAgent = "Mozilla/5.0";

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) {
        switch (action) {
            case "start":
                if (args.length() > 0) {
                    String ua = args.optString(0, null);
                    if (ua != null && !ua.isEmpty()) userAgent = ua;
                }
                startServer(false, callbackContext);
                return true;
            case "startForLan":
                if (args.length() > 0) {
                    String ua = args.optString(0, null);
                    if (ua != null && !ua.isEmpty()) userAgent = ua;
                }
                startServer(true, callbackContext);
                return true;
            case "stopLan":
                stopLan(callbackContext);
                return true;
            default:
                return false;
        }
    }

    private synchronized void startServer(final boolean forLan, final CallbackContext callbackContext) {
        if (running && port > 0 && lanMode == forLan) {
            respondWithInfo(callbackContext);
            return;
        }
        // Si cambia el modo (local <-> LAN), hay que cerrar el servidor anterior:
        // un ServerSocket no se puede "re-enlazar" a otra dirección sin recrearlo.
        if (running) {
            closeServerSocket();
        }
        cordova.getThreadPool().execute(new Runnable() {
            @Override
            public void run() {
                try {
                    serverSocket = forLan
                            ? new ServerSocket(0, 50)
                            : new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
                    port = serverSocket.getLocalPort();
                    lanMode = forLan;
                    lanToken = forLan ? UUID.randomUUID().toString() : null;
                    running = true;
                    respondWithInfo(callbackContext);
                    acceptLoop();
                } catch (IOException e) {
                    callbackContext.error("No se pudo iniciar el servidor proxy: " + e.getMessage());
                }
            }
        });
    }

    private synchronized void stopLan(CallbackContext callbackContext) {
        if (lanMode) {
            closeServerSocket();
            running = false;
            lanMode = false;
            lanToken = null;
        }
        callbackContext.success();
    }

    private void closeServerSocket() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void respondWithInfo(CallbackContext callbackContext) {
        try {
            JSONObject result = new JSONObject();
            result.put("port", port);
            if (lanMode) {
                result.put("token", lanToken);
                result.put("ip", getLanIpAddress());
            }
            callbackContext.success(result);
        } catch (JSONException ignored) {
            // No debería ocurrir con un objeto tan simple.
        }
    }

    /** IP propia en la red local (normalmente la interfaz WiFi); null si no se encuentra. */
    private static String getLanIpAddress() {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                NetworkInterface iface = ifaces.nextElement();
                if (iface.isLoopback() || !iface.isUp()) continue;
                Enumeration<InetAddress> addresses = iface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress addr = addresses.nextElement();
                    if (addr instanceof Inet4Address) return addr.getHostAddress();
                }
            }
        } catch (Exception ignored) {
            // Sin IP de red disponible: el llamador lo tratará como fallo.
        }
        return null;
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket socket = serverSocket.accept();
                cordova.getThreadPool().execute(new Runnable() {
                    @Override
                    public void run() {
                        handleConnection(socket);
                    }
                });
            } catch (IOException e) {
                // El socket se cerró al destruir el plugin, o error transitorio; seguimos si sigue activo.
            }
        }
    }

    private void handleConnection(Socket socket) {
        try {
            socket.setSoTimeout(15000);
            InputStream rawIn = socket.getInputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(rawIn, StandardCharsets.ISO_8859_1));
            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) {
                socket.close();
                return;
            }
            String[] requestParts = requestLine.split(" ");
            if (requestParts.length < 2) {
                socket.close();
                return;
            }
            String method = requestParts[0];
            String path = requestParts[1];

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                int idx = line.indexOf(':');
                if (idx > 0) {
                    headers.put(line.substring(0, idx).trim().toLowerCase(), line.substring(idx + 1).trim());
                }
            }

            OutputStream out = socket.getOutputStream();

            if ("OPTIONS".equalsIgnoreCase(method)) {
                writeCorsPreflight(out);
                socket.close();
                return;
            }

            if (!path.startsWith("/ts-proxy")) {
                writeSimpleStatus(out, 404, "Not Found");
                socket.close();
                return;
            }

            // En modo LAN (expuesto a la red, no solo al propio móvil) se exige el
            // token de la sesión de envío a TV actual; sin él, cualquier otro
            // dispositivo de la red podría usar este proxy como relé a ciegas.
            if (lanMode) {
                String token = extractQueryParam(path, "token");
                if (token == null || !token.equals(lanToken)) {
                    writeSimpleStatus(out, 403, "Forbidden");
                    socket.close();
                    return;
                }
            }

            String targetUrl = extractQueryParam(path, "url");
            if (targetUrl == null || !(targetUrl.startsWith("http://") || targetUrl.startsWith("https://"))) {
                writeSimpleStatus(out, 400, "Bad Request");
                socket.close();
                return;
            }

            proxyRequest(method, targetUrl, headers.get("range"), out);
            socket.close();
        } catch (Exception e) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private String extractQueryParam(String path, String name) {
        int q = path.indexOf('?');
        if (q < 0) return null;
        String query = path.substring(q + 1);
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) continue;
            String key = pair.substring(0, eq);
            if (name.equals(key)) {
                String value = pair.substring(eq + 1);
                try {
                    return URLDecoder.decode(value, "UTF-8");
                } catch (Exception e) {
                    return null;
                }
            }
        }
        return null;
    }

    private HttpURLConnection openUpstream(String targetUrl, String method, String rangeHeader) throws IOException {
        URL url = new URL(targetUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("HEAD".equalsIgnoreCase(method) ? "GET" : method);
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        if (rangeHeader != null) {
            conn.setRequestProperty("Range", rangeHeader);
        }
        conn.setRequestProperty("User-Agent", userAgent);
        return conn;
    }

    private void proxyRequest(String method, String targetUrl, String rangeHeader, OutputStream out) {
        HttpURLConnection conn = null;
        boolean headersSent = false;
        try {
            conn = openUpstream(targetUrl, method, rangeHeader);

            int code = conn.getResponseCode();
            String contentType = conn.getContentType();
            long contentLength = conn.getContentLengthLong();
            String contentRange = conn.getHeaderField("Content-Range");

            StringBuilder headerBuilder = new StringBuilder();
            headerBuilder.append("HTTP/1.1 ").append(code).append(' ').append(statusText(code)).append("\r\n");
            headerBuilder.append("Access-Control-Allow-Origin: *\r\n");
            headerBuilder.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
            headerBuilder.append("Access-Control-Allow-Headers: Range, Content-Type\r\n");
            headerBuilder.append("Connection: close\r\n");
            if (contentType != null) headerBuilder.append("Content-Type: ").append(contentType).append("\r\n");
            if (contentRange != null) headerBuilder.append("Content-Range: ").append(contentRange).append("\r\n");
            headerBuilder.append("Accept-Ranges: bytes\r\n");
            if (contentLength >= 0) headerBuilder.append("Content-Length: ").append(contentLength).append("\r\n");
            headerBuilder.append("\r\n");
            out.write(headerBuilder.toString().getBytes(StandardCharsets.ISO_8859_1));
            headersSent = true;
            Log.d(TAG, "Upstream " + code + " for " + targetUrl + " (contentLength=" + contentLength + ")");

            if (!"HEAD".equalsIgnoreCase(method)) {
                // Fix: algunos reemisores IPTV cortan la conexión de origen a
                // media transmisión (confirmado en pruebas reales: el canal
                // reproduce el primer tramo con normalidad y luego se queda
                // colgado) sin que eso signifique que el directo haya
                // terminado. Sin Content-Length (caso típico de un directo),
                // el cliente (mpegts.js) trata esta respuesta como un único
                // flujo continuo de bytes, así que un corte se repara
                // reconectando al origen y siguiendo por el mismo socket al
                // cliente — no hace falta reiniciar la reproducción ni que
                // el cliente lo note. Solo se reintenta así para directos sin
                // Content-Length conocido; una descarga normal con tamaño fijo
                // deja que un corte se propague como error, como antes.
                boolean isLiveStream = contentLength < 0 && code >= 200 && code < 400;
                int retriesLeft = isLiveStream ? 5 : 0;
                InputStream in = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
                byte[] buffer = new byte[8192];

                while (in != null) {
                    try {
                        int n;
                        while ((n = in.read(buffer)) != -1) {
                            out.write(buffer, 0, n);
                            retriesLeft = isLiveStream ? 5 : retriesLeft;
                        }
                        break;
                    } catch (IOException readError) {
                        Log.w(TAG, "Upstream read failed for " + targetUrl + " (" + retriesLeft + " reintentos restantes): " + readError);
                        if (retriesLeft <= 0) throw readError;
                        retriesLeft--;
                        conn.disconnect();
                        conn = openUpstream(targetUrl, method, null);
                        int retryCode = conn.getResponseCode();
                        in = (retryCode >= 200 && retryCode < 400) ? conn.getInputStream() : conn.getErrorStream();
                        Log.d(TAG, "Reconectado a " + targetUrl + ", nuevo código " + retryCode);
                    }
                }
            }
            out.flush();
        } catch (Exception e) {
            Log.w(TAG, "proxyRequest falló para " + targetUrl + " (headersSent=" + headersSent + "): " + e);
            // Si ya se habían enviado las cabeceras (y puede que bytes del
            // cuerpo) al cliente, escribir aquí un "502" lo haría caer en
            // medio del flujo de vídeo como basura indescifrable para el
            // demuxer, dejándolo colgado "cargando" en vez de fallar limpio
            // (confirmado en pruebas reales). En ese caso basta con cerrar la
            // conexión sin escribir nada más; el cliente lo trata como fin de
            // flujo inesperado y dispara su propio error de red.
            if (!headersSent) try {
                writeSimpleStatus(out, 502, "Bad Gateway");
            } catch (IOException ignored) {
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void writeCorsPreflight(OutputStream out) throws IOException {
        String response = "HTTP/1.1 204 No Content\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: Range, Content-Type\r\n"
                + "Connection: close\r\n\r\n";
        out.write(response.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private void writeSimpleStatus(OutputStream out, int code, String text) throws IOException {
        String response = "HTTP/1.1 " + code + " " + text + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Connection: close\r\n\r\n";
        out.write(response.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private String statusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 404: return "Not Found";
            default: return "OK";
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
        }
        super.onDestroy();
    }
}
