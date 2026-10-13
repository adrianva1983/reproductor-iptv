# Reproductor IPTV (Apache Cordova)

App híbrida para Android e iOS que reproduce canales IPTV a partir de listas **M3U / M3U8** que añade el usuario.

> **Aviso:** la app **no incluye** listas, canales, URLs de streams ni credenciales. Cada usuario añade sus propias listas dentro de la app. Las listas se guardan sólo en el almacenamiento local del dispositivo (`localStorage`).

## Versiones

| Componente | Versión |
|---|---|
| Cordova CLI | 13.0.0 |
| cordova-android | 15.1.0 |
| cordova-ios | 8.1.1 |
| cordova-plugin-statusbar | 4.0.0 |
| cordova-plugin-screen-orientation | 3.0.4 |
| hls.js (cargado en local desde `www/js/vendor/`) | 1.7.3 |

Dependencias transitivas: `es6-promise-plugin` 4.2.2 llega automáticamente con `cordova-plugin-screen-orientation` en Android.

Plugins: sólo los dos mínimos. La reproducción usa el `<video>` HTML5 nativo, así que no hace falta ningún plugin de vídeo. La carga de listas usa `fetch` del propio WebView.

## Requisitos

- **Node.js** 20.17 o superior (o 22.9 o superior) y npm.
- **Cordova CLI** 13.0.0: `npm install -g cordova@13.0.0`
- **Android**: JDK 21 (versión con la que se generó el proyecto; revisa los requisitos de cordova-android 15.1.0 en la [documentación oficial](https://cordova.apache.org/docs/en/latest/guide/platforms/android/index.html)), Android SDK con `ANDROID_HOME` configurado, y Gradle (lo gestiona el proyecto).
- **iOS**: un Mac con Xcode y CocoaPods. No se puede compilar iOS desde Linux ni Windows.

## Puesta en marcha

`platforms/` y `plugins/` no se versionan (están en `.gitignore`). Tras clonar el repo:

```bash
npm install
cordova platform add android@15.1.0
cordova platform add ios@8.1.1      # sólo en un Mac
```

Los plugins se restauran automáticamente desde la sección `cordova` de `package.json`.

## Cómo añadir una lista

1. Abre la app y pulsa **+ Lista**.
2. Escribe un nombre.
3. Elige el origen:
   - **URL**: pega la URL `http` o `https` de la lista M3U.
   - **Pegar texto**: pega el contenido completo de la lista.
4. Pulsa **Guardar**. La lista se valida (debe contener al menos un canal reproducible) y se guarda en el dispositivo.

Desde la pantalla principal puedes cambiar de lista, buscar canales (sin distinguir mayúsculas ni acentos), marcar favoritos con ☆ y **Continuar** con el último canal reproducido. Las listas creadas desde URL se pueden actualizar con **Actualizar lista**.

## Formatos soportados

- **HLS** (`.m3u8`): en iOS con el reproductor nativo de WKWebView; en Android y en el resto con hls.js.
- **Directos** (`.mp4`, `.ts`): se asignan directamente al `<video>`. El soporte depende del motor de cada plataforma; el MPEG-TS directo no siempre se puede reproducir en HTML5. Si falla, la app muestra un mensaje y el botón **Reintentar**.

Atributos leídos de `#EXTINF`: `tvg-name`, `tvg-logo`, `group-title` y el nombre del canal (tras la última coma fuera de comillas).

## Compilar en Android

```bash
cordova build android      # genera el APK/AAB en platforms/android
cordova run android        # compila e instala en un dispositivo o emulador conectado
```

## Compilar en iOS (Mac con Xcode)

```bash
cordova build ios          # genera el proyecto y lo compila para la plataforma iOS
```

La firma (certificados, perfiles de aprovisionamiento y equipo de desarrollo) se configura en Xcode, no en este repo.

## Configuración de red

- **Android**: `resources/android/network_security_config.xml` permite tráfico HTTP en claro. Se aplica en el `AndroidManifest` mediante `edit-config` en `config.xml`.
- **iOS**: `config.xml` establece `NSAppTransportSecurity` con `NSAllowsArbitraryLoads`, `NSAllowsArbitraryLoadsInMediaPlayback` y `NSAllowsArbitraryLoadsInWebContent`. Apple puede pedir justificación de esta excepción durante la revisión de la App Store.
- **Navegación**: `allow-navigation` y `allow-intent` permiten `http://*/*` y `https://*/*`, porque los dominios de las listas y los streams los define cada usuario y no se conocen de antemano.

## Limitaciones conocidas

- **Listas por URL y CORS**: el WebView sólo puede descargar la lista si el servidor responde con cabeceras CORS. Muchos proveedores IPTV no las envían; en ese caso la app pide pegar el contenido. Resolverlo de forma general exigiría un plugin nativo de HTTP, que no se ha añadido.
- **Contenido mixto en Android**: si el origen de la app es `https` y la lista es `http`, el WebView puede bloquear la descarga. Hay que probarlo en un dispositivo real.
- **Cabeceras y directivas**: no se aplican `#EXTVLCOPT` ni otras cabeceras (User-Agent, Referer) que algunas listas necesitan.
- **Tamaño**: `localStorage` admite unos 5 MB por origen; las listas muy grandes pueden no guardarse.
- **Actualizar hls.js**: cambia la versión en `package.json` (con `npm install --save-exact hls.js@<versión>`), ejecuta `npm run copy:hls` y commitea `www/js/vendor/hls.min.js`.
- **Actualizar mpegts.js**: es un fork local parcheado (ver `mpegts.js-patched/CHANGELOG-fork.md`), no una copia directa de npm. Sigue los pasos de ese changelog para actualizar la versión sin perder el parche de audio en segundo plano.
- **Reproducción en segundo plano (pantalla bloqueada)**: Android suspende el decodificador de vídeo al bloquear la pantalla (política de ahorro de energía del motor, no evitable con un foreground service). Como vídeo y audio comparten pipeline, el audio se corta con el vídeo salvo que el `MediaSource` no tenga nunca un SourceBuffer de vídeo:
  - **Canales directos `.ts` (mpegts.js)**: solucionado. Al bloquear la pantalla, la app reconecta el canal en un modo de solo audio (parche propio en `mpegts.js-patched/`) que nunca decodifica vídeo, así que nada se corta. Al volver a la app se reinicia la reproducción normal con vídeo.
  - **Canales `.m3u8` (hls.js) y HLS nativo (iOS)**: pendiente. Por ahora el audio se sigue cortando al bloquear la pantalla; hls.js no ofrece una forma oficial de descartar el SourceBuffer de vídeo de un stream mezclado, y su `BufferController` es demasiado complejo para parchear con la misma seguridad que mpegts.js sin arriesgar la reproducción normal en primer plano. Ver `docs/superpowers/specs/2026-10-08-background-playback-design.md` para el detalle del diagnóstico.
  - En MIUI (y otras capas Android agresivas con la gestión de batería) puede hacer falta además desactivar manualmente la optimización de batería para esta app (Ajustes > Apps > Reproductor IPTV > Batería > Sin restricciones) para mayor fiabilidad a largo plazo.
- **Enviar a TV (Google Cast)**: el botón de Cast (icono junto a favorito/pantalla completa) solo aparece si hay un dispositivo Google Cast disponible en la red **y** el canal activo no es `.ts` (el Default Media Receiver de Google no reproduce MPEG-TS crudo, y los canales `.ts` que pasan por el proxy CORS local no serían alcanzables desde el TV). Usa un plugin nativo propio (`cordova-plugin-tv-cast/`), no una dependencia de npm: el único plugin Cordova de Chromecast disponible lleva más de un año sin publicar y tiene quejas de fiabilidad. Soporte iOS sin verificar (sin Mac disponible, mismo caso que `cordova-plugin-ts-proxy`); tampoco se ha podido validar una sesión de Cast real de extremo a extremo por falta de un Chromecast/Android TV en este entorno. Ver `docs/superpowers/specs/2026-10-09-tv-cast-design.md`.

## Pruebas

```bash
npm test
```

Ejecuta las pruebas del parser M3U (`test/m3u.test.js`) con una lista ficticia de dos canales (uno HLS y uno mp4) y dominios reservados `.invalid`. Usa el test runner integrado de Node.js, sin dependencias adicionales.

## Estructura

```
config.xml                              Configuración de Cordova (red, ATS, preferencias)
package.json                            Versiones fijadas (hls.js, plugins, plataformas)
resources/android/network_security_config.xml
www/index.html                          Interfaz
www/css/index.css                       Estilos
www/js/m3u.js                           Parser M3U
www/js/storage.js                       Listas, favoritos y último canal en localStorage
www/js/player.js                        Reproductor (HLS nativo en iOS, hls.js en el resto)
www/js/index.js                         Lógica de la aplicación
www/js/vendor/hls.min.js                hls.js 1.7.3 en local
www/js/vendor/mpegts.min.js             mpegts.js 1.8.2, fork local parcheado (ver mpegts.js-patched/)
mpegts.js-patched/                      Fork de mpegts.js con el modo de solo audio en segundo plano
cordova-plugin-background-mode-patched/ Fork del plugin de background-mode (foreground service + MediaSession)
cordova-plugin-tv-cast/                 Plugin propio: enviar el canal activo a un dispositivo Google Cast
test/m3u.test.js                        Pruebas del parser
```
