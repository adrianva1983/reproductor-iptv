(function () {
    'use strict';

    var FETCH_TIMEOUT_MS = 15000;

    var $ = function (id) { return document.getElementById(id); };
    var state = {
        playlists: [],
        activeId: null,
        favorites: [],
        parsed: {},          // caché por id de lista
        current: null,       // canal en reproducción
        query: '',
        castAvailable: false,  // hay algún dispositivo Cast en la red
        casting: null         // { protocol: 'cast'|'dlna', deviceName, deviceId? } mientras se envía a un TV, si no null
    };
    // Grupos de la biblioteca abiertos (fuera de `state`: no se persiste entre
    // sesiones, se reinicia cada vez que se abre la app o se cambia de lista).
    var openGroups = new Set();
    var openGroupsInitialized = false;

    // ---------- Utilidades ----------

    function normalize(text) {
        return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    }

    function makeId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function activePlaylist() {
        for (var i = 0; i < state.playlists.length; i++) {
            if (state.playlists[i].id === state.activeId) return state.playlists[i];
        }
        return null;
    }

    function parsedFor(playlist) {
        if (!state.parsed[playlist.id]) {
            state.parsed[playlist.id] = window.M3U.parseM3U(playlist.content);
        }
        return state.parsed[playlist.id];
    }

    function isFavorite(url) {
        return state.favorites.indexOf(url) !== -1;
    }

    // El Default Media Receiver de Google Cast no reproduce MPEG-TS crudo, y los
    // canales .ts que pasan por el proxy CORS local (127.0.0.1) no serían
    // alcanzables desde el TV de todas formas.
    function isCastable(channel) {
        return !!channel && channel.type !== 'ts';
    }

    function castContentType(channel) {
        return channel.type === 'hls' ? 'application/x-mpegURL' : 'video/mp4';
    }

    // A diferencia de Cast, los canales .ts sí se envían por DLNA (muchos TV los
    // soportan). Pero el servidor de origen de algunas listas rechaza (403)
    // peticiones sin User-Agent de navegador -confirmado en dispositivo real con
    // el Samsung del usuario-, y el TV no puede enviarlo por su cuenta. Para esos
    // canales se pasa por el proxy local (ya usado por mpegts.js), expuesto
    // temporalmente a la red con un token de un solo uso mientras dura el envío.
    function dlnaResolveUrl(channel, callback) {
        if (channel.type !== 'ts' || !window.TsProxy) {
            callback(channel.url);
            return;
        }
        window.TsProxy.startForLan(function (info) {
            if (!info || !info.ip || !info.port) {
                callback(channel.url); // sin IP de red disponible: se intenta directo, por si acaso
                return;
            }
            var base = 'http://' + info.ip + ':' + info.port + '/ts-proxy?token=' + encodeURIComponent(info.token) + '&url=';
            callback(base + encodeURIComponent(channel.url));
        }, function () {
            callback(channel.url);
        });
    }

    function toggleFavorite(url) {
        if (isFavorite(url)) {
            state.favorites = state.favorites.filter(function (u) { return u !== url; });
        } else {
            state.favorites.push(url);
        }
        window.IPTVStorage.saveFavorites(state.favorites);
    }

    // Los plugins de Cordova sólo existen dentro de la app; en navegador se ignoran.
    function statusBar(method) {
        try { if (window.StatusBar && StatusBar[method]) StatusBar[method](); } catch (e) { /* no disponible */ }
    }

    function lockLandscape() {
        try {
            var o = screen.orientation;
            if (o && o.lock) o.lock('landscape').catch(function () { /* no soportado */ });
        } catch (e) { /* no soportado */ }
    }

    function unlockOrientation() {
        try {
            var o = screen.orientation;
            if (o && o.unlock) o.unlock();
        } catch (e) { /* no soportado */ }
    }

    // ---------- Vistas ----------

    var views = ['library', 'add', 'player'];

    function showView(name) {
        views.forEach(function (v) {
            $('view-' + v).hidden = (v !== name);
        });
    }

    // ---------- Biblioteca ----------

    function renderPlaylistSelect() {
        var select = $('playlist-select');
        select.textContent = '';
        state.playlists.forEach(function (p) {
            var opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            if (p.id === state.activeId) opt.selected = true;
            select.appendChild(opt);
        });
        select.hidden = state.playlists.length === 0;
    }

    function logoElement(channel) {
        if (channel.logo) {
            var img = document.createElement('img');
            img.className = 'logo';
            img.loading = 'lazy';
            img.alt = '';
            img.src = channel.logo;
            img.onerror = function () {
                var placeholder = logoPlaceholder(channel);
                img.replaceWith(placeholder);
            };
            return img;
        }
        return logoPlaceholder(channel);
    }

    function logoPlaceholder(channel) {
        var span = document.createElement('span');
        span.className = 'logo logo-placeholder';
        span.textContent = (channel.name || '?').charAt(0).toUpperCase();
        return span;
    }

    function channelRow(channel) {
        var favOn = isFavorite(channel.url);
        var li = document.createElement('li');
        li.className = 'channel' + (favOn ? ' is-favorite' : '');

        var main = document.createElement('button');
        main.type = 'button';
        main.className = 'channel-main';
        main.appendChild(logoElement(channel));

        var name = document.createElement('span');
        name.className = 'channel-name';
        name.textContent = channel.name;
        main.appendChild(name);
        main.addEventListener('click', function () { openChannel(channel); });

        var fav = document.createElement('button');
        fav.type = 'button';
        fav.className = 'fav';
        fav.textContent = favOn ? '★' : '☆';
        fav.setAttribute('aria-pressed', String(favOn));
        fav.setAttribute('aria-label', 'Favorito');
        fav.addEventListener('click', function () {
            var scroll = window.scrollY;
            toggleFavorite(channel.url);
            renderLibrary();
            window.scrollTo(0, scroll);
        });

        li.appendChild(main);
        li.appendChild(fav);
        return li;
    }

    function section(title, channels) {
        var wrap = document.createDocumentFragment();
        var isOpen = openGroups.has(title);

        var head = document.createElement('button');
        head.type = 'button';
        head.className = 'grp-head';
        head.setAttribute('aria-expanded', String(isOpen));

        var label = document.createElement('span');
        label.className = 'group-title';
        label.textContent = title + ' (' + channels.length + ')';

        var chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = '▾';

        head.appendChild(label);
        head.appendChild(chevron);

        var ul = document.createElement('ul');
        ul.className = 'channels';
        ul.hidden = !isOpen;
        channels.forEach(function (ch) { ul.appendChild(channelRow(ch)); });

        head.addEventListener('click', function () {
            var nowOpen = ul.hidden; // estaba cerrado, se va a abrir
            ul.hidden = !nowOpen;
            head.setAttribute('aria-expanded', String(nowOpen));
            if (nowOpen) openGroups.add(title); else openGroups.delete(title);
        });

        wrap.appendChild(head);
        wrap.appendChild(ul);
        return wrap;
    }

    function matches(channel, q) {
        if (!q) return true;
        return normalize(channel.name).indexOf(q) !== -1 || normalize(channel.tvgName).indexOf(q) !== -1;
    }

    function renderLibrary() {
        var playlist = activePlaylist();
        var list = $('channel-list');
        var status = $('library-status');
        list.textContent = '';

        $('btn-refresh-list').hidden = !(playlist && playlist.url);
        $('btn-delete-list').hidden = !playlist;

        if (!playlist) {
            status.textContent = 'Añade una lista M3U para empezar.';
            renderPlaylistSelect();
            return;
        }

        var parsed = parsedFor(playlist);
        var q = normalize(state.query.trim());
        var visible = parsed.channels.filter(function (ch) { return matches(ch, q); });

        var favs = visible.filter(function (ch) { return isFavorite(ch.url); });

        var groups = {};
        var order = [];
        visible.forEach(function (ch) {
            if (!groups[ch.group]) {
                groups[ch.group] = [];
                order.push(ch.group);
            }
            groups[ch.group].push(ch);
        });
        order.sort(function (a, b) { return a.localeCompare(b, 'es'); });

        // Con búsqueda activa, los grupos con coincidencias se abren solos (si
        // no, habría que abrir cada uno a mano mientras se busca). La primera
        // vez (sin búsqueda) solo se abre el primer grupo por defecto.
        if (q) {
            if (favs.length) openGroups.add('Favoritos');
            order.forEach(function (g) { openGroups.add(g); });
        } else if (!openGroupsInitialized) {
            var firstTitle = favs.length ? 'Favoritos' : order[0];
            if (firstTitle) openGroups.add(firstTitle);
            openGroupsInitialized = true;
        }

        if (favs.length) list.appendChild(section('Favoritos', favs));
        order.forEach(function (g) { list.appendChild(section(g, groups[g])); });

        var msg = visible.length
            ? visible.length + ' canales'
            : (q ? 'Sin resultados para «' + state.query.trim() + '»' : 'La lista no tiene canales reproducibles.');
        if (parsed.skipped) msg += ' · ' + parsed.skipped + ' entradas no compatibles omitidas';
        status.textContent = msg;

        renderPlaylistSelect();
        renderResume();
    }

    function renderResume() {
        var last = window.IPTVStorage.getLastChannel();
        var btn = $('btn-resume');
        if (last && last.url) {
            btn.textContent = '▶ Continuar con ' + last.name;
            btn.hidden = false;
        } else {
            btn.hidden = true;
        }
    }

    // ---------- Reproductor ----------

    function setPlayerLoading(text) {
        $('player-message').textContent = text;
        $('player-overlay').hidden = false;
        $('btn-retry').hidden = true;
        $('btn-close-error').hidden = true;
    }

    function showPlayerError(message) {
        $('player-message').textContent = message;
        $('player-overlay').hidden = false;
        $('btn-retry').hidden = false;
        $('btn-close-error').hidden = false;
    }

    function hidePlayerOverlay() {
        $('player-overlay').hidden = true;
    }

    function updatePlayerFav() {
        var btn = $('btn-fav-player');
        var on = !!state.current && isFavorite(state.current.url);
        btn.textContent = on ? '★' : '☆';
        btn.setAttribute('aria-pressed', String(on));
    }

    // A diferencia de Cast (que sabe de antemano si hay un dispositivo
    // disponible), DLNA no tiene escaneo en segundo plano: no podemos saber si
    // hay un TV DLNA hasta buscar. Por eso el botón se muestra siempre que haya
    // un canal activo y no se esté ya enviando a uno, independientemente de
    // castAvailable (que solo decide si la entrada "Chromecast" aparece dentro
    // del menú).
    function updateSendTvButton() {
        $('btn-send-tv').hidden = !(state.current && !state.casting);
    }

    function openChannel(channel) {
        state.current = channel;
        window.IPTVStorage.setLastChannel({ name: channel.name, url: channel.url, logo: channel.logo, group: channel.group, type: channel.type });

        $('player-title').textContent = channel.name;
        updatePlayerFav();
        updateSendTvButton();
        showView('player');
        statusBar('hide');
        lockLandscape();

        if (state.casting) {
            // Ya se está enviando a un TV: el nuevo canal se envía allí en vez de
            // reproducirse localmente (ver cast-banner, que ya está visible).
            var opts = { title: channel.name, contentType: castContentType(channel) };
            if (state.casting.protocol === 'dlna') {
                var deviceId = state.casting.deviceId;
                dlnaResolveUrl(channel, function (url) {
                    cordova.plugins.tvCast.loadMediaDlna(deviceId, url, opts);
                });
            } else {
                cordova.plugins.tvCast.loadMedia(channel.url, opts);
            }
        } else {
            setPlayerLoading('Cargando…');
            window.IPTVPlayer.play(channel);
        }
    }

    function closePlayer() {
        window.IPTVPlayer.stop();
        unlockOrientation();
        statusBar('show');
        state.current = null;
        showView('library');
        renderLibrary();
    }

    function retryPlayback() {
        if (!state.current) return;
        setPlayerLoading('Cargando…');
        window.IPTVPlayer.play(state.current);
    }

    function toggleFullscreen() {
        var video = $('video');
        try {
            if (video.webkitEnterFullscreen) {
                video.webkitEnterFullscreen();
            } else if (document.fullscreenElement) {
                document.exitFullscreen();
            } else if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen();
            }
        } catch (e) { /* no disponible en este dispositivo */ }
    }

    // ---------- Añadir / actualizar / eliminar listas ----------

    function fetchText(url) {
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timeout = setTimeout(function () { if (controller) controller.abort(); }, FETCH_TIMEOUT_MS);
        return fetch(url, { signal: controller ? controller.signal : undefined, cache: 'no-store' })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .catch(function (err) {
                if (err && err.message && err.message.indexOf('HTTP ') === 0) {
                    throw new Error('El servidor respondió con error (' + err.message.slice(5) + ').');
                }
                throw new Error('No se pudo descargar la lista. Puede que el servidor no permita el acceso desde la app. Prueba a pegar el contenido de la lista.');
            })
            .finally(function () { clearTimeout(timeout); });
    }

    function saveNewPlaylist(playlist) {
        var next = state.playlists.concat([playlist]);
        if (!window.IPTVStorage.savePlaylists(next)) {
            throw new Error('No hay espacio suficiente en el almacenamiento para guardar esta lista.');
        }
        state.playlists = next;
        state.activeId = playlist.id;
        window.IPTVStorage.setActiveId(playlist.id);
    }

    function validateContent(content) {
        var parsed = window.M3U.parseM3U(content);
        if (!parsed.channels.length) {
            throw new Error('No se encontraron canales reproducibles. Revisa que el contenido sea una lista M3U válida.');
        }
        return parsed;
    }

    function setAddError(msg) {
        $('add-error').textContent = msg || '';
    }

    function onAddSubmit(event) {
        event.preventDefault();
        setAddError('');

        var name = $('add-name').value.trim();
        var source = document.querySelector('input[name="source"]:checked').value;
        var saveBtn = $('btn-add-save');
        if (!name) { setAddError('Escribe un nombre para la lista.'); return; }

        var job;
        if (source === 'url') {
            var url = $('add-url').value.trim();
            if (!/^https?:\/\//i.test(url)) { setAddError('Introduce una URL http o https válida.'); return; }
            job = fetchText(url).then(function (text) {
                return { url: url, content: text };
            });
        } else {
            var text = $('add-text').value;
            job = Promise.resolve({ url: null, content: text });
        }

        saveBtn.disabled = true;
        job.then(function (data) {
            var parsed = validateContent(data.content);
            var playlist = {
                id: makeId(),
                name: name,
                url: data.url,
                content: data.content,
                updatedAt: new Date().toISOString()
            };
            saveNewPlaylist(playlist);
            state.parsed[playlist.id] = parsed;
            $('form-add').reset();
            showView('library');
            renderLibrary();
        }).catch(function (err) {
            setAddError(err.message || 'No se pudo guardar la lista.');
        }).then(function () {
            saveBtn.disabled = false;
        });
    }

    function refreshActiveList() {
        var playlist = activePlaylist();
        if (!playlist || !playlist.url) return;
        var btn = $('btn-refresh-list');
        btn.disabled = true;
        fetchText(playlist.url).then(function (text) {
            validateContent(text);
            playlist.content = text;
            playlist.updatedAt = new Date().toISOString();
            if (!window.IPTVStorage.savePlaylists(state.playlists)) {
                throw new Error('No hay espacio suficiente en el almacenamiento para actualizar la lista.');
            }
            delete state.parsed[playlist.id];
            renderLibrary();
        }).catch(function (err) {
            $('library-status').textContent = err.message;
        }).then(function () {
            btn.disabled = false;
        });
    }

    function deleteActiveList() {
        var playlist = activePlaylist();
        if (!playlist) return;
        if (!window.confirm('¿Eliminar la lista «' + playlist.name + '»?')) return;

        state.playlists = state.playlists.filter(function (p) { return p.id !== playlist.id; });
        delete state.parsed[playlist.id];
        state.activeId = state.playlists.length ? state.playlists[0].id : null;
        window.IPTVStorage.savePlaylists(state.playlists);
        window.IPTVStorage.setActiveId(state.activeId);
        renderLibrary();
    }

    // ---------- Arranque ----------

    function bindEvents() {
        $('btn-add-list').addEventListener('click', function () {
            setAddError('');
            showView('add');
        });
        $('btn-add-cancel').addEventListener('click', function () { showView('library'); });

        document.querySelectorAll('input[name="source"]').forEach(function (radio) {
            radio.addEventListener('change', function () {
                var isUrl = radio.value === 'url' && radio.checked;
                $('field-url').hidden = !isUrl;
                $('field-text').hidden = isUrl;
            });
        });
        $('form-add').addEventListener('submit', onAddSubmit);

        $('playlist-select').addEventListener('change', function (e) {
            state.activeId = e.target.value;
            window.IPTVStorage.setActiveId(state.activeId);
            state.query = '';
            $('search').value = '';
            openGroups.clear();
            openGroupsInitialized = false;
            renderLibrary();
        });

        $('search').addEventListener('input', function (e) {
            state.query = e.target.value;
            renderLibrary();
        });

        $('btn-resume').addEventListener('click', function () {
            var last = window.IPTVStorage.getLastChannel();
            if (last && last.url) openChannel(last);
        });

        $('btn-refresh-list').addEventListener('click', refreshActiveList);
        $('btn-delete-list').addEventListener('click', deleteActiveList);

        $('btn-back').addEventListener('click', closePlayer);
        $('btn-close-error').addEventListener('click', closePlayer);
        $('btn-retry').addEventListener('click', retryPlayback);
        $('btn-fav-player').addEventListener('click', function () {
            if (!state.current) return;
            toggleFavorite(state.current.url);
            updatePlayerFav();
        });
        $('btn-fullscreen').addEventListener('click', toggleFullscreen);
        $('btn-send-tv').addEventListener('click', openTvMenu);
        $('btn-tv-menu-close').addEventListener('click', function () {
            $('tv-menu').hidden = true;
        });
        $('btn-cast-stop').addEventListener('click', function () {
            if (!state.casting) return;
            if (state.casting.protocol === 'dlna') {
                cordova.plugins.tvCast.stopDlna(state.casting.deviceId);
                if (window.TsProxy) window.TsProxy.stopLan();
                // DLNA no tiene evento de desconexión: hay que revertir aquí mismo
                // en vez de esperar a un callback (al contrario que Cast, donde lo
                // hace onSessionStateChanged('disconnected')).
                state.casting = null;
                $('cast-banner').hidden = true;
                $('video').hidden = false;
                updateSendTvButton();
                retryPlayback();
            } else {
                cordova.plugins.tvCast.stop();
            }
        });

        window.IPTVPlayer.init($('video'), {
            onPlaying: hidePlayerOverlay,
            onError: showPlayerError
        });
    }

    // Botón atrás de Android: primero cierra vistas secundarias en lugar de salir de la app.
    function bindBackButton() {
        document.addEventListener('backbutton', function () {
            if (!$('view-player').hidden) {
                closePlayer();
            } else if (!$('view-add').hidden) {
                showView('library');
            } else if (navigator.app && navigator.app.exitApp) {
                navigator.app.exitApp();
            }
        }, false);
    }

    // Mantiene el audio sonando al bloquear la pantalla: el plugin arranca un
    // foreground service (con notificación) solo mientras hay un canal activo
    // y la app está en segundo plano, evitando que Android corte la red/CPU.
    function bindBackgroundMode() {
        var bgMode = window.cordova && cordova.plugins && cordova.plugins.backgroundMode;
        if (!bgMode) return;

        bgMode.setDefaults({
            title: 'PlayTV',
            text: 'Reproduciendo en segundo plano'
        });

        // Se actualiza el título con el canal actual al evento 'activate'
        // (y no justo tras bgMode.enable()) porque configure() del propio
        // plugin solo actúa si ya está marcado como activo en el wrapper JS,
        // y eso tarda un viaje de ida y vuelta al nativo en confirmarse.
        bgMode.on('activate', function () {
            if (state.current) {
                bgMode.configure({ title: state.current.name });
            }
        });

        bgMode.on('mediapause', function () {
            window.IPTVPlayer.pauseBackgroundAudio();
        });

        bgMode.on('mediaplay', function () {
            window.IPTVPlayer.resumeBackgroundAudio();
        });

        document.addEventListener('pause', function () {
            if (window.IPTVPlayer.isActive()) {
                bgMode.enable();
                window.IPTVPlayer.enterBackground();
            }
        }, false);

        document.addEventListener('resume', function () {
            bgMode.disable();
            window.IPTVPlayer.exitBackground();
        }, false);
    }

    // Botón "Enviar a TV": abre un menú con el Chromecast (si hay uno disponible
    // y el canal es enviable, ver isCastable) y los TVs DLNA encontrados al
    // buscar. Mientras se envía a cualquiera de los dos, la reproducción local
    // se detiene y el canal se envía directamente desde el TV a la URL del
    // stream (sin pasar por el proxy CORS del móvil).
    function bindCastEvents() {
        var tvCast = window.cordova && cordova.plugins && cordova.plugins.tvCast;
        if (!tvCast) return;

        tvCast.onAvailabilityChanged(function (available) {
            state.castAvailable = available;
        });

        tvCast.onSessionStateChanged(function (evt) {
            if (evt.state === 'connected') {
                state.casting = { protocol: 'cast', deviceName: evt.deviceName || 'la TV' };
                window.IPTVPlayer.stop();
                $('video').hidden = true;
                $('cast-device-name').textContent = state.casting.deviceName;
                $('cast-banner').hidden = false;
                updateSendTvButton();
                if (state.current) {
                    tvCast.loadMedia(state.current.url, { title: state.current.name, contentType: castContentType(state.current) });
                }
            } else if (evt.state === 'disconnected') {
                var wasCasting = !!state.casting && state.casting.protocol === 'cast';
                if (!wasCasting) return;
                state.casting = null;
                $('cast-banner').hidden = true;
                $('video').hidden = false;
                updateSendTvButton();
                if (!$('view-player').hidden && state.current) {
                    retryPlayback();
                }
            }
        });

        tvCast.onDlnaEvent(function (evt) {
            var list = $('tv-menu-list');
            if (evt.type === 'found') {
                var li = document.createElement('li');
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = evt.name;
                btn.addEventListener('click', function () {
                    $('tv-menu').hidden = true;
                    state.casting = { protocol: 'dlna', deviceName: evt.name, deviceId: evt.id };
                    window.IPTVPlayer.stop();
                    $('video').hidden = true;
                    $('cast-device-name').textContent = evt.name;
                    $('cast-banner').hidden = false;
                    updateSendTvButton();
                    if (state.current) {
                        var opts = { title: state.current.name, contentType: castContentType(state.current) };
                        dlnaResolveUrl(state.current, function (url) {
                            tvCast.loadMediaDlna(evt.id, url, opts);
                        });
                    }
                });
                li.appendChild(btn);
                list.appendChild(li);
            } else if (evt.type === 'done') {
                var placeholder = $('tv-menu-searching');
                if (placeholder) placeholder.remove();
                if (!list.children.length) {
                    var empty = document.createElement('li');
                    empty.id = 'tv-menu-empty';
                    empty.textContent = 'No se han encontrado TVs';
                    list.appendChild(empty);
                }
            }
        });
    }

    function openTvMenu() {
        var tvCast = window.cordova && cordova.plugins && cordova.plugins.tvCast;
        if (!tvCast) return;
        var list = $('tv-menu-list');
        list.textContent = '';

        if (state.castAvailable && isCastable(state.current)) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = 'Chromecast';
            btn.addEventListener('click', function () {
                $('tv-menu').hidden = true;
                tvCast.showCastPicker();
            });
            li.appendChild(btn);
            list.appendChild(li);
        }

        var searching = document.createElement('li');
        searching.id = 'tv-menu-searching';
        searching.textContent = 'Buscando TVs…';
        list.appendChild(searching);

        $('tv-menu').hidden = false;
        tvCast.startDlnaDiscovery();
    }

    function start() {
        state.playlists = window.IPTVStorage.getPlaylists();
        state.activeId = window.IPTVStorage.getActiveId();
        state.favorites = window.IPTVStorage.getFavorites();
        if (!activePlaylist() && state.playlists.length) state.activeId = state.playlists[0].id;

        bindEvents();
        bindBackButton();
        bindBackgroundMode();
        bindCastEvents();
        showView('library');
        renderLibrary();
    }

    if (window.cordova) {
        document.addEventListener('deviceready', start, false);
    } else {
        start();
    }
})();
