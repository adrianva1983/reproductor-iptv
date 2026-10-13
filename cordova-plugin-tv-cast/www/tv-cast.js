var exec = require('cordova/exec');

// Confirma si el plugin está disponible en esta build (no si hay un dispositivo
// Cast cerca: para eso está onAvailabilityChanged).
function isAvailable(success, error) {
    exec(function () {
        if (success) success(true);
    }, error || null, 'TvCast', 'isAvailable', []);
}

// cb(available: boolean) se llama cada vez que aparece/desaparece un dispositivo
// Cast en la red (callback persistente, no de un solo uso).
function onAvailabilityChanged(cb) {
    exec(function (available) {
        if (cb) cb(!!available);
    }, null, 'TvCast', 'registerAvailabilityCallback', []);
}

// cb({state: 'connecting'|'connected'|'disconnected', deviceName?}) se llama en
// cada cambio de estado de la sesión de Cast (callback persistente).
function onSessionStateChanged(cb) {
    exec(function (evt) {
        if (cb) cb(evt || {});
    }, null, 'TvCast', 'registerSessionCallback', []);
}

// Abre el diálogo nativo de selección de dispositivo Cast.
function showCastPicker() {
    exec(null, null, 'TvCast', 'showCastPicker', []);
}

// Carga (o reemplaza) el stream en el dispositivo Cast conectado.
// opts: { title, contentType }
function loadMedia(url, opts) {
    opts = opts || {};
    exec(null, null, 'TvCast', 'loadMedia', [url, opts.title || '', opts.contentType || 'video/mp4']);
}

// Termina la sesión de Cast activa (si la hay).
function stop() {
    exec(null, null, 'TvCast', 'stop', []);
}

// cb({type: 'found', id, name} | {type: 'done'}) se llama por cada dispositivo
// DLNA/UPnP encontrado durante una búsqueda, y una vez más al terminarla
// (callback persistente, no de un solo uso).
function onDlnaEvent(cb) {
    exec(function (evt) {
        if (cb) cb(evt || {});
    }, null, 'TvCast', 'registerDlnaCallback', []);
}

// Lanza una búsqueda SSDP de ~3s; los resultados llegan vía onDlnaEvent.
function startDlnaDiscovery() {
    exec(null, null, 'TvCast', 'startDlnaDiscovery', []);
}

// Envía (o reemplaza) el stream en el dispositivo DLNA indicado (id de onDlnaEvent).
// opts: { title, contentType }
function loadMediaDlna(deviceId, url, opts) {
    opts = opts || {};
    exec(null, null, 'TvCast', 'loadMediaDlna', [deviceId, url, opts.title || '', opts.contentType || 'video/mp4']);
}

// Detiene la reproducción en el dispositivo DLNA indicado.
function stopDlna(deviceId) {
    exec(null, null, 'TvCast', 'stopDlna', [deviceId]);
}

module.exports = {
    isAvailable: isAvailable,
    onAvailabilityChanged: onAvailabilityChanged,
    onSessionStateChanged: onSessionStateChanged,
    showCastPicker: showCastPicker,
    loadMedia: loadMedia,
    stop: stop,
    onDlnaEvent: onDlnaEvent,
    startDlnaDiscovery: startDlnaDiscovery,
    loadMediaDlna: loadMediaDlna,
    stopDlna: stopDlna
};
