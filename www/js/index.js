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
        query: ''
    };

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
        var li = document.createElement('li');
        li.className = 'channel';

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
        var favOn = isFavorite(channel.url);
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
        var h = document.createElement('h2');
        h.className = 'group-title';
        h.textContent = title + ' (' + channels.length + ')';
        wrap.appendChild(h);
        var ul = document.createElement('ul');
        ul.className = 'channels';
        channels.forEach(function (ch) { ul.appendChild(channelRow(ch)); });
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
        if (favs.length) list.appendChild(section('Favoritos', favs));

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

    function openChannel(channel) {
        state.current = channel;
        window.IPTVStorage.setLastChannel({ name: channel.name, url: channel.url, logo: channel.logo, group: channel.group, type: channel.type });

        $('player-title').textContent = channel.name;
        updatePlayerFav();
        showView('player');
        statusBar('hide');
        lockLandscape();
        setPlayerLoading('Cargando…');
        window.IPTVPlayer.play(channel);
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

    function start() {
        state.playlists = window.IPTVStorage.getPlaylists();
        state.activeId = window.IPTVStorage.getActiveId();
        state.favorites = window.IPTVStorage.getFavorites();
        if (!activePlaylist() && state.playlists.length) state.activeId = state.playlists[0].id;

        bindEvents();
        bindBackButton();
        showView('library');
        renderLibrary();
    }

    if (window.cordova) {
        document.addEventListener('deviceready', start, false);
    } else {
        start();
    }
})();
