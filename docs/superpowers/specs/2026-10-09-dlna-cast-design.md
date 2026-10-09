# Enviar canal a TV: soporte DLNA/UPnP (complemento a Google Cast)

## Problema

La función de Cast (`docs/superpowers/specs/2026-10-09-tv-cast-design.md`) solo funciona con dispositivos Google Cast (Chromecast, Android TV, TVs con "Chromecast built-in"). Validado en dispositivo real: un Samsung Smart TV normal **no** es un dispositivo Google Cast — ni siquiera Chrome lo detecta como tal. Samsung (y la mayoría de TVs "smart" genéricos) usan en su lugar DLNA/UPnP ("Play To" / "Smart View") para recibir streams enviados desde una app.

## Alcance

Amplía el plugin ya existente `cordova-plugin-tv-cast/` (no se crea un plugin nuevo) con un segundo protocolo:

- Descubrimiento de dispositivos `MediaRenderer` DLNA/UPnP en la red local vía SSDP, bajo demanda (no en segundo plano continuo, a diferencia de Cast).
- Envío del canal activo al dispositivo elegido vía las acciones SOAP estándar `SetAVTransportURI` + `Play` del servicio `AVTransport` de UPnP AV.
- Un botón único "Enviar a TV" (sustituye al actual `#btn-cast`) que, al pulsarse, ofrece tanto el Chromecast (si está disponible, mismo flujo ya existente) como los TVs DLNA encontrados.

No cubre (fuera de alcance para esta iteración):

- Librerías UPnP de terceros (`jUPnP`/`Cling`): protocolo implementado a mano, sin dependencias nuevas, mismo criterio que `cordova-plugin-ts-proxy`.
- Detección automática de desconexión/apagado del TV (UPnP no tiene un evento equivalente al `SessionManagerListener` de Cast). "Dejar de enviar" es manual.
- Controles de reproducción remotos (play/pausa/volumen) más allá de iniciar la reproducción — igual que Cast.
- Restricción por tipo de canal: a diferencia de Cast, los canales `.ts` **sí** son enviables por DLNA (muchos TV los soportan nativamente); no hay garantía para un canal concreto hasta probarlo.

## Arquitectura

### Descubrimiento SSDP (bajo demanda)

Al pulsar "Enviar a TV":

1. Si `state.castAvailable` (ya lo sabíamos por el listener de Cast existente), se muestra la entrada "Chromecast" de inmediato.
2. Se muestra "Buscando TVs…" y se lanza una búsqueda SSDP de ~3 segundos:
   - Se adquiere un `WifiManager.MulticastLock` (permiso `CHANGE_WIFI_MULTICAST_STATE` ya declarado para Cast, reutilizado aquí).
   - Se envía por UDP multicast a `239.255.255.250:1900`:
     ```
     M-SEARCH * HTTP/1.1
     HOST: 239.255.255.250:1900
     MAN: "ssdp:discover"
     MX: 2
     ST: urn:schemas-upnp-org:service:AVTransport:1
     ```
   - Se escuchan respuestas UDP durante la ventana de búsqueda; cada dispositivo UPnP que tenga el servicio `AVTransport` responde con una cabecera `LOCATION: <url de su XML de descripción>`.
3. Por cada `LOCATION` única recibida: se descarga ese XML (HTTP GET) y se extraen:
   - `<friendlyName>` (nombre a mostrar, p. ej. "Samsung TV Salón").
   - La `controlURL` del servicio cuyo `serviceType` sea `urn:schemas-upnp-org:service:AVTransport:1` (viene en el propio XML, como ruta relativa a resolver contra la URL base del dispositivo).
4. Cada dispositivo confirmado (con `AVTransport` válido) se añade a la lista del menú conforme se va descubriendo (no se espera a que acabe toda la ventana de 3s para mostrar el primero).
5. Si al terminar la ventana no se encontró ninguno: "No se han encontrado TVs".

Los dispositivos encontrados (id interno, nombre, controlURL) se guardan en memoria en el plugin nativo mientras dura la sesión de la app, indexados por un id que el menú HTML usa para referenciarlos al elegir uno.

### Envío del canal (SOAP)

Dos peticiones HTTP POST a la `controlURL` del dispositivo elegido, con cabecera `SOAPACTION` y cuerpo XML según UPnP AVTransport:1:

