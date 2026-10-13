package com.adrianva1983.reproductoriptv.tvcast;

import android.Manifest;
import android.app.Activity;
import android.os.Build;
import android.util.Log;
import android.view.ViewGroup;

import androidx.mediarouter.app.MediaRouteButton;

import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.framework.CastButtonFactory;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.CastState;
import com.google.android.gms.cast.framework.CastStateListener;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Envía el canal activo a un dispositivo Google Cast en la misma red, usando
 * el Default Media Receiver (no hace falta receptor propio). El selector de
 * dispositivos lo abre el propio SDK (MediaRouteButton oculto + performClick);
 * no se construye ninguna UI de descubrimiento a mano.
 *
 * También soporta dispositivos DLNA/UPnP genéricos (p.ej. TVs Samsung, que no
 * son Google Cast) vía SSDP + SOAP (ver DlnaDiscovery/DlnaController); al no
 * tener un selector nativo propio, el descubrimiento se expone a JS para que
 * la propia app construya la lista.
 */
public class TvCastPlugin extends CordovaPlugin {

    private static final String TAG = "TvCastPlugin";
    private static final int REQUEST_NEARBY_WIFI_DEVICES = 73001;

    private volatile CastContext castContext;
    private MediaRouteButton mediaRouteButton;
    private CallbackContext availabilityCallback;
    private CallbackContext sessionCallback;
    private CallbackContext dlnaCallback;
    private final Map<String, DlnaDevice> dlnaDevices = new ConcurrentHashMap<>();

    private final CastStateListener castStateListener = new CastStateListener() {
        @Override
        public void onCastStateChanged(int newState) {
            sendAvailability(newState != CastState.NO_DEVICES_AVAILABLE);
        }
    };

    private final SessionManagerListener<CastSession> sessionManagerListener =
            new SessionManagerListener<CastSession>() {
        @Override
        public void onSessionStarting(CastSession session) {
            sendSessionState("connecting", null);
        }

        @Override
        public void onSessionStarted(CastSession session, String sessionId) {
            sendSessionState("connected", deviceName(session));
        }

        @Override
        public void onSessionStartFailed(CastSession session, int error) {
            sendSessionState("disconnected", null);
        }

        @Override
        public void onSessionResuming(CastSession session, String sessionId) {
            sendSessionState("connecting", null);
        }

        @Override
        public void onSessionResumed(CastSession session, boolean wasSuspended) {
            sendSessionState("connected", deviceName(session));
        }

        @Override
        public void onSessionResumeFailed(CastSession session, int error) {
            sendSessionState("disconnected", null);
        }

        @Override
        public void onSessionSuspended(CastSession session, int reason) {
            sendSessionState("disconnected", null);
        }

        @Override
        public void onSessionEnding(CastSession session) {
            // sin acción: se notifica en onSessionEnded, cuando la sesión ya terminó de verdad
        }

        @Override
        public void onSessionEnded(CastSession session, int error) {
            sendSessionState("disconnected", null);
        }
    };

