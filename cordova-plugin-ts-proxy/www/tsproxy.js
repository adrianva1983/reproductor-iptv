var exec = require('cordova/exec');

// success(port) se llama con el puerto TCP local (127.0.0.1) donde escucha el proxy.
// Se envía el User-Agent real del WebView: algunos servidores IPTV rechazan
// (403) peticiones con un User-Agent genérico o no reconocido como navegador.
function start(success, error) {
    exec(function (result) {
        if (success) success(result && result.port);
    }, function (err) {
        if (error) error(err);
    }, 'TsProxy', 'start', [navigator.userAgent]);
}

// Arranca (o reutiliza) el proxy escuchando en la red local, no solo en el
// propio dispositivo, para que un TV pueda alcanzarlo al enviarle un canal
// por DLNA. success({port, token, ip}): hay que incluir siempre el token en
// las peticiones (?token=...), si no se rechazan con 403. ip puede venir
// null si no se encuentra una interfaz de red válida.
function startForLan(success, error) {
    exec(function (result) {
        if (success) success(result || {});
    }, function (err) {
        if (error) error(err);
    }, 'TsProxy', 'startForLan', [navigator.userAgent]);
}

// Cierra el modo red: el proxy deja de ser alcanzable desde otros
// dispositivos (la siguiente llamada a start() vuelve a abrirlo solo en
// 127.0.0.1).
function stopLan(success) {
    exec(function () {
        if (success) success();
    }, null, 'TsProxy', 'stopLan', []);
}

module.exports = {
    start: start,
    startForLan: startForLan,
    stopLan: stopLan
};
