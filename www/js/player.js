(function (root) {
    'use strict';

    var LOAD_TIMEOUT_MS = 20000;

    var video = null;
    var hls = null;
    var timer = null;
    var active = false;
    var handlers = { onPlaying: null, onError: null };

    function isIOS() {
        return /iPad|iPhone|iPod/.test(root.navigator.userAgent);
    }

    // En iOS (WKWebView) se usa el HLS nativo; en Android y el resto, hls.js.
    function usesNativeHls() {
        return isIOS() && video.canPlayType('application/vnd.apple.mpegurl') !== '';
    }

    function mediaErrorMessage(err) {
        var code = err && err.code;
        if (code === 1) return 'La reproducción se interrumpió.';
        if (code === 2) return 'Error de red al cargar el canal.';
        if (code === 3) return 'El formato del canal no se puede decodificar en este dispositivo.';
        if (code === 4) return 'El canal no está en un formato compatible con este dispositivo.';
        return 'No se pudo reproducir este canal.';
    }

    function clearTimer() {
        if (timer) {
            root.clearTimeout(timer);
            timer = null;
        }
    }

    function destroyHls() {
        if (hls) {
            hls.destroy();
            hls = null;
        }
    }

    function fail(message) {
        if (!active) return;
        clearTimer();
        destroyHls();
        active = false;
        if (handlers.onError) handlers.onError(message);
    }

    function init(videoEl, callbacks) {
        video = videoEl;
        handlers = callbacks || handlers;

        video.addEventListener('playing', function () {
            if (!active) return;
            clearTimer();
            if (handlers.onPlaying) handlers.onPlaying();
        });

        video.addEventListener('error', function () {
            fail(mediaErrorMessage(video.error));
        });
    }

    function play(channel) {
        stop();
        active = true;
        timer = root.setTimeout(function () {
            fail('El canal tarda demasiado en responder. Comprueba la conexión o la lista.');
        }, LOAD_TIMEOUT_MS);

        if (channel.type === 'hls' && !usesNativeHls()) {
            if (!root.Hls || !root.Hls.isSupported()) {
                fail('Este dispositivo no soporta reproducción HLS.');
                return;
            }
            hls = new root.Hls({ enableWorker: false });
            hls.on(root.Hls.Events.ERROR, function (_event, data) {
                if (!data || !data.fatal) return;
                if (data.type === root.Hls.ErrorTypes.NETWORK_ERROR) {
                    fail('Error de red al cargar el canal.');
                } else if (data.type === root.Hls.ErrorTypes.MEDIA_ERROR) {
                    fail('Error al decodificar el vídeo de este canal.');
                } else {
                    fail('No se pudo reproducir este canal.');
                }
            });
            hls.loadSource(channel.url);
            hls.attachMedia(video);
        } else {
            // Nativo: HLS en iOS y streams directos (mp4, o ts cuando el motor lo acepte).
            video.src = channel.url;
            video.load();
        }

        var p = video.play();
        if (p && p.catch) {
            p.catch(function (err) {
                // Un AbortError es normal al cambiar de canal; el resto se muestra como error de reproducción.
                if (err && err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
                    fail('No se pudo iniciar la reproducción.');
                }
            });
        }
    }

    function stop() {
        clearTimer();
        destroyHls();
        active = false;
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
    }

    root.IPTVPlayer = { init: init, play: play, stop: stop };
})(typeof window !== 'undefined' ? window : globalThis);
