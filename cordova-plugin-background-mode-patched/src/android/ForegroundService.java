/*
 Copyright 2013 Sebastián Katzer

 Licensed to the Apache Software Foundation (ASF) under one
 or more contributor license agreements.  See the NOTICE file
 distributed with this work for additional information
 regarding copyright ownership.  The ASF licenses this file
 to you under the Apache License, Version 2.0 (the
 "License"); you may not use this file except in compliance
 with the License.  You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing,
 software distributed under the License is distributed on an
 "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 KIND, either express or implied.  See the License for the
 specific language governing permissions and limitations
 under the License.
 */

package de.appplant.cordova.plugin.background;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.Resources;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.app.NotificationChannel;

import org.json.JSONObject;

import static android.os.PowerManager.PARTIAL_WAKE_LOCK;

/**
 * Puts the service in a foreground state, where the system considers it to be
 * something the user is actively aware of and thus not a candidate for killing
 * when low on memory.
 */
public class ForegroundService extends Service {

    // Fixed ID for the 'foreground' notification
    public static final int NOTIFICATION_ID = -574543954;

    // Default title of the background notification
    private static final String NOTIFICATION_TITLE =
            "App is running in background";

    // Default text of the background notification
    private static final String NOTIFICATION_TEXT =
            "Doing heavy tasks.";

    // Default icon of the background notification
    private static final String NOTIFICATION_ICON = "icon";

    // Binder given to clients
    private final IBinder binder = new ForegroundBinder();

    // Acción custom para el botón de pausa/reproducir de la notificación
    // (ver makeNotification() y toggleReceiver más abajo).
    private static final String ACTION_TOGGLE_PLAYBACK =
            "de.appplant.cordova.plugin.background.TOGGLE_PLAYBACK";

    // Permite avisar a BackgroundMode (y de ahí al JS) cuando se toca el
    // botón de pausa/reproducir de la notificación.
    public interface MediaControlListener {
        void onMediaPause();
        void onMediaPlay();
    }

    private MediaControlListener mediaControlListener;

    public void setMediaControlListener(MediaControlListener listener) {
        this.mediaControlListener = listener;
    }

    // Estado mostrado en el botón de la notificación; no es necesariamente
    // el estado real de reproducción en el WebView, solo lo que se le pidió
    // mostrar/alternar la última vez.
    private boolean isPlayingState = true;

