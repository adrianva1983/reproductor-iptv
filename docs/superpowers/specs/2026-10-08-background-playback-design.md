# Reproducción en segundo plano (audio al bloquear pantalla)

## Problema

Actualmente, si el usuario bloquea la pantalla mientras reproduce un canal, Android puede cortar la red/CPU de la app (confirmado en esta misma sesión: política `APP_BACKGROUND` de Android bloquea las conexiones de red de apps que no están en primer plano ni tienen un *foreground service* activo). El resultado es que el audio se corta o el canal deja de funcionar al bloquear la pantalla.

## Alcance

Cubre únicamente: **el audio sigue sonando cuando el usuario bloquea/apaga la pantalla** mientras hay un canal reproduciéndose (como un reproductor de música). No cubre:
- Reproducción en segundo plano mientras se usa otra app con la pantalla encendida (multitarea).
- Picture-in-Picture (vídeo flotante).
- Controles de reproducción (play/pausa/stop) en la notificación — solo mantiene vivo el audio; la notificación es informativa y reabre la app al tocarla.

## Arquitectura

Se usa el plugin comunitario **`cordova-plugin-background-mode`** en vez de construir un servicio nativo propio. Este plugin ya resuelve exactamente el problema de raíz: arranca un *foreground service* de Android con una notificación persistente mientras está activo, lo que impide que el sistema congele la app (incluida su red), y además soporta iOS vía `UIBackgroundModes: audio`.

La activación está ligada a los eventos de ciclo de vida de Cordova, no al simple hecho de "hay un canal reproduciéndose":

- **Evento `pause`** (se dispara al bloquear la pantalla o cambiar de app): si hay un canal activo (`IPTVPlayer.isActive()` devuelve `true`), se llama a `cordova.plugins.backgroundMode.enable()`. Aparece la notificación persistente y el audio sigue sonando.
- **Evento `resume`** (el usuario vuelve a la app): se llama a `cordova.plugins.backgroundMode.disable()` incondicionalmente (es inocuo si no estaba activo). La notificación desaparece.

Así, mientras el usuario está activamente viendo el canal con la pantalla encendida, no hay ninguna notificación — solo aparece cuando realmente se va a segundo plano, tal como se pidió.

**Nota sobre iOS**: `cordova-plugin-background-mode` sí declara soporte iOS, pero no hay Mac disponible en este entorno para compilar/probarlo (misma limitación ya señalada para `cordova-plugin-ts-proxy`). La integración en `index.js` es la misma para ambas plataformas; solo queda sin verificar el comportamiento real en iOS hasta que se compile allí.

## Cambios de código

1. **`package.json`**: añadir dependencia `cordova-plugin-background-mode` e instalarla con `cordova plugin add cordova-plugin-background-mode`.
2. **`www/js/player.js`**: exponer `isActive: function () { return active; }` en el objeto `IPTVPlayer` devuelto (la variable interna `active` ya existe, solo falta exponerla en la API pública).
3. **`www/js/index.js`**: añadir, junto a los demás listeners de ciclo de vida:
   ```js
   document.addEventListener('pause', function () {
       if (window.IPTVPlayer.isActive() && window.cordova && cordova.plugins && cordova.plugins.backgroundMode) {
           cordova.plugins.backgroundMode.enable();
       }
   }, false);
   document.addEventListener('resume', function () {
       if (window.cordova && cordova.plugins && cordova.plugins.backgroundMode) {
           cordova.plugins.backgroundMode.disable();
       }
   }, false);
   ```
   Y una configuración de los textos de la notificación al arrancar (`cordova.plugins.backgroundMode.setDefaults({ title: 'Reproductor IPTV', text: 'Reproduciendo en segundo plano', ... })`), dentro de `bindBackButton()`/`start()` o una función de inicialización equivalente.

## Manejo de errores

Todas las llamadas comprueban la existencia de `window.cordova`, `cordova.plugins` y `cordova.plugins.backgroundMode` antes de usarlos. Si el plugin no está disponible (navegador de escritorio, o falta instalarlo en alguna plataforma), el código se degrada silenciosamente al comportamiento actual, sin lanzar errores ni romper el resto de la app.

## Testing

No es testeable con el test runner de Node (`test/m3u.test.js` cubre solo el parser M3U; esta funcionalidad depende del ciclo de vida real de Android/iOS). Validación manual en dispositivo:

1. Reproducir un canal.
2. Bloquear la pantalla.
3. Confirmar que el audio sigue sonando y aparece la notificación persistente.
4. Desbloquear la pantalla.
5. Confirmar que la notificación desaparece y la app sigue funcionando con normalidad.

