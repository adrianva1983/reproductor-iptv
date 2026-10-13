## Fork local (reproductor-iptv)

Basado en `mpegts.js` 1.8.2 (npm), vendorizado en este repo para añadir una
funcionalidad que la librería no soporta: reproducción de solo audio.

### Por qué

Al bloquear la pantalla con un canal reproduciéndose, Android suspende el
decodificador de vídeo del `<video>` (confirmado en dispositivo real: esto
ocurre aunque el audio y el vídeo vayan por el mismo `MediaSource`, y aunque
ese `MediaSource` esté enlazado a un `<audio>` en vez de a un `<video>` — es
una política de ahorro de energía del motor al detectar la página oculta, no
depende de qué elemento consume el stream). Como vídeo y audio comparten el
mismo pipeline de decodificación, el audio se corta con el vídeo.

La única forma de que el audio sobreviva es que el `MediaSource` nunca tenga
un `SourceBuffer` de vídeo, para que el motor no tenga nada que decodificar
ni que suspender.

### Cambio

- `src/core/mse-controller.js`: nueva opción de configuración `audioOnly`.
  Cuando es `true`, `appendInitSegment()` y `appendMediaSegment()` descartan
  silenciosamente cualquier segmento de tipo `video` (nunca se llama a
  `addSourceBuffer()` para vídeo). El resto del controlador ya comprobaba
  `if (sb)`/`if (this._sourceBuffers[type])` antes de tocar cada
  SourceBuffer, así que dejar `_sourceBuffers.video` en `null` para siempre
  es seguro en todo el archivo (confirmado leyendo `flush()`,
  `_doAppendSegments()`, `_doCleanupSourceBuffer()`, `endOfStream()`, etc.).
- `src/config.js`: añade `audioOnly: false` a `defaultConfig` para que quede
  documentada (se podía pasar igualmente sin esto, `Object.assign` no filtra
  claves desconocidas, pero así queda visible).

El demuxer/remuxer internos siguen parseando el vídeo igual (coste de CPU
aceptable mientras dura el modo en segundo plano); el cambio solo evita que
ese vídeo llegue nunca al `<audio>` ni al decodificador del navegador.

### Cómo actualizar

1. `npm install mpegts.js@<versión nueva>` en la raíz del proyecto (actualiza
   `node_modules/mpegts.js`).
2. Copiar `node_modules/mpegts.js/src` sobre `mpegts.js-patched/src`.
3. Reaplicar los dos cambios de arriba (son pocas líneas, buscar `audioOnly`
   en este repo para localizarlos).
4. `npm install` dentro de `mpegts.js-patched/` (devDependencies de build:
   webpack, ts-loader, typescript — no se commitean, son solo de build).
5. `npm run build` dentro de `mpegts.js-patched/`.
6. `npm run copy:mpegts` en la raíz del proyecto.
