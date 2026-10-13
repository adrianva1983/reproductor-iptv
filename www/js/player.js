(function (root) {
    'use strict';

    var LOAD_TIMEOUT_MS = 20000;

    var video = null;
    var hls = null;
    var mpegtsPlayer = null;
    var timer = null;
    var active = false;
    var handlers = { onPlaying: null, onError: null };
    var proxyBasePromise = null;
    var playToken = 0;
    var audioEl = null;
    var inBackground = false;
    var backgroundAudioOnly = false;
    var backgroundPaused = false;
    var isMpegtsChannel = false;
    var currentChannel = null;
    var currentMpegtsUrl = null;

    function isIOS() {
        return /iPad|iPhone|iPod/.test(root.navigator.userAgent);
    }

    // En iOS (WKWebView) se usa el HLS nativo; en Android y el resto, hls.js.
    function usesNativeHls() {
        return isIOS() && video.canPlayType('application/vnd.apple.mpegurl') !== '';
    }

    // El <video> nativo no reproduce MPEG-TS crudo en directo; mpegts.js lo remuxea vía MSE.
    // En iOS (WKWebView) no se usa: se deja el comportamiento nativo existente como estaba.
    function canUseMpegts() {
        return !isIOS() && !!root.mpegts && root.mpegts.isSupported();
    }

    // Arranca (una sola vez) el proxy nativo que añade cabeceras CORS a los streams .ts.
    // Si el plugin no está disponible (p.ej. en pruebas de navegador), se usa la URL directa.
    function getProxyBase() {
        if (!root.TsProxy) return Promise.resolve(null);
        if (!proxyBasePromise) {
            proxyBasePromise = new Promise(function (resolve) {
                root.TsProxy.start(function (port) {
                    resolve(port ? ('http://127.0.0.1:' + port + '/') : null);
                }, function () {
                    resolve(null);
                });
            });
        }
        return proxyBasePromise;
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

    function destroyMpegts() {
        if (mpegtsPlayer) {
            mpegtsPlayer.destroy();
            mpegtsPlayer = null;
        }
    }

    // mpegts.js reutiliza los mismos textos de error que hls.js (misma nomenclatura de tipos).
    function mpegtsErrorMessage(type) {
        if (type === root.mpegts.ErrorTypes.NETWORK_ERROR) return 'Error de red al cargar el canal.';
        if (type === root.mpegts.ErrorTypes.MEDIA_ERROR) return 'Error al decodificar el vídeo de este canal.';
        return 'No se pudo reproducir este canal.';
    }

    function fail(message) {
        if (!active) return;
        clearTimer();
        destroyHls();
        destroyMpegts();
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
        currentChannel = channel;
        isMpegtsChannel = false;
        playToken += 1;
        var myToken = playToken;
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
        } else if (channel.type === 'ts' && canUseMpegts()) {
            // El arranque del proxy es async (llamada nativa), así que esta rama
            // termina aquí y continúa la reproducción dentro del .then().
            getProxyBase().then(function (base) {
                if (myToken !== playToken) return; // se canceló: cambio de canal o stop()
                var streamUrl = base ? (base + 'ts-proxy?url=' + encodeURIComponent(channel.url)) : channel.url;
                currentMpegtsUrl = streamUrl;
                isMpegtsChannel = true;
                mpegtsPlayer = root.mpegts.createPlayer({ type: 'mpegts', isLive: true, url: streamUrl });
                mpegtsPlayer.on(root.mpegts.Events.ERROR, function (type) {
                    fail(mpegtsErrorMessage(type));
                });
                mpegtsPlayer.attachMediaElement(video);
                mpegtsPlayer.load();
                startPlayback();
            });
            return;
        } else {
            // Nativo: HLS en iOS y streams directos (mp4, o ts cuando el motor lo acepte).
            video.src = channel.url;
            video.load();
        }

        startPlayback();

        function startPlayback() {
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
    }

    function stop() {
        playToken += 1;
        clearTimer();
        destroyHls();
        destroyMpegts();
        active = false;
        inBackground = false;
        backgroundPaused = false;
        // Se invalida la base cacheada del proxy: tras una sesión de envío a TV
        // por DLNA (que puede cerrar y reabrir el proxy en modo red, con otro
        // puerto), la próxima reproducción local debe volver a resolverla en vez
        // de reutilizar un puerto que puede ya no ser válido.
        proxyBasePromise = null;
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
    }

    function getAudioEl() {
        if (!audioEl) {
            audioEl = root.document.createElement('audio');
            audioEl.setAttribute('playsinline', '');
            root.document.body.appendChild(audioEl);
        }
        return audioEl;
    }

    // Al bloquear la pantalla, Android suspende el decodificador de vídeo
    // (confirmado en dispositivo real: ocurre aunque el audio y el vídeo
    // compartan MediaSource, y aunque ese MediaSource esté enlazado a un
    // <audio> en vez de a un <video> — es una política de ahorro de energía
    // del motor al detectar la página oculta, no depende de la superficie de
    // render). Como van por el mismo pipeline, el audio se corta con el
    // vídeo. La única forma de que sobreviva es que el MediaSource no tenga
    // nunca un SourceBuffer de vídeo, así que para canales mpegts.js se
    // reconecta en un modo "audioOnly" (parche propio, ver
    // mpegts.js-patched/CHANGELOG-fork.md) sobre un <audio> oculto.
    // Los canales hls.js y HLS nativo (iOS) no tienen este modo todavía:
    // el audio se sigue cortando al bloquear la pantalla para esos casos.
    // Crea (o recrea) el reproductor de audio-solo en segundo plano, enganchado
    // al directo actual. La usan tanto enterBackground() (al bloquear la
    // pantalla) como resumeBackgroundAudio() (al tocar "reproducir" en la
    // notificación tras una pausa) — reconectar es más simple que soportar
    // una pausa real en directo, y no tiene sentido "seek" hacia atrás.
    function startBackgroundAudio() {
        if (!currentMpegtsUrl) return;
        destroyMpegts();
        var el = getAudioEl();
        try {
            var bgPlayer = root.mpegts.createPlayer(
                { type: 'mpegts', isLive: true, url: currentMpegtsUrl },
                { audioOnly: true }
            );
            bgPlayer.on(root.mpegts.Events.ERROR, function () {
                // Sin UI visible mientras está en segundo plano; se
                // recupera solo al volver a primer plano (exitBackground
                // reinicia la reproducción normal desde cero).
                destroyMpegts();
            });
            bgPlayer.attachMediaElement(el);
            bgPlayer.load();
            var p = el.play();
            if (p && p.catch) p.catch(function () {});
            mpegtsPlayer = bgPlayer;
            backgroundAudioOnly = true;
        } catch (e) {
            backgroundAudioOnly = false;
        }
    }

    function enterBackground() {
        if (inBackground || !active) return;
        inBackground = true;
        backgroundPaused = false;
        if (isMpegtsChannel) startBackgroundAudio();
    }

    // Botón de pausa de la notificación de segundo plano: corta la red y la
    // decodificación (no tiene sentido dejarlo "en pausa" acumulando buffer
    // de un directo sin límite).
    function pauseBackgroundAudio() {
        if (!backgroundAudioOnly) return;
        destroyMpegts();
        backgroundAudioOnly = false;
        backgroundPaused = true;
    }

    // Botón de reproducir de la notificación: reconecta al directo actual.
    function resumeBackgroundAudio() {
        if (!inBackground || !backgroundPaused) return;
        backgroundPaused = false;
        if (isMpegtsChannel) startBackgroundAudio();
    }

    function exitBackground() {
        if (!inBackground) return;
        var wasMpegts = isMpegtsChannel;
        inBackground = false;
        backgroundAudioOnly = false;
        backgroundPaused = false;
        if (wasMpegts && currentChannel) play(currentChannel);
    }

    root.IPTVPlayer = {
        init: init,
        play: play,
        stop: stop,
        isActive: function () { return active; },
        enterBackground: enterBackground,
        exitBackground: exitBackground,
        pauseBackgroundAudio: pauseBackgroundAudio,
        resumeBackgroundAudio: resumeBackgroundAudio
    };
})(typeof window !== 'undefined' ? window : globalThis);
