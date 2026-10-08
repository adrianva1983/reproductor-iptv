(function (root) {
    'use strict';

    var KEYS = {
        playlists: 'iptv.playlists.v1',
        favorites: 'iptv.favorites.v1',
        last: 'iptv.lastChannel.v1',
        active: 'iptv.activePlaylist.v1'
    };

    function read(key, fallback) {
        try {
            var raw = root.localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    // Devuelve false si el almacenamiento está lleno o no disponible.
    function write(key, value) {
        try {
            root.localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    var api = {
        getPlaylists: function () { return read(KEYS.playlists, []); },
        savePlaylists: function (list) { return write(KEYS.playlists, list); },

        getActiveId: function () { return read(KEYS.active, null); },
        setActiveId: function (id) { return write(KEYS.active, id); },

        getFavorites: function () { return read(KEYS.favorites, []); },
        saveFavorites: function (urls) { return write(KEYS.favorites, urls); },

        getLastChannel: function () { return read(KEYS.last, null); },
        setLastChannel: function (channel) { return write(KEYS.last, channel); }
    };

    root.IPTVStorage = api;
})(typeof window !== 'undefined' ? window : globalThis);