    private final BroadcastReceiver toggleReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            togglePlayback();
        }
    };

    // Partial wake lock to prevent the app from going to sleep when locked
    private PowerManager.WakeLock wakeLock;

    // Fix: sin una MediaSession activa en estado PLAYING, algunos fabricantes
    // (confirmado en MIUI: su "SmartPower" marca el audio como "recurso
    // inactivo" ~5s tras bloquear la pantalla y lo corta, aunque el foreground
    // service y el wakelock sigan vivos) no reconocen esto como reproducción
    // de medios legítima y cortan el AudioTrack. Se registra aquí, no para dar
    // controles (el alcance del plugin sigue siendo solo informativo), sino
    // como señal al sistema de que hay audio en curso.
    private MediaSession mediaSession;

    /**
     * Allow clients to call on to the service.
     */
    @Override
    public IBinder onBind (Intent intent) {
        return binder;
    }

    /**
     * Class used for the client Binder.  Because we know this service always
     * runs in the same process as its clients, we don't need to deal with IPC.
     */
    class ForegroundBinder extends Binder
    {
        ForegroundService getService()
        {
            // Return this instance of ForegroundService
            // so clients can call public methods
            return ForegroundService.this;
        }
    }

    /**
     * Put the service in a foreground state to prevent app from being killed
     * by the OS.
     */
    @Override
    public void onCreate()
    {
        super.onCreate();
        // Fix: Android 13+ (API 33+) exige indicar explícitamente
        // RECEIVER_EXPORTED/RECEIVER_NOT_EXPORTED en todo registerReceiver()
        // dinámico; sin ello lanza SecurityException y tira abajo el
        // servicio (y con él, el proceso entero) en cuanto se intenta crear.
        // Este receiver es solo para el botón de nuestra propia notificación,
        // nunca debe aceptar el broadcast de otra app.
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(toggleReceiver, new IntentFilter(ACTION_TOGGLE_PLAYBACK),
                    Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(toggleReceiver, new IntentFilter(ACTION_TOGGLE_PLAYBACK));
        }
        keepAwake();
    }

    /**
     * No need to run headless on destroy.
     */
    @Override
    public void onDestroy()
    {
        super.onDestroy();
        sleepWell();
        try {
            unregisterReceiver(toggleReceiver);
        } catch (IllegalArgumentException ignored) {
            // No estaba registrado (p.ej. si onCreate falló antes de registrarlo).
        }
    }

    /**
     * Prevent Android from stopping the background service automatically.
     */
    @Override
    public int onStartCommand (Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    /**
     * Put the service in a foreground state to prevent app from being killed
     * by the OS.
     */
    @SuppressLint("WakelockTimeout")
    private void keepAwake()
    {
        JSONObject settings = BackgroundMode.getSettings();
        boolean isSilent    = settings.optBoolean("silent", false);

        mediaSession = new MediaSession(getApplicationContext(), "cordova-plugin-background-mode");
        isPlayingState = true;
        updatePlaybackState();
        mediaSession.setActive(true);

        if (!isSilent) {
            startForeground(NOTIFICATION_ID, makeNotification());
        }

        PowerManager pm = (PowerManager)getSystemService(POWER_SERVICE);

        wakeLock = pm.newWakeLock(
                PARTIAL_WAKE_LOCK, "backgroundmode:wakelock");

        wakeLock.acquire();
    }

    /**
     * Invoked when the user taps the pause/play action of the notification.
     * Flips the shown state, redraws the notification and tells the
     * registered listener (BackgroundMode, which relays it to the JS side)
     * so the real playback actually pauses/resumes.
     */
    private void togglePlayback()
    {
        isPlayingState = !isPlayingState;
        updatePlaybackState();
        updateNotification(BackgroundMode.getSettings());

        if (mediaControlListener != null) {
            if (isPlayingState) {
                mediaControlListener.onMediaPlay();
            } else {
                mediaControlListener.onMediaPause();
            }
        }
    }

    /**
     * Updates the MediaSession's PlaybackState to match isPlayingState.
     */
    private void updatePlaybackState()
    {
        if (mediaSession == null) return;

        int state = isPlayingState
                ? PlaybackState.STATE_PLAYING
                : PlaybackState.STATE_PAUSED;

        mediaSession.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE)
                .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                .build());
    }

    /**
     * Stop background mode.
     */
    private void sleepWell()
    {
        stopForeground(true);
        getNotificationManager().cancel(NOTIFICATION_ID);

        if (wakeLock != null) {
            wakeLock.release();
            wakeLock = null;
        }

        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
    }

    /**
     * Create a notification as the visible part to be able to put the service
     * in a foreground state by using the default settings.
     */
    private Notification makeNotification()
    {
        return makeNotification(BackgroundMode.getSettings());
    }

    /**
     * Create a notification as the visible part to be able to put the service
     * in a foreground state.
     *
     * @param settings The config settings
     */
    private Notification makeNotification (JSONObject settings)
    {
        // use channelid for Oreo and higher
        String CHANNEL_ID = "cordova-plugin-background-mode-id";
        if(Build.VERSION.SDK_INT >= 26){
        // The user-visible name of the channel.
        CharSequence name = "cordova-plugin-background-mode";
        // The user-visible description of the channel.
        String description = "cordova-plugin-background-moden notification";

        // Fix: con importance LOW, Android sustituye el contenido real de la
        // notificación por un texto genérico ("X se está ejecutando. Toca
        // para...") cuando el foreground service arranca con la app ya en
        // segundo plano (nuestro caso: se arranca justo al entrar en
        // segundo plano) — confirmado en dispositivo real (API 36): el
        // propio canal, título y acciones se pierden sin ningún error. Es
        // una restricción de transparencia de Android para servicios en
        // primer plano iniciados en segundo plano con canales de
        // importancia baja; DEFAULT evita la sustitución y es coherente con
        // mostrar controles de reproducción reales.
        int importance = NotificationManager.IMPORTANCE_DEFAULT;

        NotificationChannel mChannel = new NotificationChannel(CHANNEL_ID, name,importance);

        // Configure the notification channel.
        mChannel.setDescription(description);

        getNotificationManager().createNotificationChannel(mChannel);
        }
        String title    = settings.optString("title", NOTIFICATION_TITLE);
        String text     = settings.optString("text", NOTIFICATION_TEXT);
        boolean bigText = settings.optBoolean("bigText", false);

        Context context = getApplicationContext();
        String pkgName  = context.getPackageName();
        Intent intent   = context.getPackageManager()
                .getLaunchIntentForPackage(pkgName);

        Notification.Builder notification = new Notification.Builder(context)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setSmallIcon(getIconResId(settings));

        if(Build.VERSION.SDK_INT >= 26){
                   notification.setChannelId(CHANNEL_ID);
        }

        if (settings.optBoolean("hidden", true)) {
            notification.setPriority(Notification.PRIORITY_MIN);
        }

        if (bigText || text.contains("\n")) {
            notification.setStyle(
                    new Notification.BigTextStyle().bigText(text));
        } else if (mediaSession != null) {
            int toggleIcon = isPlayingState
                    ? android.R.drawable.ic_media_pause
                    : android.R.drawable.ic_media_play;
            String toggleLabel = isPlayingState ? "Pausar" : "Reproducir";
            PendingIntent togglePendingIntent = PendingIntent.getBroadcast(
                    context, 0, new Intent(ACTION_TOGGLE_PLAYBACK),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            notification.addAction(new Notification.Action.Builder(
                    toggleIcon, toggleLabel, togglePendingIntent).build());

            notification.setStyle(
                    new Notification.MediaStyle()
                            .setMediaSession(mediaSession.getSessionToken())
                            .setShowActionsInCompactView(0));
        }

        setColor(notification, settings);

        if (intent != null && settings.optBoolean("resume")) {
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            // Fix: Android 12+ (API 31+) exige FLAG_IMMUTABLE o FLAG_MUTABLE; su ausencia
            // hace crashear el servicio al llamar a enable() (upstream sin corregir en 0.7.3).
            PendingIntent contentIntent = PendingIntent.getActivity(
                    context, NOTIFICATION_ID, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);


            notification.setContentIntent(contentIntent);
        }

        return notification.build();
    }

    /**
     * Update the notification.
     *
     * @param settings The config settings
     */
    protected void updateNotification (JSONObject settings)
    {
        boolean isSilent = settings.optBoolean("silent", false);

        if (isSilent) {
            stopForeground(true);
            return;
        }

        Notification notification = makeNotification(settings);
        getNotificationManager().notify(NOTIFICATION_ID, notification);

    }

    /**
     * Retrieves the resource ID of the app icon.
     *
     * @param settings A JSON dict containing the icon name.
     */
    private int getIconResId (JSONObject settings)
    {
        String icon = settings.optString("icon", NOTIFICATION_ICON);

        int resId = getIconResId(icon, "mipmap");

        if (resId == 0) {
            resId = getIconResId(icon, "drawable");
        }

        return resId;
    }

    /**
     * Retrieve resource id of the specified icon.
     *
     * @param icon The name of the icon.
     * @param type The resource type where to look for.
     *
     * @return The resource id or 0 if not found.
     */
    private int getIconResId (String icon, String type)
    {
        Resources res  = getResources();
        String pkgName = getPackageName();

        int resId = res.getIdentifier(icon, type, pkgName);

        if (resId == 0) {
            resId = res.getIdentifier("icon", type, pkgName);
        }

        return resId;
    }

    /**
     * Set notification color if its supported by the SDK.
     *
     * @param notification A Notification.Builder instance
     * @param settings A JSON dict containing the color definition (red: FF0000)
     */
    @TargetApi(Build.VERSION_CODES.LOLLIPOP)
    private void setColor (Notification.Builder notification, JSONObject settings)
    {

        String hex = settings.optString("color", null);

        if (Build.VERSION.SDK_INT < 21 || hex == null)
            return;

        try {
            int aRGB = Integer.parseInt(hex, 16) + 0xFF000000;
            notification.setColor(aRGB);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    /**
     * Returns the shared notification service manager.
     */
    private NotificationManager getNotificationManager()
    {
        return (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    }
}
