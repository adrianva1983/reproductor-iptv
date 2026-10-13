package com.adrianva1983.reproductoriptv.tvcast;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import java.io.IOException;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

/**
 * Descubrimiento SSDP de dispositivos UPnP MediaRenderer (DLNA "Play To"),
 * bajo demanda (no hay escaneo continuo en segundo plano, a diferencia de
 * Google Cast). Sin librerías UPnP de terceros: el protocolo es pequeño y
 * bien documentado (SSDP + un GET del XML de descripción), mismo criterio
 * ya aplicado en cordova-plugin-ts-proxy.
 */
class DlnaDiscovery {

    private static final String TAG = "TvCastPlugin";
    private static final String MULTICAST_ADDRESS = "239.255.255.250";
    private static final int MULTICAST_PORT = 1900;
    private static final int SEARCH_WINDOW_MS = 3000;
    private static final String AVTRANSPORT_TYPE = "urn:schemas-upnp-org:service:AVTransport:1";

    interface Listener {
        void onDeviceFound(DlnaDevice device);
        void onDiscoveryFinished();
    }

    private static int idCounter = 0;

    /** Bloqueante: se espera que quien llame ya esté en un hilo de background. */
    static void discover(Context context, Listener listener) {
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = wifi != null ? wifi.createMulticastLock("tvcast-dlna") : null;
        if (lock != null) {
            lock.setReferenceCounted(true);
            lock.acquire();
        }

        Set<String> seenLocations = new HashSet<>();
        DatagramSocket socket = null;
        try {
            socket = new DatagramSocket();
            socket.setSoTimeout(300);

            String message = "M-SEARCH * HTTP/1.1\r\n"
                    + "HOST: " + MULTICAST_ADDRESS + ":" + MULTICAST_PORT + "\r\n"
                    + "MAN: \"ssdp:discover\"\r\n"
                    + "MX: 2\r\n"
                    + "ST: " + AVTRANSPORT_TYPE + "\r\n\r\n";
            byte[] searchBytes = message.getBytes("UTF-8");
            DatagramPacket searchPacket = new DatagramPacket(
                    searchBytes, searchBytes.length, InetAddress.getByName(MULTICAST_ADDRESS), MULTICAST_PORT);
            socket.send(searchPacket);

            long deadline = System.currentTimeMillis() + SEARCH_WINDOW_MS;
            byte[] buffer = new byte[2048];
            while (System.currentTimeMillis() < deadline) {
                try {
                    DatagramPacket response = new DatagramPacket(buffer, buffer.length);
                    socket.receive(response);
                    String text = new String(response.getData(), 0, response.getLength(), "UTF-8");
                    String location = extractHeader(text, "location");
                    if (location != null && seenLocations.add(location)) {
                        DlnaDevice device = describeDevice(location);
                        if (device != null) listener.onDeviceFound(device);
                    }
                } catch (SocketTimeoutException timeout) {
                    // normal: seguimos comprobando hasta agotar la ventana de búsqueda
                }
            }
        } catch (IOException e) {
            Log.e(TAG, "Fallo en la búsqueda SSDP", e);
        } finally {
            if (socket != null) socket.close();
            if (lock != null && lock.isHeld()) lock.release();
        }

        listener.onDiscoveryFinished();
    }

    private static String extractHeader(String httpMessage, String headerName) {
        String[] lines = httpMessage.split("\r\n");
        String prefix = headerName.toLowerCase() + ":";
        for (String line : lines) {
            if (line.toLowerCase().startsWith(prefix)) {
                return line.substring(line.indexOf(':') + 1).trim();
            }
        }
        return null;
    }

    /** Descarga y parsea el XML de descripción; null si no tiene servicio AVTransport. */
    private static DlnaDevice describeDevice(String location) {
        HttpURLConnection connection = null;
        try {
            URL locationUrl = new URL(location);
            connection = (HttpURLConnection) locationUrl.openConnection();
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(2000);
            connection.setRequestMethod("GET");

            InputStream input = connection.getInputStream();
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            DocumentBuilder builder = factory.newDocumentBuilder();
            Document doc = builder.parse(new InputSource(input));

            String friendlyName = firstTagText(doc, "friendlyName");
            String controlUrl = findAvTransportControlUrl(doc);
            if (controlUrl == null) return null;

            URL resolvedControlUrl = new URL(locationUrl, controlUrl);
            String id = "dlna-" + (++idCounter);
            String name = (friendlyName != null && !friendlyName.isEmpty()) ? friendlyName : "TV DLNA";
            return new DlnaDevice(id, name, resolvedControlUrl.toString());
        } catch (Exception e) {
            // XML inesperado, timeout, dispositivo que no es realmente un MediaRenderer: se ignora.
            Log.e(TAG, "No se pudo describir el dispositivo DLNA en " + location, e);
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String firstTagText(Document doc, String tagName) {
        NodeList nodes = doc.getElementsByTagName(tagName);
        if (nodes.getLength() == 0) return null;
        return nodes.item(0).getTextContent();
    }

    /** Busca, entre todos los <service>, el que tenga serviceType AVTransport, y devuelve su controlURL. */
    private static String findAvTransportControlUrl(Document doc) {
        NodeList services = doc.getElementsByTagName("service");
        for (int i = 0; i < services.getLength(); i++) {
            Node serviceNode = services.item(i);
            if (!(serviceNode instanceof Element)) continue;
            Element service = (Element) serviceNode;
            String serviceType = childText(service, "serviceType");
            if (AVTRANSPORT_TYPE.equals(serviceType)) {
                return childText(service, "controlURL");
            }
        }
        return null;
    }

    private static String childText(Element parent, String tagName) {
        NodeList nodes = parent.getElementsByTagName(tagName);
        if (nodes.getLength() == 0) return null;
        return nodes.item(0).getTextContent();
    }

    private DlnaDiscovery() {
    }
}
