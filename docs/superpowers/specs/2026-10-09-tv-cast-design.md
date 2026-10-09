# Enviar canal a TV (Google Cast)

## Problema

La app solo reproduce en el propio dispositivo. El usuario quiere poder enviar el canal que está viendo a un televisor (Chromecast, Android TV, o cualquier TV con Google Cast integrado) en la misma red.

## Alcance

Cubre únicamente:

- Un botón de Cast en el reproductor que abre el selector nativo de dispositivos del SDK de Google Cast.
- Al conectar, el canal activo se carga directamente en el TV (el TV se conecta a la URL del stream por su cuenta).
- Mientras dura la sesión de Cast, cambiar de canal en la app también lo envía al TV (reemplaza lo que suena).
- Un botón "Dejar de enviar" para terminar la sesión y volver a reproducción local.

No cubre (fuera de alcance para esta iteración):

- Controles remotos de reproducción (play/pausa/seek) sincronizados entre la app y el TV. Elegir el canal en la app y que empiece a sonar en el TV ya cuenta como "enviar"; no hay panel de control remoto tipo Spotify Connect.
- Receptor de Cast personalizado (branding, UI en el TV). Se usa el "Default Media Receiver" de Google (app ID `CC1AD845`), el mismo que usan la mayoría de apps que no necesitan una pantalla de TV a medida.
- Canales tipo `.ts` (ver más abajo, "Canales enviables").
- DLNA/UPnP y AirPlay. Solo Google Cast.

## Canales enviables

El Chromecast (el "Default Media Receiver") no reproduce MPEG-TS crudo, solo HLS/DASH/MP4. Además, los canales `.ts` de esta app a veces pasan por un proxy CORS local (`cordova-plugin-ts-proxy`, sirve en `127.0.0.1` del propio móvil) que el TV no puede alcanzar.

Por tanto, el botón de Cast solo se muestra cuando el canal activo tiene `type !== 'ts'` (es decir, `hls` o nativo/directo). Para canales `.ts`, el botón de Cast no aparece — ninguna promesa de funcionalidad que vaya a fallar.

Nuevo helper en `www/js/player.js` (o `www/js/m3u.js`, junto a la detección de tipo):

```js
function isCastable(channel) {
    return !!channel && channel.type !== 'ts';
}
```

## Arquitectura

**Plugin nativo nuevo**: `cordova-plugin-tv-cast/`, vendorizado en el repo igual que `cordova-plugin-ts-proxy/` (plugin propio y acotado, no una dependencia de terceros). Envuelve el SDK de Google Cast:

- Android: `com.google.android.gms:play-services-cast-framework` (`CastContext`, `CastSession`, `RemoteMediaClient`). El selector de dispositivos y el diálogo de conexión los proporciona el propio SDK (`MediaRouteButton`/`CastButtonFactory`), no hay que construir esa UI.
- iOS: SDK de Cast vía CocoaPods (`GCKCastContext`, `GCKUICastButton`).

### API JS expuesta (`cordova.plugins.tvCast`)

| Método | Descripción |
|---|---|
| `isAvailable(callback)` | Si el plugin está disponible en esta build (Android/iOS) |
| `onAvailabilityChanged(callback)` | Se dispara cuando aparecen/desaparecen dispositivos Cast en la red |
| `showCastPicker()` | Abre el selector nativo de dispositivos |
| `loadMedia(url, { title, contentType })` | Carga/reemplaza el stream en el TV conectado |
| `stop()` | Termina la sesión de Cast |
| `onSessionStateChanged(callback)` | Eventos `connecting` / `connected` / `disconnected`, con el nombre del dispositivo conectado |

`contentType` se calcula a partir del tipo de canal: `application/x-mpegURL` para `hls`, o el tipo MIME apropiado para streams directos (`video/mp4` por defecto).

La reconexión automática a una sesión de Cast ya activa (si el usuario cierra y reabre la app) la gestiona el propio SDK de Cast — no hay que implementarla a mano.

## Cambios de código