1. `SetAVTransportURI` con `CurrentURI` = URL directa del canal (como en Cast: el TV se conecta él solo, sin pasar por el proxy CORS del móvil) y `CurrentURIMetaData` vacío (no hace falta metadata DIDL-Lite para que funcione; se simplifica dejándolo vacío).
2. `Play` con `Speed=1`.

Cambiar de canal mientras está "enviando" a un TV DLNA repite estas dos llamadas con la nueva URL, igual que Cast reemplaza el `loadMedia`.

"Dejar de enviar" llama a la acción `Stop`.

### API JS (ampliación de `cordova.plugins.tvCast`)

| Método | Descripción |
|---|---|
| `discoverDlna(onDeviceFound, onDone)` | Lanza la búsqueda SSDP de ~3s. `onDeviceFound({id, name})` se llama por cada dispositivo confirmado, conforme se descubre. `onDone()` se llama al terminar la ventana de búsqueda. |
| `loadMediaDlna(deviceId, url)` | `SetAVTransportURI` (con `CurrentURIMetaData` vacío, sin título) + `Play` en el dispositivo indicado. |
| `stopDlna(deviceId)` | `Stop`. |

(Los métodos ya existentes de Cast —`isAvailable`, `onAvailabilityChanged`, `showCastPicker`, `loadMedia`, `stop`, `onSessionStateChanged`— no cambian.)

## Cambios de UI

- `www/index.html`: renombrar `#btn-cast` → `#btn-send-tv` (mismo lugar en `.player-bar`). Nuevo elemento `#tv-menu` (lista HTML oculta por defecto, mismo estilo que `#cast-banner`/`#player-overlay`) con una entrada "Chromecast" condicional y un contenedor para las entradas DLNA descubiertas.
- `www/js/index.js`:
  - `$('btn-send-tv')` abre `#tv-menu` en vez de llamar directamente a `showCastPicker()`.
  - Dentro del menú: tocar "Chromecast" cierra el menú y sigue el flujo ya existente (`showCastPicker()`). Tocar un TV DLNA llama a `loadMediaDlna(id, channel.url)`, cierra el menú, y activa el mismo `cast-banner` que ya existe (texto genérico "Reproduciendo en «X»", sin mencionar el protocolo).
  - `state.casting` gana un campo `protocol: 'cast' | 'dlna'` para que "Dejar de enviar" llame a `tvCast.stop()` o `tvCast.stopDlna(deviceId)` según corresponda, y para que el cambio de canal (`openChannel`) llame a `loadMedia`/`loadMediaDlna` según el protocolo activo.
  - Como no hay detección de desconexión DLNA, salir del modo "enviando" solo ocurre al pulsar "Dejar de enviar" (no hay equivalente al evento `disconnected` de Cast para DLNA).

## Manejo de errores

- Si `SetAVTransportURI`/`Play` devuelven un error SOAP (p. ej. el TV rechaza el formato): se trata como un error de reproducción normal (mensaje + Reintentar), y se sale del modo "enviando".
- Si la búsqueda SSDP no encuentra nada: se informa en el propio menú ("No se han encontrado TVs"), sin tratarlo como error de la app.
- Todas las llamadas comprueban la existencia de `cordova.plugins.tvCast` antes de usarse, igual que el resto de integraciones opcionales de esta app.

## Testing

A diferencia de Cast, aquí **sí** hay un TV real disponible (el Samsung del usuario) para validar de extremo a extremo:

1. Pulsar "Enviar a TV" con un canal cualquiera reproduciéndose → confirmar que aparece el TV Samsung en la lista tras la búsqueda.
2. Elegir el TV → confirmar que el canal empieza a sonar/verse allí y el móvil muestra "Reproduciendo en «TV»".
3. Cambiar de canal en la app mientras está conectado → confirmar que el TV cambia también.
4. Probar con un canal `.ts` → confirmar si el Samsung lo reproduce (sin garantía previa, es parte de la validación).
5. Pulsar "Dejar de enviar" → confirmar que el móvil retoma la reproducción local.
6. Apagar el TV mientras se envía, sin pulsar "Dejar de enviar" → confirmar (comportamiento esperado, no un bug) que la app se queda "pensando" que sigue enviando hasta que el usuario pulse el botón manualmente.