    @Override
    protected void pluginInitialize() {
        // Fix: Android 13+ (API 33+) exige el permiso NEARBY_WIFI_DEVICES para
        // poder escanear dispositivos WiFi cercanos; sin concederlo en tiempo de
        // ejecución (declararlo en el manifest no basta), el descubrimiento de
        // Google Cast se bloquea en silencio. Se pide aquí, antes de inicializar
        // el contexto de Cast.
        if (Build.VERSION.SDK_INT >= 33 && !cordova.hasPermission(Manifest.permission.NEARBY_WIFI_DEVICES)) {
            cordova.requestPermission(this, REQUEST_NEARBY_WIFI_DEVICES, Manifest.permission.NEARBY_WIFI_DEVICES);
        }

        final Activity activity = cordova.getActivity();
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    castContext = CastContext.getSharedInstance(activity);

                    mediaRouteButton = new MediaRouteButton(activity);
                    ViewGroup content = activity.findViewById(android.R.id.content);
                    ViewGroup.LayoutParams params = new ViewGroup.LayoutParams(1, 1);
                    mediaRouteButton.setAlpha(0f);
                    content.addView(mediaRouteButton, params);
                    CastButtonFactory.setUpMediaRouteButton(activity.getApplicationContext(), mediaRouteButton);

                    castContext.addCastStateListener(castStateListener);
                    castContext.getSessionManager().addSessionManagerListener(sessionManagerListener, CastSession.class);
                } catch (Exception e) {
                    // Sin Play Services (p.ej. emulador sin Google APIs) u otro fallo de
                    // inicialización: el plugin se degrada en silencio de cara a la UI
                    // (como el resto de integraciones opcionales de esta app), pero se
                    // deja constancia en logcat para poder depurarlo.
                    Log.e(TAG, "No se pudo inicializar el contexto de Cast", e);
                    castContext = null;
                }
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQUEST_NEARBY_WIFI_DEVICES || castContext == null) return;
        // No hace falta reiniciar nada: el propio SDK retoma el escaneo solo en
        // cuanto el permiso está concedido. Se reenvía el estado actual sin más,
        // para que la UI no tenga que esperar al siguiente CastStateListener.
        cordova.getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                sendAvailability(castContext.getCastState() != CastState.NO_DEVICES_AVAILABLE);
            }
        });
    }

    @Override
    public void onDestroy() {
        if (castContext != null) {
            castContext.removeCastStateListener(castStateListener);
            castContext.getSessionManager().removeSessionManagerListener(sessionManagerListener, CastSession.class);
        }
    }

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) {
        switch (action) {
            case "isAvailable":
                callbackContext.success();
                return true;
            case "registerAvailabilityCallback":
                availabilityCallback = callbackContext;
                // El listener solo avisa de CAMBIOS de estado; si el dispositivo ya
                // estaba en la red antes de este registro, no llegaría ningún aviso,
                // así que se envía el estado actual aquí. Se hace vía runOnUiThread
                // (no directamente) porque esta llamada puede ejecutarse antes de que
                // termine el Runnable de pluginInitialize() que crea castContext (el
                // plugin se instancia de forma perezosa, en la primera llamada exec());
                // encolar en el hilo de UI garantiza que se ejecute después, ya que
                // Android procesa los Runnables de un mismo hilo en orden de llegada.
                cordova.getActivity().runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (castContext != null) {
                            sendAvailability(castContext.getCastState() != CastState.NO_DEVICES_AVAILABLE);
                        }
                    }
                });
                return true;
            case "registerSessionCallback":
                sessionCallback = callbackContext;
                return true;
            case "showCastPicker":
                showCastPicker();
                callbackContext.success();
                return true;
            case "loadMedia":
                loadMedia(args.optString(0, null), args.optString(1, ""), args.optString(2, "video/mp4"));
                callbackContext.success();
                return true;
            case "stop":
                stopCasting();
                callbackContext.success();
                return true;
            case "registerDlnaCallback":
                dlnaCallback = callbackContext;
                return true;
            case "startDlnaDiscovery":
                startDlnaDiscovery();
                callbackContext.success();
                return true;
            case "loadMediaDlna":
                loadMediaDlna(args.optString(0, null), args.optString(1, null),
                        args.optString(2, ""), args.optString(3, "video/mp4"));
                callbackContext.success();
                return true;
            case "stopDlna":
                stopDlna(args.optString(0, null));
                callbackContext.success();
                return true;
            default:
                return false;
        }
    }

    private void showCastPicker() {
        if (mediaRouteButton == null) return;
        cordova.getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                mediaRouteButton.performClick();
            }
        });
    }

    private void loadMedia(final String url, final String title, final String contentType) {
        if (castContext == null || url == null) return;
        cordova.getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                SessionManager sessionManager = castContext.getSessionManager();
                CastSession session = sessionManager.getCurrentCastSession();
                if (session == null) return;
                RemoteMediaClient remoteMediaClient = session.getRemoteMediaClient();
                if (remoteMediaClient == null) return;

                com.google.android.gms.cast.MediaMetadata metadata =
                        new com.google.android.gms.cast.MediaMetadata(com.google.android.gms.cast.MediaMetadata.MEDIA_TYPE_GENERIC);
                if (title != null && !title.isEmpty()) {
                    metadata.putString(com.google.android.gms.cast.MediaMetadata.KEY_TITLE, title);
                }

                MediaInfo mediaInfo = new MediaInfo.Builder(url)
                        .setStreamType(MediaInfo.STREAM_TYPE_LIVE)
                        .setContentType(contentType)
                        .setMetadata(metadata)
                        .build();
                remoteMediaClient.load(new MediaLoadRequestData.Builder()
                        .setMediaInfo(mediaInfo)
                        .setAutoplay(true)
                        .build());
            }
        });
    }

    private void stopCasting() {
        if (castContext == null) return;
        cordova.getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                castContext.getSessionManager().endCurrentSession(true);
            }
        });
    }

    private void startDlnaDiscovery() {
        dlnaDevices.clear();
        final Activity activity = cordova.getActivity();
        cordova.getThreadPool().execute(new Runnable() {
            @Override
            public void run() {
                DlnaDiscovery.discover(activity, new DlnaDiscovery.Listener() {
                    @Override
                    public void onDeviceFound(DlnaDevice device) {
                        dlnaDevices.put(device.id, device);
                        sendDlnaEvent("found", device.id, device.name);
                    }

                    @Override
                    public void onDiscoveryFinished() {
                        sendDlnaEvent("done", null, null);
                    }
                });
            }
        });
    }

    private void loadMediaDlna(final String deviceId, final String url, final String title, final String contentType) {
        final DlnaDevice device = deviceId != null ? dlnaDevices.get(deviceId) : null;
        if (device == null || url == null) return;
        cordova.getThreadPool().execute(new Runnable() {
            @Override
            public void run() {
                DlnaController.play(device.controlUrl, url, title, contentType);
            }
        });
    }

    private void stopDlna(final String deviceId) {
        final DlnaDevice device = deviceId != null ? dlnaDevices.get(deviceId) : null;
        if (device == null) return;
        cordova.getThreadPool().execute(new Runnable() {
            @Override
            public void run() {
                DlnaController.stop(device.controlUrl);
            }
        });
    }

    private void sendDlnaEvent(String type, String id, String name) {
        if (dlnaCallback == null) return;
        try {
            JSONObject evt = new JSONObject();
            evt.put("type", type);
            if (id != null) evt.put("id", id);
            if (name != null) evt.put("name", name);
            PluginResult result = new PluginResult(PluginResult.Status.OK, evt);
            result.setKeepCallback(true);
            dlnaCallback.sendPluginResult(result);
        } catch (JSONException ignored) {
            // No debería ocurrir: las claves son literales fijos.
        }
    }

    private String deviceName(CastSession session) {
        if (session == null || session.getCastDevice() == null) return "la TV";
        String name = session.getCastDevice().getFriendlyName();
        return name != null ? name : "la TV";
    }

    private void sendAvailability(boolean available) {
        if (availabilityCallback == null) return;
        PluginResult result = new PluginResult(PluginResult.Status.OK, available);
        result.setKeepCallback(true);
        availabilityCallback.sendPluginResult(result);
    }

    private void sendSessionState(String state, String deviceName) {
        if (sessionCallback == null) return;
        try {
            JSONObject evt = new JSONObject();
            evt.put("state", state);
            if (deviceName != null) evt.put("deviceName", deviceName);
            PluginResult result = new PluginResult(PluginResult.Status.OK, evt);
            result.setKeepCallback(true);
            sessionCallback.sendPluginResult(result);
        } catch (JSONException ignored) {
            // No debería ocurrir: las claves son literales fijos.
        }
    }
}