## Limitación conocida a documentar en el README

En MIUI (y otras capas Android agresivas con la gestión de batería) puede ser necesario que el usuario desactive manualmente la optimización de batería para esta app (Ajustes > Apps > Reproductor IPTV > Batería > Sin restricciones) para que el *foreground service* sobreviva de forma fiable a largo plazo. Se añade esta nota junto a las demás limitaciones conocidas ya documentadas (CORS, contenido mixto, etc.).

## Addendum (2026-10-09): lo que el plan original no cubría

Validado en dispositivo real (Xiaomi/MIUI) que el plan de arriba (foreground service ligado a `pause`/`resume`) **no era suficiente**. Se encontraron dos problemas adicionales, en este orden:

### 1. MIUI mata el audio aunque el foreground service esté activo

Con el foreground service y el wakelock correctamente activos, el audio seguía cortándose. El log del dispositivo mostró que el subsistema `SmartPower` de MIUI marca el audio como "recurso inactivo" (`R(resource inactive ... audio)`) y lo corta, porque la reproducción no estaba respaldada por una `MediaSession` de Android reconocida.

**Fix**: `cordova-plugin-background-mode-patched/src/android/ForegroundService.java` ahora crea una `MediaSession` (API nativa, sin dependencias nuevas — `minSdkVersion` del proyecto es 24, `MediaSession` existe desde API 21) con `PlaybackState.STATE_PLAYING` mientras el modo está activo, y la enlaza a la notificación vía `Notification.MediaStyle`. Sin controles de reproducción (el alcance sigue siendo solo informativo). Ver `cordova-plugin-background-mode-patched/CHANGELOG.md`.

### 2. El problema real: Android suspende el decodificador de vídeo al bloquear pantalla

Confirmado con logs: al bloquear la pantalla, el `<video>` HTML5 pierde su `MediaCodec` casi de inmediato (`Codec released` / `MediaCodec::~MediaCodec()`), **independientemente** de a qué elemento (`<video>` o `<audio>`) esté enlazado el `MediaSource` — es una política de ahorro de energía de Chromium al detectar la página oculta (`visible->invisible`), no algo ligado a la superficie de render. Como vídeo y audio van por el mismo pipeline de decodificación, el audio se corta con el vídeo. Ni el foreground service ni la `MediaSession` del punto 1 pueden evitar esto: actúan a nivel de proceso/sistema, no a nivel del decodificador de un elemento de medios concreto.

La única forma de que el audio sobreviva es que el `MediaSource` **nunca tenga un SourceBuffer de vídeo**, para que el motor no tenga nada que decodificar ni que suspender.

**Fix aplicado (parcial, solo canales `.ts`)**: fork propio de mpegts.js (`mpegts.js-patched/`, ver su `CHANGELOG-fork.md`) con una opción de configuración `audioOnly` que hace que `appendInitSegment()`/`appendMediaSegment()` descarten los segmentos de tipo `video` sin crear nunca su `SourceBuffer`. En `www/js/player.js`, `enterBackground()`/`exitBackground()` reconectan el canal en este modo sobre un `<audio>` oculto al bloquear pantalla (solo para canales tipo `ts`, servidos por mpegts.js), y reinician la reproducción normal con vídeo al volver a la app.

Validado en dispositivo real: sin el parche, el audio se cortaba de forma consistente a los 5-8 segundos de bloquear la pantalla. Con el parche, se probó con la pantalla bloqueada 30+ segundos sin cortes, y la vuelta a primer plano reinicia el vídeo limpiamente.

**Pendiente, no cubierto**: canales `.m3u8` (hls.js) y HLS nativo en iOS. Se intentó primero una vía más barata — reasignar la misma instancia de hls.js de `<video>` a un `<audio>` oculto sin recrear el stream — pero no funcionó (mismo patrón de corte, confirmado en log), lo cual tiene sentido dado que el punto 2 de arriba ya explica que el problema no depende del elemento. Parchear hls.js de la misma forma que mpegts.js es posible en teoría (mismo principio: nunca crear el SourceBuffer de vídeo), pero su `BufferController` es mucho más complejo que el `MSEController` de mpegts.js (gestiona ABR, múltiples niveles, fragmentos, pistas de audio alternativas) y es la misma instancia que sirve la reproducción normal en primer plano — parchearlo mal podría romper la reproducción normal, no solo el modo en segundo plano. Se decidió no abordarlo en esta iteración.
