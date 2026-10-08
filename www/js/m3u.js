(function (root) {
    'use strict';

    var HLS_RE = /\.m3u8?(?:$|[?#])/i;
    var HTTP_RE = /^https?:\/\//i;

    // La coma que separa atributos del nombre puede aparecer dentro de comillas (group-title="A, B").
    function splitExtinf(payload) {
        var inQuotes = false;
        for (var i = 0; i < payload.length; i++) {
            var ch = payload.charAt(i);
            if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
                return { head: payload.slice(0, i), title: payload.slice(i + 1).trim() };
            }
        }
        return { head: payload, title: '' };
    }

    function parseAttributes(head) {
        var attrs = {};
        var re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
        var m;
        while ((m = re.exec(head)) !== null) {
            attrs[m[1].toLowerCase()] = m[2];
        }
        return attrs;
    }

    function isHlsUrl(url) {
        return HLS_RE.test(url);
    }

    // Devuelve { channels, skipped }. Solo se aceptan URLs http/https; el resto cuenta como omitido.
    function parseM3U(text) {
        var lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
        var channels = [];
        var skipped = 0;
        var pending = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (line.indexOf('#EXTINF:') === 0) {
                var parts = splitExtinf(line.slice(8));
                var attrs = parseAttributes(parts.head);
                pending = {
                    title: parts.title,
                    tvgName: attrs['tvg-name'] || '',
                    logo: attrs['tvg-logo'] || '',
                    group: attrs['group-title'] || ''
                };
                continue;
            }

            if (line.charAt(0) === '#') continue;

            var info = pending || {};
            pending = null;

            if (!HTTP_RE.test(line)) {
                skipped++;
                continue;
            }

            var fallbackName = line.split('?')[0].split('/').pop() || line;
            channels.push({
                name: info.title || info.tvgName || fallbackName,
                tvgName: info.tvgName || '',
                logo: HTTP_RE.test(info.logo || '') ? info.logo : '',
                group: info.group || 'Sin grupo',
                url: line,
                type: isHlsUrl(line) ? 'hls' : 'direct'
            });
        }

        return { channels: channels, skipped: skipped };
    }

    var api = { parseM3U: parseM3U, isHlsUrl: isHlsUrl };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.M3U = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
