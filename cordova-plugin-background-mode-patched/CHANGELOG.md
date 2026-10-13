## ChangeLog

#### Version 0.7.3-patch1 (fork local, reproductor-iptv)
Fork local del paquete npm original (sin publicar), vendorizado en este repo
porque la versión 0.7.3 (la más reciente disponible) sigue sin corregir un
crash conocido en Android 12+ (API 31+): `ForegroundService.makeNotification()`
crea un `PendingIntent` sin `FLAG_IMMUTABLE`/`FLAG_MUTABLE`, obligatorio desde
esa versión de Android, lo que hace crashear el proceso de la app entera al
llamar a `backgroundMode.enable()`. Se corrige añadiendo `FLAG_IMMUTABLE`.

Además, Android 14+ (API 34+) exige declarar `android:foregroundServiceType`
en el `<service>` del manifest junto con el permiso específico de ese tipo
(aquí, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, además del genérico
`FOREGROUND_SERVICE`); sin ello, `enable()` lanza `SecurityException`. Se
corrige en `plugin.xml` añadiendo `foregroundServiceType="mediaPlayback"` y
ambos permisos.

Además, confirmado en dispositivo real (MIUI): el foreground service y el
wakelock arrancan correctamente al bloquear la pantalla, pero el audio se
corta ~5s después porque el subsistema `SmartPower` de MIUI marca el audio
como "recurso inactivo" (`R(resource inactive ... audio)` en logcat) y llama
a `AudioTrack.stop()`. Esto ocurre porque el servicio no registra ninguna
`MediaSession` activa, que es la señal estándar de Android (y la que miran
los gestores de batería agresivos de fabricantes) para reconocer que hay una
reproducción de medios legítima en curso. Se corrige en `ForegroundService`
creando una `MediaSession` con `PlaybackState.STATE_PLAYING` mientras el modo
está activo, y enlazándola a la notificación vía `Notification.MediaStyle`
(sin añadir controles de reproducción: el alcance sigue siendo solo
informativo). No requiere ninguna dependencia nueva porque usa las clases de
plataforma (`android.media.session.*`, disponibles desde API 21; el
`minSdkVersion` del proyecto es 24).

#### Version 0.7.3 (07.08.2019)
This is more a "just publish all changes after long time" release.
- [___change___:] Removed code for Windows 10 Mobile
- [feature:] Check if screen is off on Android
- [feature:] Wake-up device on Android
- [feature:] Unlock device on Android
- [bugfix:] Plugin not working for Android 8
- [bugfix:] Cannot install plugin on cordova > 9
- [bugfix:] Function `onactivate` does no longer exist

#### Version 0.7.2 (02.02.2017)
- Fixed app freeze on iOS using wkwebview-engine
- Websocket sample in SampleApp

#### Version 0.7.1 (30.01.2017)
- Bug fixes for iOS9 and Android
- Allow app to be excluded from recent list on Android

#### Version 0.7.0 (27.01.2017)
- __Features__
 - Support for tAmazon FireOS
 - Support for the browser platform
 - Ability to configure icon and color on Android
 - Allow app to move to foreground on Android
 - Allow app to move to background on Android
 - Allow app to override back button behaviour on Android
 - New events for when the mode has been enabled/disabled
- __Improvements__
 - Various enhancements and bug fixes for all platforms
 - Support for latest platform and OS versions
 - Multi line text on Android
 - Multiple listeners for same event
 - Compatibility with cordova-plugin-geolocation
 - Compatibility with cordova-plugin-crosswalk-webview
 - Compatibility with cordova-plugin-wkwebview-engine
 - New sample app
- __Fixes__
 - Silent mode issues on Android
 - Lock screen issues on Android
 - Callback not called on Android  
 - Notification shows app info with cordova-android@6
 - Other apps audio interruption on iOS
- __Changes__
 - Deprecate event callbacks
 - Notification not visible by default on lock screen
 - Remove ticker property on Android
 - Remove unexpected back button handler
 - Remove support for wp8 platform

#### Version 0.6.5 (29.02.2016)
- Published on npm
- Updated dependency ID for the device plug-in

#### Version 0.6.4 (03.03.2015)
- Resolve possibly dependency conflict

#### Version 0.6.3 (01.01.2015)
- [feature:] Silent mode for Android

#### Version 0.6.2 (14.12.2014)
- [bugfix:] Type error
- [bugfix:] Wrong default values for `isEnabled` and `isActive`.

#### Version 0.6.1 (14.12.2014)
- [enhancement:] Set default settings through `setDefaults`.
- [enhancement:] New method `isEnabled` to receive if mode is enabled.
- [enhancement:] New method `isActive` to receive if mode is active.
- [bugfix:] Events caused thread collision.


#### Version 0.6.0 (14.12.2014)
- [feature:] Android support
- [feature:] Change Android notification through `configure`.
- [feature:] `onactivate`, `ondeactivate` and `onfailure` callbacks.
- [___change___:] Disabled by default
- [enhancement:] Get default settings through `getDefaults`.
- [enhancement:] iOS does not require user permissions, internet connection and geo location anymore.

#### Version 0.5.0 (13.02.2014)
- __retired__

#### Version 0.4.1 (13.02.2014)
- Release under the Apache 2.0 license.
- [enhancement:] Location tracking is only activated on WP8 if the location service is available.
- [bigfix:] Nullpointer exception on WP8.

#### Version 0.4.0 (10.10.2013)
- Added WP8 support<br>
  The plugin turns the app into an location tracking app *(for the time it runs in the background)*.

#### Version 0.2.1 (09.10.2013)
- Added js interface to manually enable/disable the background mode.

#### Version 0.2.0 (08.10.2013)
- Added iOS (>= 5) support<br>
  The plugin turns the app into an location tracking app for the time it runs in the background.
