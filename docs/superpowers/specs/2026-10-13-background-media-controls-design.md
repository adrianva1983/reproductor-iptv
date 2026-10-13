# Controles de pausa/reproducir en la notificación de segundo plano

## Problema

`cordova-plugin-background-mode-patched` ya mantiene vivo el audio en segundo plano para canales `.ts` (ver `docs/superpowers/specs/2026-10-08-background-playback-design.md`), con una `MediaSession` en `ForegroundService.java` vinculada a la notificación vía `Notification.MediaStyle`. Pero esa `MediaSession` está a medias: se crea en estado `STATE_PLAYING` fijo, sin acciones (`ACTION_PLAY`/`ACTION_PAUSE`) ni un `MediaSession.Callback` que reciba una pulsación. El resultado es una notificación con pinta de reproductor pero sin botón que funcione, y con un título/texto fijo ("Reproductor IPTV" / "Reproduciendo en segundo plano") que no dice qué canal suena.

El usuario quiere que esa notificación se comporte como la de cualquier reproductor de audio: botón de pausa/reproducir funcional y el nombre del canal como título.

## Alcance

- Botón de pausa/reproducir en la notificación de segundo plano (sin botón de detener aparte).
- Título de la notificación con el nombre del canal actual en vez del texto genérico.
- Solo tiene efecto audible en canales `.ts` (mpegts.js en modo `audioOnly`), que es el único caso que sobrevive hoy al bloqueo de pantalla. En canales HLS/HLS nativo el audio ya se corta al bloquear la pantalla antes de que el usuario pueda usar el botón — limitación heredada, no se aborda aquí.
- Reabrir la app siempre vuelve a reproducir en primer plano desde el directo actual, esté la notificación en pausa o reproduciendo en ese momento — no se añade un estado "pausado" al reproductor en pantalla.

No cubre:

- Arreglar que el audio sobreviva al bloqueo en canales HLS/HLS nativo (limitación ya documentada en la spec de background-playback).
- Controles de siguiente/anterior canal, ni "seek" hacia atrás al reanudar (no tiene sentido en directo).
- El bug de corte espontáneo del audio en segundo plano al cabo de un rato, reportado por el usuario — es un problema aparte, pendiente de investigar con logcat.

## Diseño

### Arquitectura: quién habla con quién

```
Notificación (botón pausa/play)
        │ toque
        ▼
MediaSession.Callback (ForegroundService.java)
   - actualiza PlaybackState (PLAYING ⇄ PAUSED) → el icono de la notificación
     cambia al instante, sin esperar confirmación del JS (actualización
     "optimista", estándar en este tipo de notificaciones)
   - avisa a BackgroundMode.java, que reenvía el evento a JS reutilizando el
     mismo mecanismo que ya usa para 'activate'/'deactivate' (webView.loadUrl
     + el pub-sub cordova.plugins.backgroundMode.on/fireEvent, ya
     implementado en www/background-mode.js)
        │
        ▼
www/js/index.js: bgMode.on('mediapause', ...) / bgMode.on('mediaplay', ...)
        │
        ▼
www/js/player.js: pauseBackgroundAudio() / resumeBackgroundAudio()
```

### Cambios nativos (`cordova-plugin-background-mode-patched`)

- `ForegroundService.java`: la `MediaSession` pasa a declarar `setActions(ACTION_PLAY | ACTION_PAUSE)` en su `PlaybackState`, y se le añade un `MediaSession.Callback` con `onPause()`/`onPlay()`. Cada uno:
  1. Reconstruye el `PlaybackState` con el nuevo estado (`STATE_PAUSED`/`STATE_PLAYING`) y refresca la notificación (el icono cambia).
  2. Notifica al listener registrado (ver abajo) para que el aviso llegue al JS.
