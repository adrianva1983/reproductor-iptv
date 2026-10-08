'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseM3U, isHlsUrl } = require('../www/js/m3u.js');

// Lista ficticia: dominios reservados (.invalid), sin credenciales reales.
const SAMPLE = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="canal1" tvg-name="Canal Uno HD" tvg-logo="https://logos.example.invalid/uno.png" group-title="Noticias",Canal Uno',
    'https://stream.example.invalid/hls/canal1/index.m3u8',
    '#EXTINF:-1 tvg-name="Pelicula Demo" group-title="Películas, Clásicos",Película Demo',
    'https://stream.example.invalid/vod/pelicula.mp4',
    ''
].join('\n');

test('parsea dos canales: uno HLS y uno mp4 directo', () => {
    const { channels, skipped } = parseM3U(SAMPLE);
    assert.equal(channels.length, 2);
    assert.equal(skipped, 0);

    const [hls, mp4] = channels;
    assert.equal(hls.name, 'Canal Uno');
    assert.equal(hls.tvgName, 'Canal Uno HD');
    assert.equal(hls.logo, 'https://logos.example.invalid/uno.png');
    assert.equal(hls.group, 'Noticias');
    assert.equal(hls.url, 'https://stream.example.invalid/hls/canal1/index.m3u8');
    assert.equal(hls.type, 'hls');

    assert.equal(mp4.name, 'Película Demo');
    assert.equal(mp4.type, 'direct');
    assert.equal(mp4.url, 'https://stream.example.invalid/vod/pelicula.mp4');
});

test('la coma dentro de comillas no separa el nombre del grupo', () => {
    const { channels } = parseM3U(SAMPLE);
    assert.equal(channels[1].group, 'Películas, Clásicos');
    assert.equal(channels[1].name, 'Película Demo');
});

test('acepta BOM y finales de línea CRLF', () => {
    const text = '﻿' + SAMPLE.replace(/\n/g, '\r\n');
    const { channels } = parseM3U(text);
    assert.equal(channels.length, 2);
    assert.equal(channels[0].name, 'Canal Uno');
});

test('omite URLs no http(s) y las cuenta', () => {
    const text = [
        '#EXTM3U',
        '#EXTINF:-1 group-title="Raro",Canal RTSP',
        'rtsp://stream.example.invalid/live',
        '#EXTINF:-1,Canal OK',
        'https://stream.example.invalid/ok.ts'
    ].join('\n');
    const { channels, skipped } = parseM3U(text);
    assert.equal(skipped, 1);
    assert.equal(channels.length, 1);
    assert.equal(channels[0].name, 'Canal OK');
    assert.equal(channels[0].group, 'Sin grupo');
});

test('si falta #EXTINF usa el nombre del fichero de la URL', () => {
    const { channels } = parseM3U('https://stream.example.invalid/directo/stream.m3u8?token=x');
    assert.equal(channels[0].name, 'stream.m3u8');
    assert.equal(channels[0].type, 'hls');
});

test('texto vacío o nulo devuelve lista vacía', () => {
    assert.deepEqual(parseM3U(''), { channels: [], skipped: 0 });
    assert.deepEqual(parseM3U(null), { channels: [], skipped: 0 });
});

test('detección de HLS por extensión, con o sin parámetros', () => {
    assert.equal(isHlsUrl('https://a.example.invalid/x.m3u8'), true);
    assert.equal(isHlsUrl('https://a.example.invalid/x.M3U8?t=1'), true);
    assert.equal(isHlsUrl('https://a.example.invalid/x.ts'), false);
    assert.equal(isHlsUrl('https://a.example.invalid/x.mp4'), false);
});