1. **`cordova-plugin-tv-cast/`**: plugin nuevo (plugin.xml + código nativo Android/iOS + `www/tv-cast.js`), siguiendo la estructura de `cordova-plugin-ts-proxy/`.
2. **`package.json`**: añadir `cordova-plugin-tv-cast` a `cordova.plugins` y como dependencia `file:cordova-plugin-tv-cast`.
3. **`www/js/player.js`**: función `isCastable(channel)`; cuando se conecta una sesión de Cast, pausar/liberar el `<video>` local para no reproducir a la vez en el móvil y en el TV.
4. **`www/js/index.js`**:
   - Icono de Cast en la barra del reproductor (junto a favorito/pantalla completa), visible solo si `cordova.plugins.tvCast` existe, `onAvailabilityChanged` indica que hay dispositivo, y `isCastable(canal activo)`.
   - Al pulsar: `tvCast.showCastPicker()`.
   - En `onSessionStateChanged('connected', device)`: ocultar el `<video>`, mostrar "Reproduciendo en «device.name»" y un botón "Dejar de enviar"; llamar a `loadMedia()` con la URL directa del canal (no la del proxy).
   - Si se cambia de canal mientras está conectado: llamar a `loadMedia()` con el nuevo canal en vez de a `IPTVPlayer.play()`.
   - En `onSessionStateChanged('disconnected')` (botón "Dejar de enviar", corte de red, o el usuario apaga el TV): volver a reproducción local llamando a `IPTVPlayer.play(canal activo)`.
5. **`config.xml`**: sin cambios directos; los permisos y metadatos de Cast los inyecta el propio `plugin.xml` del nuevo plugin (patrón ya usado por `network_security_config.xml` vía `cordova-plugin-background-mode-patched`).

## Configuración y permisos

- **Android**: permisos `ACCESS_WIFI_STATE` y `CHANGE_WIFI_MULTICAST_STATE` (necesarios para el descubrimiento de dispositivos Cast por mDNS), inyectados vía `plugin.xml`.
- **iOS**: `NSBonjourServices` (`_googlecast._tcp`) y `NSLocalNetworkUsageDescription` en `Info.plist` — iOS pedirá permiso de red local la primera vez que se use Cast, igual que con AirPlay.

## Manejo de errores

- Si el receptor del TV no puede cargar el stream (un canal se cuela pese al filtro `isCastable`, por ejemplo): se trata como un error de reproducción normal existente (mensaje + botón Reintentar) y se vuelve a reproducción local.
- Si la sesión se corta sola (pérdida de red, el usuario apaga el TV): se trata igual que pulsar "Dejar de enviar" — vuelta automática a reproducción local.
- Todas las llamadas comprueban la existencia de `cordova.plugins.tvCast` antes de usarlo; si el plugin no está disponible (navegador de escritorio, o build sin él), el botón de Cast simplemente no aparece, sin romper el resto de la app — mismo principio que ya se sigue con `cordova.plugins.backgroundMode`.

## Testing

No es testeable con el runner de Node (`test/m3u.test.js` cubre solo el parser M3U); esta funcionalidad depende de un dispositivo Cast real en la red. **Limitación conocida**: no hay Chromecast/Android TV disponible en este momento para validar de extremo a extremo (igual que iOS, que no se puede compilar ni probar sin Mac). La validación manual en dispositivo real queda pendiente hasta disponer de uno.

Validación manual (cuando haya dispositivo disponible):

1. Reproducir un canal `hls` o directo (no `.ts`) — confirmar que aparece el icono de Cast.
2. Reproducir un canal `.ts` — confirmar que el icono de Cast NO aparece.
3. Pulsar Cast, elegir el TV, confirmar que el canal empieza a sonar allí y el móvil muestra "Reproduciendo en «TV»".
4. Cambiar de canal en la app mientras está conectado — confirmar que el TV cambia también.
5. Pulsar "Dejar de enviar" — confirmar que el TV para y el móvil retoma la reproducción local.
6. Apagar el TV o desconectar la red mientras se envía — confirmar que el móvil detecta el corte y vuelve a reproducción local sin quedarse colgado.

## Limitación conocida a documentar en el README

El botón de Cast no aparece en canales `.ts` (el Default Media Receiver de Google no reproduce MPEG-TS crudo, y los que usan el proxy CORS local no serían alcanzables por el TV). Solo canales HLS (`.m3u8`) y directos son enviables a TV.