- Se añade una interfaz pequeña `MediaControlListener` (con `onMediaPause()`/`onMediaPlay()`) que `BackgroundMode.java` implementa y registra en el servicio justo cuando se enlaza (`onServiceConnected`, donde ya se obtiene la instancia del servicio). La implementación en `BackgroundMode.java` dispara el evento a JS con el mismo patrón que ya usa `fireEvent()` (`webView.loadUrl("javascript:cordova.plugins.backgroundMode.fireEvent('mediapause');")`, y análogo para `'mediaplay'`).
- El nombre del canal no necesita cambios nativos: `cordova.plugins.backgroundMode.configure({title: ...})` ya existe en el plugin (`www/background-mode.js`) y actualiza la notificación en caliente mientras está activa. Solo falta que el JS lo llame.

### Cambios en `www/js/player.js`

- Se extrae la lógica de creación del reproductor de audio en segundo plano (hoy solo dentro de `enterBackground()`) a una función interna reutilizable, p. ej. `startBackgroundAudio()`.
- Nuevo estado interno `backgroundPaused` (además del `backgroundAudioOnly` ya existente).
- `pauseBackgroundAudio()`: si hay audio de fondo activo, destruye el reproductor mpegts (corta red y decodificación — no se deja "pausado" acumulando buffer sin límite) y marca `backgroundPaused = true`.
- `resumeBackgroundAudio()`: si `inBackground && backgroundPaused`, vuelve a llamar a `startBackgroundAudio()` (reconexión limpia al directo actual) y limpia `backgroundPaused`.
- `enterBackground()` pasa a llamar a `startBackgroundAudio()` en vez de tener la lógica inline (mismo comportamiento que hoy, solo reorganizado).
- Se exponen `pauseBackgroundAudio`/`resumeBackgroundAudio` en `root.IPTVPlayer`.

### Cambios en `www/js/index.js`

- `bindBackgroundMode()`:
  - En el handler de `document.addEventListener('pause', ...)` (ya existente, se dispara al entrar en segundo plano): tras `bgMode.enable()` y `IPTVPlayer.enterBackground()`, llama a `bgMode.configure({title: state.current.name})` (o el campo que use el nombre del canal en `state.current`) para que el título de la notificación muestre el canal.
  - Se añaden `bgMode.on('mediapause', function () { window.IPTVPlayer.pauseBackgroundAudio(); })` y `bgMode.on('mediaplay', function () { window.IPTVPlayer.resumeBackgroundAudio(); })`.

### Casos límite

- Canal HLS/HLS nativo: el audio ya está cortado antes de que el usuario pueda tocar el botón; tocarlo no tiene nada que controlar (no se intenta detectar este caso para ocultar el botón — añadiría complejidad para un efecto cosmético menor).
- Fallo de red al reanudar desde la notificación (igual que hoy en `enterBackground()`): si falla, el error se ignora igual que ahora y el audio se queda en silencio; la notificación puede quedar mostrando "reproduciendo" aunque no suene — limitación aceptada para esta primera versión, no se añade reintento ni confirmación de vuelta a nativo.
- Reabrir la app mientras está en pausa por notificación: `exitBackground()` no cambia — siempre reconecta y reproduce en primer plano desde el directo, igual que si no se hubiera pausado.

## Testing

No es testeable con el runner de Node (es código nativo Android + interacción con notificaciones del sistema). Validación manual en el dispositivo ya usado en esta sesión:

1. Reproducir un canal `.ts`, bloquear la pantalla, abrir la notificación: el título muestra el nombre del canal.
2. Tocar pausa en la notificación: el audio se corta y el icono cambia a "reproducir".
3. Tocar reproducir: el audio vuelve (enganchado al directo actual, no al punto exacto de la pausa).
4. Repetir pausa/reproducir varias veces seguidas sin reabrir la app.
5. Reabrir la app estando en pausa por notificación: vuelve a reproducir en primer plano con normalidad.
6. Probar con un canal HLS: confirmar que el comportamiento (audio cortado al bloquear) no empeora respecto a hoy.
