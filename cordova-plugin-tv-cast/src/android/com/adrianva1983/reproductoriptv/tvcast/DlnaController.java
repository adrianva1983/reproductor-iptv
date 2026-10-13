package com.adrianva1983.reproductoriptv.tvcast;

import android.util.Log;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Control de un MediaRenderer DLNA/UPnP ya descubierto: dos acciones SOAP del
 * servicio AVTransport (SetAVTransportURI + Play) para enviar un canal, y
 * Stop para dejar de enviarlo. Sin sesión persistente: cada llamada es
 * autocontenida, igual que especifica el diseño.
 */
class DlnaController {

    private static final String TAG = "TvCastPlugin";
    private static final String AVTRANSPORT_TYPE = "urn:schemas-upnp-org:service:AVTransport:1";

    /** Bloqueante: se espera que quien llame ya esté en un hilo de background. */
    static void play(String controlUrl, String streamUrl, String title, String contentType) {
        // Fix: confirmado en dispositivo real (Samsung) — si el renderer ya
        // estaba reproduciendo otra cosa, cambiar de URI y pedir Play falla con
        // "701 Transition not available" porque el TV sigue "ocupado" con la
        // transición anterior. Un Stop explícito antes (se ignora si falla: es
        // inofensivo si no había nada reproduciéndose) deja al renderer en un
        // estado limpio del que sí puede transicionar.
        sendAction(controlUrl, "Stop", "<InstanceID>0</InstanceID>");
        sleepQuietly(400);

        String didlLite = "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" "
                + "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" "
                + "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">"
                + "<item id=\"1\" parentID=\"0\" restricted=\"1\">"
                + "<dc:title>" + escapeXml(title) + "</dc:title>"
                + "<upnp:class>object.item.videoItem</upnp:class>"
                + "<res protocolInfo=\"http-get:*:" + contentType + ":*\">" + escapeXml(streamUrl) + "</res>"
                + "</item></DIDL-Lite>";

        String setUriBody = "<InstanceID>0</InstanceID>"
                + "<CurrentURI>" + escapeXml(streamUrl) + "</CurrentURI>"
                + "<CurrentURIMetaData>" + escapeXml(didlLite) + "</CurrentURIMetaData>";
        boolean ok = sendAction(controlUrl, "SetAVTransportURI", setUriBody);
        if (!ok) return;

        // Varios reintentos con margen creciente: incluso con el Stop previo,
        // algunos renderers tardan en quedar listos para aceptar Play.
        String playBody = "<InstanceID>0</InstanceID><Speed>1</Speed>";
        long[] delaysMs = {700, 1200, 1800};
        for (long delay : delaysMs) {
            sleepQuietly(delay);
            if (sendAction(controlUrl, "Play", playBody)) return;
        }
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Bloqueante: se espera que quien llame ya esté en un hilo de background. */
    static void stop(String controlUrl) {
        sendAction(controlUrl, "Stop", "<InstanceID>0</InstanceID>");
    }

    private static boolean sendAction(String controlUrl, String action, String bodyXml) {
        String envelope = "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                + "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
                + "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
                + "<s:Body><u:" + action + " xmlns:u=\"" + AVTRANSPORT_TYPE + "\">"
                + bodyXml
                + "</u:" + action + "></s:Body></s:Envelope>";

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(controlUrl).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(5000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
            connection.setRequestProperty("SOAPACTION", "\"" + AVTRANSPORT_TYPE + "#" + action + "\"");

            byte[] payload = envelope.getBytes(StandardCharsets.UTF_8);
            connection.setRequestProperty("Content-Length", String.valueOf(payload.length));
            OutputStream out = connection.getOutputStream();
            out.write(payload);
            out.flush();
            out.close();

            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                String errorBody = readStream(connection.getErrorStream());
                Log.e(TAG, "DLNA " + action + " respondió " + code + " desde " + controlUrl + ": " + errorBody);
                return false;
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "DLNA " + action + " falló contra " + controlUrl, e);
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readStream(java.io.InputStream in) {
        if (in == null) return "(sin cuerpo)";
        try {
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[512];
            int n;
            while ((n = in.read(chunk)) != -1) buffer.write(chunk, 0, n);
            return buffer.toString("UTF-8");
        } catch (Exception e) {
            return "(no se pudo leer el cuerpo del error: " + e + ")";
        }
    }

    private static String escapeXml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&apos;");
    }

    private DlnaController() {
    }
}
