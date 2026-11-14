/* KoRifCan — TikTok statistics & stream metadata.
 *
 * Resolves a public TikTok URL through TikWM, then reads just enough of the
 * MP4 from TikTok's CDN to parse the container metadata locally with
 * mp4-patcher.js. No file is uploaded anywhere.
 *
 * Range requests are deliberately explicit (`bytes=0-N` or `bytes=A-B`).
 * `bytes=-N` is not CORS-safelisted, so it is never used.
 */
(function (global) {
  'use strict';

  var TIKWM_API = 'https://www.tikwm.com/api/';
  var TIKWM_ORIGIN = 'https://www.tikwm.com';
  var HEAD_BYTES = 2 * 1024 * 1024;
  var TAIL_BYTES = 2 * 1024 * 1024;
  var MAX_READ_BYTES = 4 * 1024 * 1024;
  var CACHE_TTL = 10 * 60 * 1000;
  var CACHE_PREFIX = 'korifcan.tiktokStats.v1.';
  var CACHE_VERSION = 4;
  var RESOLVE_TIMEOUT = 15000;
  var PROBE_TIMEOUT = 25000;
  var MAX_BLOB_DOWNLOAD = 200 * 1024 * 1024;

  var state = {
    controller: null,
    token: 0,
    lastUrl: '',
    busy: false,
    submitLabel: null,
    submitLabelText: '',
    regionNames: null,
    dateFormatter: null,
    downloadUrl: '',
    downloadName: '',
    downloadSize: 0,
    downloadBusy: false,
    downloadController: null,
    downloadToken: 0
  };

  var el = {};

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function toNumber(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  function toSize(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  function cleanText(value) {
    if (value == null) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function hashString(value) {
    var text = String(value || '');
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function readU32(bytes, offset) {
    return bytes[offset] * 16777216 + bytes[offset + 1] * 65536 +
      bytes[offset + 2] * 256 + bytes[offset + 3];
  }

  function readBoxType(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function readBoxAt(bytes, offset, end) {
    if (offset < 0 || offset + 8 > end) return null;
    var size = readU32(bytes, offset);
    var typeValue = readU32(bytes, offset + 4);
    var header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      size = readU32(bytes, offset + 8) * 4294967296 + readU32(bytes, offset + 12);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header) return null;
    var boxEnd = offset + size;
    if (boxEnd > end) boxEnd = end;
    return {
      type: readBoxType(bytes, offset + 4),
      typeValue: typeValue,
      start: offset,
      payloadStart: offset + header,
      end: boxEnd
    };
  }

  function readBoxChildren(bytes, start, end) {
    var boxes = [];
    var offset = start;
    while (offset + 8 <= end) {
      var box = readBoxAt(bytes, offset, end);
      if (!box || box.end <= offset) break;
      boxes.push(box);
      offset = box.end;
    }
    return boxes;
  }

  function findChildBox(boxes, type) {
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].type === type) return boxes[i];
    }
    return null;
  }

  function findMoovBox(bytes) {
    var top = readBoxChildren(bytes, 0, bytes.length);
    var moov = findChildBox(top, 'moov');
    if (moov) return moov;
    for (var i = 4; i + 8 <= bytes.length; i++) {
      if (bytes[i] !== 0x6d || bytes[i + 1] !== 0x6f ||
          bytes[i + 2] !== 0x6f || bytes[i + 3] !== 0x76) continue;
      var candidate = readBoxAt(bytes, i - 4, bytes.length);
      if (candidate && candidate.type === 'moov') return candidate;
    }
    return null;
  }

  function readUtf8Bytes(bytes, start, end) {
    if (end <= start) return '';
    var text = '';
    try {
      if (typeof global.TextDecoder === 'function') {
        text = new global.TextDecoder('utf-8').decode(bytes.subarray(start, end));
      }
    } catch (err) {
      text = '';
    }
    if (!text) {
      for (var i = start; i < end; i++) text += String.fromCharCode(bytes[i]);
    }
    return text.replace(/\0/g, '');
  }

  function readDataBoxText(bytes, box) {
    if (!box || box.payloadStart + 8 > box.end) return '';
    var type = readU32(bytes, box.payloadStart);
    var start = box.payloadStart + 8;
    if (type === 2) {
      var text = '';
      for (var i = start; i + 1 < box.end; i += 2) {
        text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return text.replace(/\0/g, '');
    }
    return readUtf8Bytes(bytes, start, box.end);
  }

  function readMetadataKeys(bytes, box) {
    var keys = [];
    if (!box || box.payloadStart + 8 > box.end) return keys;
    var count = readU32(bytes, box.payloadStart + 4);
    var offset = box.payloadStart + 8;
    for (var i = 0; i < count && offset + 8 <= box.end; i++) {
      var size = readU32(bytes, offset);
      if (size < 8 || offset + size > box.end) break;
      keys.push(readUtf8Bytes(bytes, offset + 8, offset + size));
      offset += size;
    }
    return keys;
  }

  function readMetaValues(bytes, metaBox) {
    var values = { artist: '', comment: '' };
    if (!metaBox) return values;
    var children = readBoxChildren(bytes, metaBox.payloadStart + 4, metaBox.end);
    var keysBox = findChildBox(children, 'keys');
    var ilst = findChildBox(children, 'ilst');
    if (!ilst) return values;
    var keys = keysBox ? readMetadataKeys(bytes, keysBox) : [];
    var items = readBoxChildren(bytes, ilst.payloadStart, ilst.end);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var key = item.typeValue > 0 && item.typeValue <= keys.length
        ? keys[item.typeValue - 1]
        : item.type;
      if (key !== 'artist' && key !== 'comment' &&
          key !== '\u00a9ART' && key !== '\u00a9cmt') continue;
      var data = findChildBox(readBoxChildren(bytes, item.payloadStart, item.end), 'data');
      if (!data) continue;
      var value = cleanText(readDataBoxText(bytes, data));
      if (!value) continue;
      if (key === 'artist' || key === '\u00a9ART') {
        if (!values.artist) values.artist = value;
      } else if (!values.comment) {
        values.comment = value;
      }
    }
    return values;
  }

  function readRecipeMetadata(bytes) {
    var values = { artist: '', comment: '' };
    var moov = findMoovBox(bytes);
    if (!moov) return values;
    var moovChildren = readBoxChildren(bytes, moov.payloadStart, moov.end);
    var metas = [];
    var direct = findChildBox(moovChildren, 'meta');
    if (direct) metas.push(direct);
    var udta = findChildBox(moovChildren, 'udta');
    if (udta) {
      var udtaChildren = readBoxChildren(bytes, udta.payloadStart, udta.end);
      for (var i = 0; i < udtaChildren.length; i++) {
        if (udtaChildren[i].type === 'meta') metas.push(udtaChildren[i]);
      }
    }
    for (var m = 0; m < metas.length; m++) {
      var parsed = readMetaValues(bytes, metas[m]);
      if (!values.artist && parsed.artist) values.artist = parsed.artist;
      if (!values.comment && parsed.comment) values.comment = parsed.comment;
    }
    return values;
  }

  function assertNotAborted(signal) {
    if (!signal || !signal.aborted) return;
    var err = new Error('Permintaan dibatalkan.');
    err.name = 'AbortError';
    throw err;
  }

  function makeError(code, message, extra) {
    var err = new Error(message || code);
    err.name = 'TikTokStatsError';
    err.code = code;
    if (extra) {
      for (var key in extra) {
        if (hasOwn(extra, key)) err[key] = extra[key];
      }
    }
    return err;
  }

  function isStatsError(err) {
    return !!(err && err.name === 'TikTokStatsError' && err.code);
  }

  function abortedError(message) {
    return makeError('ABORTED', message || 'Permintaan dibatalkan.');
  }

  function extractSignal(value) {
    if (!value) return null;
    if (typeof value === 'object' && typeof value.aborted === 'boolean' &&
        typeof value.addEventListener === 'function') {
      return value;
    }
    if (typeof value === 'object' && value.signal) return extractSignal(value.signal);
    return null;
  }

  function makeAbortContext(parentSignal, timeoutMs) {
    var controller = null;
    var signal = parentSignal || null;
    var timer = null;
    var timedOut = false;
    var onAbort = null;
    var AbortCtor = global.AbortController;

    if (typeof AbortCtor === 'function') {
      controller = new AbortCtor();
      signal = controller.signal;
      if (parentSignal) {
        if (parentSignal.aborted) {
          controller.abort();
        } else {
          onAbort = function () { controller.abort(); };
          try {
            parentSignal.addEventListener('abort', onAbort, { once: true });
          } catch (err) {
            parentSignal.addEventListener('abort', onAbort);
          }
        }
      }
      if (timeoutMs > 0) {
        timer = global.setTimeout(function () {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      }
    }

    return {
      signal: signal,
      timedOut: function () { return timedOut; },
      dispose: function () {
        if (timer) {
          global.clearTimeout(timer);
          timer = null;
        }
        if (parentSignal && onAbort) {
          try { parentSignal.removeEventListener('abort', onAbort); } catch (err) { /* ignore */ }
        }
        onAbort = null;
      }
    };
  }

  function translateRequestError(err, ctx, externalSignal) {
    if (isStatsError(err)) return err;
    if (externalSignal && externalSignal.aborted) return abortedError();
    if (ctx && ctx.timedOut()) {
      return makeError('TIMEOUT', 'Permintaan terlalu lama. Periksa koneksi lalu coba lagi.');
    }
    if (err && err.name === 'AbortError') {
      return externalSignal ? abortedError() : makeError('TIMEOUT', 'Permintaan terlalu lama.');
    }
    return makeError('NETWORK', 'Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.');
  }

  function httpFetch(url, options) {
    if (typeof global.fetch !== 'function') {
      return Promise.reject(makeError('NETWORK', 'Browser ini tidak mendukung fetch.'));
    }
    return global.fetch(url, options);
  }

  // ---------------------------------------------------------------------
  // Formatting (Indonesian)
  // ---------------------------------------------------------------------

  var numberFormatter = null;
  var compactFormatter = null;
  var compactUnsupported = false;
  var dateFormatter = null;

  function fallbackNumber(n) {
    var text = String(n);
    var parts = text.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    if (parts.length > 1) return parts[0] + ',' + parts[1];
    return parts[0];
  }

  function formatNumber(value) {
    var n = toNumber(value);
    try {
      if (!numberFormatter) numberFormatter = new Intl.NumberFormat('id-ID');
      return numberFormatter.format(n);
    } catch (err) {
      return fallbackNumber(n);
    }
  }

  function formatDecimal(value, digits) {
    var n = toNumber(value);
    var max = typeof digits === 'number' ? digits : 2;
    try {
      return n.toLocaleString('id-ID', {
        minimumFractionDigits: 0,
        maximumFractionDigits: max
      });
    } catch (err) {
      return String(n);
    }
  }

  function formatCompact(value) {
    var n = toNumber(value);
    if (!compactUnsupported) {
      try {
        if (!compactFormatter) {
          compactFormatter = new Intl.NumberFormat('id-ID', {
            notation: 'compact',
            maximumFractionDigits: 1
          });
          /* Older engines ignore `notation` without throwing. */
          var probe = compactFormatter.format(1200).replace(/[\u00a0\u202f]/g, ' ');
          if (probe === formatNumber(1200) || !/[a-z]/i.test(probe)) {
            compactUnsupported = true;
          }
        }
        if (!compactUnsupported) {
          return compactFormatter.format(n).replace(/[\u00a0\u202f]/g, ' ');
        }
      } catch (err) {
        compactUnsupported = true;
      }
    }
    var abs = Math.abs(n);
    var sign = n < 0 ? '-' : '';
    if (abs >= 1e12) return sign + formatDecimal(abs / 1e12, 1) + ' T';
    if (abs >= 1e9) return sign + formatDecimal(abs / 1e9, 1) + ' M';
    if (abs >= 1e6) return sign + formatDecimal(abs / 1e6, 1) + ' jt';
    if (abs >= 1e3) return sign + formatDecimal(abs / 1e3, 1) + ' rb';
    return formatNumber(n);
  }

  function formatBytes(value) {
    var n = Math.max(0, toNumber(value));
    if (!n) return '0 B';
    if (n < 1024) return formatNumber(Math.round(n)) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do {
      n = n / 1024;
      i++;
    } while (n >= 1024 && i < units.length - 1);
    var digits = n >= 100 ? 0 : (n >= 10 ? 1 : 2);
    return formatDecimal(n, digits) + ' ' + units[i];
  }

  function formatSpeed(value) {
    var n = Math.max(0, toNumber(value));
    if (!n) return '';
    if (n >= 1024 * 1024) {
      var mbps = n / (1024 * 1024);
      return formatDecimal(mbps, mbps >= 10 ? 0 : 1) + ' MB/s';
    }
    if (n >= 1024) return formatNumber(Math.round(n / 1024)) + ' KB/s';
    return formatNumber(Math.round(n)) + ' B/s';
  }

  function formatBitrate(value) {
    var bps = Math.max(0, toNumber(value));
    if (!bps) return '—';
    if (bps >= 1000000) {
      var mbps = bps / 1000000;
      return formatDecimal(mbps, mbps >= 10 ? 1 : 2) + ' Mbps';
    }
    if (bps >= 1000) return formatNumber(Math.round(bps / 1000)) + ' kbps';
    return formatNumber(Math.round(bps)) + ' bps';
  }

  function formatDuration(value) {
    var total = Math.max(0, Math.round(toNumber(value)));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    if (minutes > 0) return minutes + 'm ' + seconds + 's';
    return seconds + 's';
  }

  function formatFps(input, mode) {
    var fps;
    var fpsMode = mode;
    if (input && typeof input === 'object') {
      fps = toNumber(input.fps);
      fpsMode = input.fpsMode;
    } else {
      fps = toNumber(input);
    }
    if (!fps) return '—';
    var digits = Math.abs(fps - Math.round(fps)) < 0.02 ? 0 : 2;
    return (fpsMode === 'vfr' ? '~' : '') + formatDecimal(fps, digits) + ' fps';
  }

  function formatPercent(value, digits) {
    var places = typeof digits === 'number' ? digits : 2;
    var n = toNumber(value);
    try {
      return n.toLocaleString('id-ID', {
        minimumFractionDigits: places,
        maximumFractionDigits: places
      }) + '%';
    } catch (err) {
      return n.toFixed(places).replace('.', ',') + '%';
    }
  }

  function videoCodec(input) {
    var video;
    if (typeof input === 'string') video = { codec: input };
    else if (input && input.video) video = input.video;
    else video = input || {};

    var type = cleanText(video.codec);
    var profileIdc = toNumber(video.profileIdc);
    var label = '';

    if (type === 'avc1' || type === 'avc3') {
      if (profileIdc === 66) label = 'Baseline';
      else if (profileIdc === 77) label = 'Main';
      else if (profileIdc === 88) label = 'Extended';
      else if (profileIdc === 100) label = 'High';
      else if (profileIdc === 110) label = 'High 10';
      else if (profileIdc === 122) label = 'High 4:2:2';
      else if (profileIdc === 244) label = 'High 4:4:4';
      return 'H.264' + (label ? ' ' + label : '');
    }
    if (type === 'hev1' || type === 'hvc1') {
      if (profileIdc === 1) label = 'Main';
      else if (profileIdc === 2) label = 'Main 10';
      else if (profileIdc === 3) label = 'Main Still';
      else if (profileIdc === 4) label = 'RExt';
      return 'HEVC' + (label ? ' ' + label : '');
    }
    if (type === 'av01') return 'AV1';
    if (type === 'vp09') return 'VP9';
    if (type === 'mp4v') return 'MPEG-4';
    return type ? type.toUpperCase() : '—';
  }

  function audioCodec(input) {
    var audio;
    if (typeof input === 'string') audio = { codec: input };
    else audio = input || {};
    var type = cleanText(audio.codec);
    if (!type) return '—';
    var names = {
      mp4a: 'AAC',
      alac: 'ALAC',
      'ac-3': 'AC-3',
      'ec-3': 'E-AC-3',
      Opus: 'Opus',
      opus: 'Opus',
      fLaC: 'FLAC',
      lpcm: 'PCM',
      samr: 'AMR'
    };
    if (hasOwn(names, type)) return names[type];
    if (type === 'mp3' || type === '.mp3') return 'MP3';
    return type.toUpperCase();
  }

  function channelLabel(channels) {
    var count = toNumber(channels);
    if (count === 1) return 'mono';
    if (count === 2) return 'stereo';
    if (count === 6) return '5.1';
    if (count === 8) return '7.1';
    if (count > 0) return count + ' kanal';
    return '';
  }

  function formatSampleRate(value) {
    var rate = toNumber(value);
    if (!rate) return '';
    if (rate >= 1000) {
      var khz = rate / 1000;
      var oneDecimal = Math.abs(khz * 10 - Math.round(khz * 10)) < 0.001;
      return formatDecimal(khz, oneDecimal ? 1 : 2) + ' kHz';
    }
    return formatNumber(Math.round(rate)) + ' Hz';
  }

  function formatAudio(input) {
    var audio = input || {};
    if (!audio || !audio.codec) return 'Tidak ada audio';
    var parts = [audioCodec(audio)];
    var rate = formatSampleRate(audio.sampleRate);
    if (rate) parts.push(rate);
    var channels = channelLabel(audio.channels);
    if (channels) parts.push(channels);
    if (toNumber(audio.trackCount) > 1) parts.push(toNumber(audio.trackCount) + ' trek');
    return parts.join(' · ');
  }

  function colorLabel(color) {
    if (!color) return 'Tidak ditandai';
    var primaries = {
      1: 'BT.709', 4: 'BT.470M', 5: 'BT.601 PAL', 6: 'BT.601 NTSC',
      7: 'SMPTE 240M', 8: 'Film', 9: 'BT.2020', 10: 'BT.2020',
      11: 'SMPTE 428', 12: 'Display P3', 22: 'EBU 3213'
    }[toNumber(color.primaries)] || ('Primer ' + toNumber(color.primaries));
    var transfer = {
      1: 'SDR', 4: 'Gamma 2.2', 5: 'Gamma 2.8', 6: 'SDR', 7: 'SMPTE 240M',
      8: 'Linear', 9: 'Log100', 10: 'Log316', 11: 'xvYCC', 12: 'BT.1361',
      13: 'sRGB', 14: 'BT.2020 10-bit', 15: 'BT.2020 12-bit',
      16: 'PQ', 17: 'SMPTE 428', 18: 'HLG'
    }[toNumber(color.transfer)] || ('Transfer ' + toNumber(color.transfer));
    return primaries + ' · ' + transfer;
  }

  function hdrLabel(input, info) {
    if (typeof input === 'string') {
      var direct = {
        sdr: 'SDR',
        hdr10: 'HDR10',
        hdr10plus: 'HDR10+',
        hlg: 'HLG',
        'dolby-vision': 'Dolby Vision',
        unknown: 'Tidak ditandai'
      };
      return direct[input] || input;
    }

    var hdr = input;
    if (hdr && hdr.found) {
      if (hdr.dolbyVision || hdr.kind === 'dolby-vision') return 'Dolby Vision';
      if (hdr.hdr10plus || hdr.kind === 'hdr10plus') return 'HDR10+';
      if (hdr.kind === 'hdr10') return 'HDR10';
      if (hdr.kind === 'hlg') return 'HLG';
      if (hdr.kind === 'sdr') return 'SDR';
      if (hdr.kind === 'unknown') return 'Tidak ditandai';
    }

    var color = (hdr && hdr.color) || (info && info.color) || null;
    if (color) {
      var transfer = toNumber(color.transfer);
      if (transfer === 16) return 'HDR10';
      if (transfer === 18) return 'HLG';
      if (transfer === 1 || transfer === 6) return 'SDR';
    }
    return 'Tidak ditandai';
  }

  var format = {
    number: formatNumber,
    compact: formatCompact,
    bytes: formatBytes,
    speed: formatSpeed,
    bitrate: formatBitrate,
    duration: formatDuration,
    fps: formatFps,
    percent: formatPercent,
    videoCodec: videoCodec,
    audioCodec: audioCodec,
    audio: formatAudio,
    color: colorLabel,
    hdr: hdrLabel
  };

  // ---------------------------------------------------------------------
  // URL handling
  // ---------------------------------------------------------------------

  function trimUrlPunctuation(value) {
    return String(value || '').replace(/[)\].,;!?]+$/g, '');
  }

  function isAllowedHost(host) {
    host = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!host) return false;
    if (host === 'tiktok.com' || host === 'tt.site') return true;
    return /\.tiktok\.com$/.test(host) || /\.tt\.site$/.test(host);
  }

  function extractUrlText(raw) {
    var text = cleanText(raw);
    if (!text) return '';

    var absolute = text.match(/https?:\/\/[^\s<>"']+/ig);
    if (absolute && absolute.length) {
      for (var i = 0; i < absolute.length; i++) {
        var candidate = trimUrlPunctuation(absolute[i]);
        try {
          var parsed = new URL(candidate);
          if (isAllowedHost(parsed.hostname)) return candidate;
        } catch (err) { /* try the next candidate */ }
      }
      return trimUrlPunctuation(absolute[0]);
    }

    var bare = text.match(/(?:^|\s)((?:[a-z0-9-]+\.)*(?:tiktok\.com|tt\.site)(?:\/[^\s<>"']*)?)/i);
    if (bare) return 'https://' + trimUrlPunctuation(bare[1]);

    return text;
  }

  function normalizeTikTokUrl(raw) {
    var text = extractUrlText(raw);
    if (!text) {
      throw makeError('INVALID_URL', 'Tempel link video TikTok dulu.');
    }
    if (text.charAt(0) === '/' && text.charAt(1) === '/') text = 'https:' + text;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;

    var parsed;
    try {
      parsed = new URL(text);
    } catch (err) {
      throw makeError('INVALID_URL', 'Link TikTok tidak valid.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw makeError('INVALID_URL', 'Link harus memakai http atau https.');
    }
    if (!isAllowedHost(parsed.hostname)) {
      throw makeError('INVALID_URL', 'Link bukan dari tiktok.com, vt.tiktok.com, vm.tiktok.com, atau tt.site.');
    }

    parsed.protocol = 'https:';
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.href;
  }

  function extractVideoId(url) {
    var match = /\/video\/(\d{5,})/.exec(String(url || '')) ||
                /\/v\/(\d{5,})/.exec(String(url || ''));
    return match ? match[1] : '';
  }

  function extractUsername(url) {
    var match = /\/@([^/?#]+)/.exec(String(url || ''));
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]).replace(/^@+/, '');
    } catch (err) {
      return match[1].replace(/^@+/, '');
    }
  }

  function safeAssetUrl(value) {
    var text = cleanText(value);
    if (!text) return '';
    try {
      var parsed = new URL(text, TIKWM_ORIGIN + '/');
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (parsed.protocol === 'http:') parsed.protocol = 'https:';
      return parsed.href;
    } catch (err) {
      return '';
    }
  }

  function absoluteCdnUrl(value) {
    var text = String(value == null ? '' : value).trim();
    if (!text) return '';
    try {
      var parsed = new URL(text, TIKWM_ORIGIN + '/');
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (parsed.protocol === 'http:') parsed.protocol = 'https:';
      return parsed.href;
    } catch (err) {
      return '';
    }
  }

  // ---------------------------------------------------------------------
  // Session cache (successful results only, never errors)
  // ---------------------------------------------------------------------

  function getSessionStorage() {
    try {
      return global.sessionStorage || null;
    } catch (err) {
      return null;
    }
  }

  function cacheKey(id) {
    return CACHE_PREFIX + String(id || '');
  }

  function readCache(id) {
    if (!id) return null;
    var storage = getSessionStorage();
    if (!storage) return null;
    var key = cacheKey(id);
    try {
      var raw = storage.getItem(key);
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || entry.v !== CACHE_VERSION || !entry.data || !entry.savedAt) {
        storage.removeItem(key);
        return null;
      }
      if (Date.now() - entry.savedAt > CACHE_TTL) {
        storage.removeItem(key);
        return null;
      }
      if (!entry.data.stream || !entry.data.stream.info || !entry.data.stream.info.found) {
        storage.removeItem(key);
        return null;
      }
      return entry.data;
    } catch (err) {
      return null;
    }
  }

  function writeCache(id, data) {
    if (!id || !data || !data.stream || !data.stream.info || !data.stream.info.found) return;
    var storage = getSessionStorage();
    if (!storage) return;
    try {
      storage.setItem(cacheKey(id), JSON.stringify({
        v: CACHE_VERSION,
        savedAt: Date.now(),
        data: data
      }));
    } catch (err) {
      /* Private mode or quota exceeded: caching is optional. */
    }
  }

  // ---------------------------------------------------------------------
  // TikWM resolution
  // ---------------------------------------------------------------------

  function mapTikwmMessage(message, code) {
    var text = cleanText(message).toLowerCase();
    if (/private|not found|no video|unavailable|removed|deleted|photo|image|slideshow|region|country/.test(text)) {
      return makeError('NO_VIDEO', 'Video tidak tersedia. Pastikan postingan publik, bukan foto/slideshow, dan belum dihapus.', {
        apiCode: code,
        detail: message
      });
    }
    if (/limit|too many|busy|rate|blocked|forbidden|denied|request/.test(text)) {
      return makeError('TIKWM_BLOCKED', 'TikWM sedang membatasi permintaan. Coba lagi beberapa saat.', {
        apiCode: code,
        detail: message
      });
    }
    return makeError('TIKWM_ERROR', 'TikWM tidak bisa memproses link ini. Pastikan video publik lalu coba lagi.', {
      apiCode: code,
      detail: message
    });
  }

  async function resolve(input, signalOrOptions) {
    var url = normalizeTikTokUrl(input);
    var signal = extractSignal(signalOrOptions);
    var ctx = makeAbortContext(signal, RESOLVE_TIMEOUT);
    var apiUrl = TIKWM_API + '?url=' + encodeURIComponent(url) + '&hd=1';

    try {
      var response;
      try {
        response = await httpFetch(apiUrl, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          signal: ctx.signal
        });
      } catch (err) {
        throw translateRequestError(err, ctx, signal);
      }

      if (!response.ok) {
        if (response.status === 403 || response.status === 429 || response.status === 451) {
          throw makeError('TIKWM_BLOCKED', 'TikWM menolak permintaan (HTTP ' + response.status + '). Coba lagi beberapa saat.', {
            status: response.status
          });
        }
        throw makeError('TIKWM_ERROR', 'TikWM sedang bermasalah (HTTP ' + response.status + '). Coba lagi nanti.', {
          status: response.status
        });
      }

      var json;
      try {
        json = await response.json();
      } catch (err) {
        if (err && err.name === 'SyntaxError') {
          throw makeError('TIKWM_ERROR', 'Respons TikWM tidak valid. Coba lagi nanti.');
        }
        throw translateRequestError(err, ctx, signal);
      }

      if (!json || Number(json.code) !== 0) {
        throw mapTikwmMessage(json && json.msg, json && json.code);
      }
      if (!json.data || typeof json.data !== 'object' || Array.isArray(json.data)) {
        throw makeError('TIKWM_ERROR', 'TikWM tidak mengembalikan data video.');
      }

      var data = json.data;
      var hasPlay = !!(data.hdplay || data.play || data.wmplay);
      if (data.images && !hasPlay) {
        throw makeError('NO_VIDEO', 'Postingan ini berupa foto/slideshow, bukan video.');
      }
      if (!hasPlay && !data.id) {
        throw makeError('NO_VIDEO', 'TikTok tidak menyediakan stream video untuk postingan ini.');
      }

      return data;
    } catch (err) {
      throw translateRequestError(err, ctx, signal);
    } finally {
      ctx.dispose();
    }
  }

  // ---------------------------------------------------------------------
  // CDN probing
  // ---------------------------------------------------------------------

  function inspectVideoSafe(patcher, bytes) {
    if (!bytes || !bytes.length) return { found: false };
    try {
      var info = patcher.inspectVideo(bytes);
      return info && typeof info === 'object' ? info : { found: false };
    } catch (err) {
      return { found: false };
    }
  }

  function inspectHdrSafe(patcher, bytes) {
    if (!bytes || !bytes.length || typeof patcher.inspectHdr !== 'function') return null;
    try {
      return patcher.inspectHdr(bytes, { scanSamples: false });
    } catch (err) {
      return null;
    }
  }

  function responseContentLength(response) {
    try {
      var value = response && response.headers && response.headers.get('content-length');
      var length = parseInt(value, 10);
      return isFinite(length) && length > 0 ? length : 0;
    } catch (err) {
      return 0;
    }
  }

  function concatChunks(chunks, total) {
    var out = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  async function readCapped(response, cap, signal) {
    var contentLength = responseContentLength(response);
    if (response.body && typeof response.body.getReader === 'function') {
      var reader = response.body.getReader();
      var chunks = [];
      var total = 0;
      var truncated = false;
      try {
        while (true) {
          assertNotAborted(signal);
          var step = await reader.read();
          if (step.done) break;
          var value = step.value;
          if (!value) continue;
          var chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          var remaining = cap - total;
          if (remaining <= 0) {
            truncated = true;
            try { await reader.cancel(); } catch (err) { /* ignore */ }
            break;
          }
          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining));
            total += remaining;
            truncated = true;
            try { await reader.cancel(); } catch (err) { /* ignore */ }
            break;
          }
          chunks.push(chunk);
          total += chunk.length;
          if (total >= cap) {
            truncated = true;
            try { await reader.cancel(); } catch (err) { /* ignore */ }
            break;
          }
        }
      } catch (err) {
        try { await reader.cancel(); } catch (cancelErr) { /* ignore */ }
        throw err;
      }
      return {
        bytes: concatChunks(chunks, total),
        truncated: truncated,
        contentLength: contentLength
      };
    }

    assertNotAborted(signal);
    var buffer = await response.arrayBuffer();
    var all = new Uint8Array(buffer);
    if (all.length > cap) {
      return {
        bytes: all.subarray(0, cap),
        truncated: true,
        contentLength: contentLength
      };
    }
    return { bytes: all, truncated: false, contentLength: contentLength };
  }

  async function fetchHeadSize(url, signal) {
    try {
      var response = await httpFetch(url, {
        method: 'HEAD',
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: signal
      });
      if (!response || !response.ok) return 0;
      return responseContentLength(response);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      return 0;
    }
  }

  async function requestRange(url, start, end, signal) {
    var response;
    try {
      response = await httpFetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        headers: { Range: 'bytes=' + start + '-' + end },
        signal: signal
      });
    } catch (err) {
      throw err;
    }

    if (response.status !== 200 && response.status !== 206) {
      throw makeError('RANGE_REJECTED', 'CDN menolak permintaan rentang (HTTP ' + response.status + ').', {
        status: response.status
      });
    }
    return response;
  }

  async function runProbe(url, expectedSize, signal, patcher) {
    var totalSize = expectedSize;
    var hadKnownSize = totalSize > 0;
    if (!totalSize) {
      totalSize = await fetchHeadSize(url, signal);
      hadKnownSize = totalSize > 0;
    }

    var headEnd = totalSize > 0
      ? Math.min(totalSize - 1, HEAD_BYTES - 1)
      : HEAD_BYTES - 1;

    var headResponse = await requestRange(url, 0, headEnd, signal);
    var headRead = await readCapped(headResponse, MAX_READ_BYTES, signal);
    var bytesRead = headRead.bytes.length;
    var rangeHonored = headResponse.status === 206;
    var recipeMeta = readRecipeMetadata(headRead.bytes);

    if (!totalSize && headResponse.status === 200) {
      var fromHead = responseContentLength(headResponse);
      if (fromHead > 0) totalSize = fromHead;
    }

    var headInfo = inspectVideoSafe(patcher, headRead.bytes);
    var info = headInfo;
    var hdr = null;
    var method = 'none';
    var found = false;

    if (headInfo && headInfo.found) {
      found = true;
      method = 'head';
      hdr = inspectHdrSafe(patcher, headRead.bytes);
    } else if (rangeHonored && hadKnownSize && totalSize > headRead.bytes.length) {
      var start = Math.max(0, totalSize - TAIL_BYTES);
      var end = totalSize - 1;
      var tailResponse = await requestRange(url, start, end, signal);
      var tailRead = await readCapped(tailResponse, MAX_READ_BYTES, signal);
      bytesRead += tailRead.bytes.length;
      var tailMeta = readRecipeMetadata(tailRead.bytes);
      recipeMeta = {
        artist: recipeMeta.artist || tailMeta.artist,
        comment: recipeMeta.comment || tailMeta.comment
      };
      var tailInfo = inspectVideoSafe(patcher, tailRead.bytes);
      if (tailInfo && tailInfo.found) {
        found = true;
        info = tailInfo;
        hdr = inspectHdrSafe(patcher, tailRead.bytes);
        /* A 200 means the server sent the start of the file again, not the tail. */
        method = tailResponse.status === 206 ? 'tail' : 'head';
      }
    }

    if (!totalSize) totalSize = bytesRead;
    if (found && totalSize > 0 && bytesRead >= totalSize) method = 'full';

    return {
      info: info || { found: false },
      hdr: hdr,
      method: method,
      totalSize: totalSize,
      bytesRead: bytesRead,
      rangeHonored: rangeHonored,
      recipeArtist: recipeMeta.artist,
      recipeComment: recipeMeta.comment,
      url: url
    };
  }

  async function probeStream(url, expectedSize, signalOrOptions) {
    var streamUrl = String(url == null ? '' : url).trim();
    if (!streamUrl) {
      throw makeError('STREAM_UNAVAILABLE', 'URL stream kosong.');
    }
    var patcher = global.KoRifCanPatcher;
    if (!patcher || typeof patcher.inspectVideo !== 'function') {
      throw makeError('PATCHER_MISSING', 'Parser MP4 tidak termuat.');
    }

    var signal = extractSignal(signalOrOptions);
    var ctx = makeAbortContext(signal, PROBE_TIMEOUT);
    try {
      return await runProbe(streamUrl, toSize(expectedSize), ctx.signal, patcher);
    } catch (err) {
      throw translateRequestError(err, ctx, signal);
    } finally {
      ctx.dispose();
    }
  }

  // ---------------------------------------------------------------------
  // Normalization
  // ---------------------------------------------------------------------

  function pickNumber(source, keys) {
    if (!source) return 0;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (source[key] == null) continue;
      var n = Number(source[key]);
      if (isFinite(n)) return n;
    }
    return 0;
  }

  function normalizeTikwmData(data, sourceUrl) {
    var authorSource = data.author && typeof data.author === 'object' ? data.author : {};
    var uniqueId = cleanText(authorSource.unique_id || data.unique_id);
    if (!uniqueId && typeof data.author === 'string') uniqueId = cleanText(data.author);
    if (!uniqueId) uniqueId = extractUsername(sourceUrl);
    uniqueId = uniqueId.replace(/^@+/, '');

    var nickname = cleanText(authorSource.nickname || data.nickname) || uniqueId;
    var avatar = safeAssetUrl(authorSource.avatar || data.avatar || '');

    var id = cleanText(data.id || data.video_id || data.aweme_id) || extractVideoId(sourceUrl);
    if (!id) id = 'url-' + hashString(sourceUrl);

    var cover = safeAssetUrl(
      data.cover || data.origin_cover || data.ai_dynamic_cover || data.dynamic_cover || ''
    );

    var createTime = pickNumber(data, ['create_time', 'createTime']);
    if (createTime > 1e12) createTime = Math.floor(createTime / 1000);

    var stats = {
      views: pickNumber(data, ['play_count', 'view_count']),
      likes: pickNumber(data, ['digg_count', 'like_count']),
      comments: pickNumber(data, ['comment_count']),
      shares: pickNumber(data, ['share_count']),
      saves: pickNumber(data, ['collect_count', 'collect', 'save_count'])
    };
    var interactions = stats.likes + stats.comments + stats.shares + stats.saves;
    var engagementRate = stats.views > 0 ? (interactions / stats.views) * 100 : 0;

    return {
      id: id,
      title: cleanText(data.title || data.desc || ''),
      author: {
        uniqueId: uniqueId,
        nickname: nickname,
        avatar: avatar
      },
      cover: cover,
      region: cleanText(data.region).toUpperCase(),
      createTime: createTime,
      duration: pickNumber(data, ['duration', 'video_duration']),
      stats: stats,
      engagementRate: engagementRate,
      stream: null,
      source: 'tikwm',
      fetchedAt: 0
    };
  }

  function buildStreamCandidates(data) {
    var list = [];
    function add(url, primary, secondary, watermark, label) {
      var absolute = absoluteCdnUrl(url);
      if (!absolute) return;
      var size = toSize(primary) || toSize(secondary);
      list.push({ url: absolute, size: size, watermark: watermark, label: label });
    }
    add(data.hdplay, data.hd_size, data.size, false, 'HD');
    add(data.play, data.size, data.hd_size, false, 'SD');
    add(data.wmplay, data.wm_size, data.size, true, 'watermark');
    return list;
  }

  function emitPhase(options, phase) {
    if (!options || typeof options.onPhase !== 'function') return;
    try { options.onPhase(phase); } catch (err) { /* UI must not break analysis */ }
  }

  async function analyse(input, options) {
    options = options || {};
    var sourceUrl = normalizeTikTokUrl(input);
    var data = await resolve(sourceUrl, options.signal);
    var result = normalizeTikwmData(data, sourceUrl);

    if (!options.force) {
      var cached = readCache(result.id);
      if (cached) return cached;
    }

    var candidates = buildStreamCandidates(data);
    var lastError = null;
    var stream = null;
    emitPhase(options, 'probe');

    for (var i = 0; i < candidates.length; i++) {
      if (options.signal && options.signal.aborted) throw abortedError();
      var candidate = candidates[i];
      try {
        var probe = await probeStream(candidate.url, candidate.size, options.signal);
        if (probe && probe.info && probe.info.found) {
          stream = {
            url: probe.url,
            info: probe.info,
            hdr: probe.hdr,
            method: probe.method,
            totalSize: probe.totalSize,
            bytesRead: probe.bytesRead,
            rangeHonored: probe.rangeHonored,
            watermark: candidate.watermark,
            quality: candidate.label,
            recipeArtist: probe.recipeArtist,
            recipeComment: probe.recipeComment
          };
          break;
        }
        lastError = makeError('STREAM_UNAVAILABLE', 'Struktur MP4 tidak ditemukan pada stream ' + candidate.label + '.');
      } catch (err) {
        if (isStatsError(err) && err.code === 'ABORTED') throw err;
        lastError = err;
      }
    }

    if (options.signal && options.signal.aborted) throw abortedError();

    result.stream = stream;
    if (!stream) {
      result.analysisError = lastError || makeError('STREAM_UNAVAILABLE', 'Metadata stream tidak tersedia.');
    }
    result.fetchedAt = Date.now();

    if (stream) writeCache(result.id, result);
    return result;
  }

  // ---------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------

  function byId(id) {
    try {
      return document.getElementById(id) || null;
    } catch (err) {
      return null;
    }
  }

  function setText(node, text) {
    if (node) node.textContent = text == null ? '' : String(text);
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setStatus(message, kind) {
    if (!el.status) return;
    el.status.textContent = message || '';
    var classes = ['loading', 'error', 'success', 'warning'];
    for (var i = 0; i < classes.length; i++) {
      el.status.classList.toggle('is-' + classes[i], kind === classes[i]);
    }
    if (kind) el.status.setAttribute('data-state', kind);
    else el.status.removeAttribute('data-state');
  }

  function setBusy(busy) {
    state.busy = busy;
    if (el.submit) {
      el.submit.disabled = busy;
      if (busy) el.submit.setAttribute('aria-busy', 'true');
      else el.submit.removeAttribute('aria-busy');
    }
    if (el.form) {
      if (busy) {
        el.form.setAttribute('aria-busy', 'true');
        el.form.classList.add('is-busy');
      } else {
        el.form.removeAttribute('aria-busy');
        el.form.classList.remove('is-busy');
      }
    }
    if (state.submitLabel) {
      state.submitLabel.textContent = busy ? 'Memeriksa…' : state.submitLabelText;
    }
  }

  function friendlyError(err) {
    var code = err && err.code;
    if (code === 'INVALID_URL') {
      return 'Link TikTok tidak valid. Tempel link video dari tiktok.com, vt.tiktok.com, atau vm.tiktok.com.';
    }
    if (code === 'NO_VIDEO') {
      return 'Video tidak tersedia. Pastikan postingan publik, bukan foto/slideshow, dan belum dihapus.';
    }
    if (code === 'TIKWM_BLOCKED') {
      return 'TikWM sedang membatasi permintaan (rate limit). Coba lagi beberapa saat.';
    }
    if (code === 'TIMEOUT') {
      return 'Permintaan terlalu lama. Periksa koneksi lalu coba lagi.';
    }
    if (code === 'NETWORK') {
      return 'Tidak bisa menghubungi TikWM. Periksa koneksi atau pemblokir iklan, lalu coba lagi.';
    }
    if (code === 'PATCHER_MISSING') {
      return 'Parser MP4 tidak termuat. Muat ulang halaman lalu coba lagi.';
    }
    if (code === 'TIKWM_ERROR') {
      return 'TikWM tidak bisa memproses link ini. Pastikan video publik lalu coba lagi.';
    }
    return 'Terjadi kesalahan saat memeriksa video. Coba lagi.';
  }

  function looksLikeTikTokLink(value) {
    return /tiktok\.com|tt\.site/i.test(String(value || ''));
  }

  function extractClipboardLink(text) {
    var value = cleanText(text);
    if (!value) return '';
    var matches = value.match(/https?:\/\/[^\s<>"']+/gi);
    if (!matches || !matches.length) return value;
    var first = '';
    for (var i = 0; i < matches.length; i++) {
      var candidate = matches[i].replace(/[),.;!?]+$/, '');
      if (!first) first = candidate;
      if (looksLikeTikTokLink(candidate)) return candidate;
    }
    return first;
  }

  async function pasteFromClipboard() {
    var clipboard = global.navigator && global.navigator.clipboard;
    if (!clipboard || typeof clipboard.readText !== 'function') {
      setStatus('Browser ini tidak mendukung tombol Tempel. Gunakan Ctrl+V atau tekan lama di kolom link.', 'warning');
      if (el.url) el.url.focus();
      return;
    }

    var text;
    try {
      text = await clipboard.readText();
    } catch (err) {
      setStatus('Akses clipboard ditolak. Tempel manual dengan Ctrl+V atau tekan lama di kolom link.', 'warning');
      if (el.url) el.url.focus();
      return;
    }

    var link = extractClipboardLink(text);
    if (!link) {
      setStatus('Clipboard kosong. Salin link video TikTok terlebih dahulu.', 'warning');
      if (el.url) el.url.focus();
      return;
    }
    if (el.url && el.url.disabled) {
      setStatus('Kolom link sedang tidak bisa diubah. Tunggu pemeriksaan selesai.', 'warning');
      return;
    }

    if (el.url) {
      el.url.value = link;
      try {
        el.url.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (err) { /* ignore */ }
      try {
        el.url.focus();
        el.url.setSelectionRange(link.length, link.length);
      } catch (err) { /* ignore */ }
    }

    if (looksLikeTikTokLink(link)) {
      setStatus('Link TikTok ditempel. Tekan Cek video untuk memeriksa.', 'success');
    } else {
      setStatus('Teks ditempel, tetapi tidak terlihat seperti link TikTok.', 'warning');
    }
  }

  function regionName(code) {
    var value = cleanText(code).toUpperCase();
    if (!value) return '';
    try {
      if (!state.regionNames && typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
        state.regionNames = new Intl.DisplayNames(['id'], { type: 'region' });
      }
      if (state.regionNames) {
        var name = state.regionNames.of(value);
        if (name) return name;
      }
    } catch (err) { /* fall back to the code */ }
    return value;
  }

  function formatDate(timestampSeconds) {
    var ms = toNumber(timestampSeconds) * 1000;
    if (!ms) return '';
    var date = new Date(ms);
    if (isNaN(date.getTime())) return '';
    try {
      if (!state.dateFormatter) {
        state.dateFormatter = new Intl.DateTimeFormat('id-ID', {
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        });
      }
      return state.dateFormatter.format(date);
    } catch (err) {
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
      return date.getDate() + ' ' + months[date.getMonth()] + ' ' + date.getFullYear();
    }
  }

  function canonicalLink(result) {
    var uniqueId = result && result.author && result.author.uniqueId;
    var id = result && result.id;
    if (!uniqueId || !id || !/^\d+$/.test(String(id))) return '';
    return 'https://www.tiktok.com/@' + encodeURIComponent(uniqueId) + '/video/' + id;
  }

  function authorLabel(result) {
    var author = (result && result.author) || {};
    var nickname = cleanText(author.nickname);
    var uniqueId = cleanText(author.uniqueId).replace(/^@+/, '');
    if (nickname && uniqueId && nickname !== uniqueId) return nickname + ' · @' + uniqueId;
    if (uniqueId) return '@' + uniqueId;
    if (nickname) return nickname;
    return '';
  }

  function metaLabel(result) {
    var parts = [];
    var region = regionName(result && result.region);
    if (region) parts.push(region);
    var date = formatDate(result && result.createTime);
    if (date) parts.push(date);
    var id = result && result.id;
    if (id && /^\d+$/.test(String(id))) parts.push('ID ' + id);
    return parts.join(' · ');
  }

  function renderCover(result) {
    if (!el.cover) return;
    var cover = result && result.cover;
    if (!cover) {
      el.cover.hidden = true;
      el.cover.removeAttribute('src');
      return;
    }
    var author = result && result.author && result.author.uniqueId;
    el.cover.alt = author ? 'Sampul video oleh @' + author : 'Sampul video TikTok';
    el.cover.referrerPolicy = 'no-referrer';
    el.cover.hidden = false;
    el.cover.src = cover;
  }

  function renderLink(result) {
    if (!el.link) return;
    var href = canonicalLink(result) || state.lastUrl;
    if (!href) {
      el.link.hidden = true;
      el.link.removeAttribute('href');
      return;
    }
    el.link.href = href;
    el.link.hidden = false;
  }

  function renderStats(stats) {
    if (!el.stats) return;
    clearNode(el.stats);
    var definitions = [
      ['Tayangan', stats && stats.views],
      ['Suka', stats && stats.likes],
      ['Komentar', stats && stats.comments],
      ['Bagikan', stats && stats.shares],
      ['Disimpan', stats && stats.saves]
    ];
    for (var i = 0; i < definitions.length; i++) {
      var label = definitions[i][0];
      var value = toNumber(definitions[i][1]);
      var card = document.createElement('div');
      card.className = 'tt-stat';
      card.setAttribute('role', 'listitem');
      var strong = document.createElement('strong');
      strong.className = 'tt-stat-value';
      strong.textContent = formatCompact(value);
      strong.title = formatNumber(value);
      strong.setAttribute('aria-label', label + ': ' + formatNumber(value));
      var small = document.createElement('span');
      small.className = 'tt-stat-label';
      small.textContent = label;
      card.appendChild(strong);
      card.appendChild(small);
      el.stats.appendChild(card);
    }
  }

  function hdrTitle(hdr, info) {
    var parts = [];
    var color = (hdr && hdr.color) || (info && info.color);
    if (color) parts.push(colorLabel(color));
    if (hdr && hdr.dv && hdr.dv.profile != null) parts.push('DV profil ' + hdr.dv.profile);
    if (hdr && hdr.staticBoxes) {
      var keys = [];
      for (var key in hdr.staticBoxes) {
        if (hasOwn(hdr.staticBoxes, key)) keys.push(key);
      }
      if (keys.length) parts.push(keys.join(', '));
    }
    return parts.join(' · ');
  }

  function addDetail(rows, label, value, title) {
    rows.push({ label: label, value: value, title: title || '' });
  }

  function methodLabel(method) {
    if (method === 'full') return 'File penuh';
    if (method === 'tail') return '2 MB terakhir';
    if (method === 'head') return '2 MB pertama';
    return 'Statistik saja';
  }

  function methodDetail(stream) {
    if (!stream || !stream.info || !stream.info.found) {
      return 'Statistik saja · metadata stream tidak tersedia';
    }
    var parts = [methodLabel(stream.method)];
    var total = toNumber(stream.totalSize);
    var read = toNumber(stream.bytesRead);
    if (stream.method === 'full' && total > 0) {
      parts.push(formatBytes(total) + ' dibaca');
    } else if (read > 0) {
      parts.push(formatBytes(read) + ' dibaca');
    }
    if (stream.rangeHonored === false) parts.push('Range tidak didukung');
    return parts.join(' · ');
  }

  function streamQualityLabel(stream) {
    if (!stream || !stream.info || !stream.info.found) return '—';
    var quality = cleanText(stream.quality);
    if (quality === 'HD') return stream.watermark ? 'HD · watermark' : 'HD · tanpa watermark';
    if (quality === 'SD') return stream.watermark ? 'SD · watermark' : 'SD · tanpa watermark';
    if (quality === 'watermark') return 'Watermark';
    if (quality) return quality + (stream.watermark ? ' · watermark' : '');
    return stream.watermark ? 'Watermark' : 'Tanpa watermark';
  }

  function recipeTrackFallback(stream) {
    var tracks = toNumber(stream && stream.info && stream.info.audio && stream.info.audio.trackCount);
    if (tracks >= 3) return 'Best Quality For iPhone';
    if (tracks === 2) return 'Best Quality';
    return '';
  }

  function recipeInfo(stream) {
    var found = !!(stream && stream.info && stream.info.found);
    var artist = cleanText(stream && stream.recipeArtist);
    var comment = cleanText(stream && stream.recipeComment);

    if (!found) {
      return {
        state: 'unknown',
        method: 'Tidak bisa dicek',
        recipe: 'Tidak bisa dicek',
        methodTitle: 'Metadata stream tidak tersedia.',
        recipeTitle: 'Metadata stream tidak tersedia.',
        detail: 'Metadata stream tidak tersedia, jadi jejak resep tidak bisa diperiksa.'
      };
    }

    var artistIsBrand = /^korifcan\b/i.test(artist);
    var method = artistIsBrand ? 'KoRifCan' : artist;
    var recipe = comment;
    var inferred = false;
    var legacyComment = /^korifcan\b/i.test(recipe);
    if (legacyComment) recipe = '';
    if (!recipe && (artistIsBrand || legacyComment)) {
      recipe = recipeTrackFallback(stream);
      inferred = !!recipe;
    }
    if (!method && legacyComment) method = 'KoRifCan';

    if (!method && !recipe) {
      return {
        state: 'none',
        method: 'Tidak terdeteksi',
        recipe: 'Tidak terdeteksi',
        methodTitle: 'Metadata artist tidak ditemukan di stream.',
        recipeTitle: 'Metadata comment tidak ditemukan di stream.',
        detail: 'Metadata artist/comment KoRifCan tidak ditemukan pada stream ini. TikTok biasanya menghapus metadata setelah upload, jadi ini bukan bukti video tidak pernah memakai resep KoRifCan.'
      };
    }

    if (!method) method = 'Tidak terdeteksi';
    if (!recipe) recipe = 'Tidak diketahui';

    var methodTitle = artist
      ? 'Metadata artist: ' + artist
      : 'Metadata artist tidak ditemukan di stream.';
    var recipeTitle;
    if (inferred) {
      recipeTitle = 'Metadata comment tidak berisi nama resep; disimpulkan dari jumlah trek audio.';
    } else if (comment) {
      recipeTitle = 'Metadata comment: ' + comment;
    } else {
      recipeTitle = 'Metadata comment tidak ditemukan di stream.';
    }

    var parts = [];
    if (artist) parts.push('artist = ' + artist);
    if (comment) parts.push('comment = ' + comment);
    var detail = 'Metadata MP4' + (parts.length ? ' (' + parts.join(' · ') + ')' : '') +
      ' dibaca langsung dari stream.';
    if (inferred) {
      detail += ' Nama resep disimpulkan dari jumlah trek audio karena comment tidak berisi nama resep.';
    }

    return {
      state: 'detected',
      method: method,
      recipe: recipe,
      methodTitle: methodTitle,
      recipeTitle: recipeTitle,
      detail: detail
    };
  }

  function buildDetails(result) {
    var rows = [];
    var stream = result && result.stream;
    var info = stream && stream.info;
    var video = (info && info.video) || {};
    var hdr = stream && stream.hdr;
    var recipe = recipeInfo(stream);

    if (!stream || !info || !info.found) {
      addDetail(rows, 'Resolusi', '—');
      addDetail(rows, 'FPS', '—');
      addDetail(rows, 'Durasi', '—');
      addDetail(rows, 'Codec', '—');
      addDetail(rows, 'Bit depth/chroma', '—');
      addDetail(rows, 'Warna/HDR', '—');
      addDetail(rows, 'Bitrate video', '—');
      addDetail(rows, 'Bitrate total', '—');
      addDetail(rows, 'Audio', '—');
      addDetail(rows, 'Ukuran file', '—');
      addDetail(rows, 'Sampel video', '—');
      addDetail(rows, 'Metode', recipe.method, recipe.methodTitle);
      addDetail(rows, 'Resep', recipe.recipe, recipe.recipeTitle);
      addDetail(rows, 'Cara cek', methodDetail(stream));
      addDetail(rows, 'Kualitas stream', streamQualityLabel(stream));
      addDetail(rows, 'Sumber stream', 'Tidak tersedia');
      return rows;
    }

    var resolution = info.width && info.height ? info.width + ' × ' + info.height : '—';
    var coded = info.codedWidth && info.codedHeight ? info.codedWidth + ' × ' + info.codedHeight : '';
    addDetail(rows, 'Resolusi', resolution, coded && coded !== resolution ? 'Coded: ' + coded : '');
    addDetail(rows, 'FPS', formatFps(info));
    addDetail(rows, 'Durasi', formatDuration(info.duration));
    addDetail(rows, 'Codec', videoCodec(info));

    var chromaParts = [];
    if (toNumber(video.bitDepth) > 0) chromaParts.push(toNumber(video.bitDepth) + '-bit');
    if (video.chroma) chromaParts.push(video.chroma);
    addDetail(rows, 'Bit depth/chroma', chromaParts.length ? chromaParts.join(' · ') : '—');

    addDetail(rows, 'Warna/HDR', hdrLabel(hdr, info), hdrTitle(hdr, info));

    var videoBitrate = toNumber(video.bitrate);
    addDetail(rows, 'Bitrate video', formatBitrate(videoBitrate),
      videoBitrate ? Math.round(videoBitrate) + ' bps' : '');

    var totalBitrate = info.duration > 0 && stream.totalSize > 0
      ? (stream.totalSize * 8) / info.duration
      : 0;
    addDetail(rows, 'Bitrate total', formatBitrate(totalBitrate),
      totalBitrate ? Math.round(totalBitrate) + ' bps' : '');

    addDetail(rows, 'Audio', formatAudio(info.audio));
    addDetail(rows, 'Ukuran file', stream.totalSize ? formatBytes(stream.totalSize) : '—',
      stream.totalSize ? formatNumber(stream.totalSize) + ' byte' : '');
    addDetail(rows, 'Sampel video', toNumber(info.videoSamples) > 0
      ? formatNumber(info.videoSamples) + ' sampel'
      : '—');

    if (toNumber(info.rotation)) {
      addDetail(rows, 'Rotasi', toNumber(info.rotation) + '°');
    }

    addDetail(rows, 'Metode', recipe.method, recipe.methodTitle);
    addDetail(rows, 'Resep', recipe.recipe, recipe.recipeTitle);
    addDetail(rows, 'Cara cek', methodDetail(stream));
    addDetail(rows, 'Kualitas stream', streamQualityLabel(stream));
    addDetail(rows, 'Sumber stream', stream.watermark
      ? 'CDN TikTok · watermark'
      : 'CDN TikTok · tanpa watermark');
    return rows;
  }

  function renderDetails(result) {
    if (!el.details) return;
    clearNode(el.details);
    var rows = buildDetails(result);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var wrapper = document.createElement('div');
      wrapper.className = 'tt-detail';
      var dt = document.createElement('dt');
      dt.textContent = row.label;
      var dd = document.createElement('dd');
      dd.textContent = row.value;
      if (row.title) dd.title = row.title;
      wrapper.appendChild(dt);
      wrapper.appendChild(dd);
      el.details.appendChild(wrapper);
    }
  }

  function sourceNote(stream) {
    if (!stream) return 'Sumber: TikWM · statistik saja';
    if (stream.method === 'full') return 'Sumber: TikWM · dianalisis dari file penuh';
    if (stream.method === 'tail') return 'Sumber: TikWM · dianalisis dari 2 MB terakhir';
    if (stream.method === 'head') return 'Sumber: TikWM · dianalisis dari 2 MB pertama';
    return 'Sumber: TikWM · statistik saja';
  }

  function renderMethod(result) {
    if (!el.method) return;
    var recipe = recipeInfo(result && result.stream);
    var state = recipe.state;
    if (state === 'detected' && recipe.method === 'Tidak terdeteksi') state = 'none';
    el.method.textContent = 'Metode: ' + recipe.method;
    el.method.title = recipe.methodTitle;
    el.method.setAttribute('data-state', state);
    el.method.hidden = false;
  }

  function renderRecipe(result) {
    if (!el.recipe) return;
    var recipe = recipeInfo(result && result.stream);
    var state = recipe.state;
    if (state === 'detected' && recipe.recipe === 'Tidak diketahui') state = 'unknown';
    el.recipe.textContent = 'Resep: ' + recipe.recipe;
    el.recipe.title = recipe.recipeTitle;
    el.recipe.setAttribute('data-state', state);
    el.recipe.hidden = false;
  }

  function downloadFileName(result) {
    var author = cleanText(result && result.author && result.author.uniqueId).replace(/^@+/, '');
    var id = cleanText(result && result.id);
    var base = 'tiktok';
    if (author) base += '-' + author;
    if (id) base += '-' + id;
    return base.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-') + '.mp4';
  }

  function resetDownloadProgress() {
    if (el.downloadProgress) el.downloadProgress.hidden = true;
    if (el.downloadTrack) {
      el.downloadTrack.classList.remove('is-indeterminate');
      el.downloadTrack.setAttribute('aria-valuenow', '0');
      el.downloadTrack.removeAttribute('aria-valuetext');
    }
    if (el.downloadFill) el.downloadFill.style.width = '0%';
    setText(el.downloadProgressText, '');
  }

  function showDownloadProgress(done, total, speed) {
    if (!el.downloadProgress) return 0;
    el.downloadProgress.hidden = false;
    var received = Math.max(0, toNumber(done));
    var size = Math.max(0, toNumber(total));
    var rate = formatSpeed(speed);
    var rateSuffix = rate ? ' · ' + rate : '';
    var percent = size > 0 ? Math.max(0, Math.min(100, Math.floor((received / size) * 100))) : 0;
    if (size > 0) {
      if (el.downloadTrack) {
        el.downloadTrack.classList.remove('is-indeterminate');
        el.downloadTrack.setAttribute('aria-valuenow', String(percent));
        el.downloadTrack.setAttribute('aria-valuetext', percent + '% — ' + formatBytes(received) + ' dari ' + formatBytes(size) + (rate ? ' — ' + rate : ''));
      }
      if (el.downloadFill) el.downloadFill.style.width = percent + '%';
      setText(el.downloadProgressText, formatBytes(received) + ' dari ' + formatBytes(size) + ' · ' + percent + '%' + rateSuffix);
    } else {
      if (el.downloadTrack) {
        el.downloadTrack.classList.add('is-indeterminate');
        el.downloadTrack.removeAttribute('aria-valuenow');
        el.downloadTrack.setAttribute('aria-valuetext', formatBytes(received) + ' terunduh' + (rate ? ' — ' + rate : ''));
      }
      if (el.downloadFill) el.downloadFill.style.width = '';
      setText(el.downloadProgressText, formatBytes(received) + ' terunduh…' + rateSuffix);
    }
    return percent;
  }

  function stopDownload(resetProgress) {
    if (state.downloadController) {
      try { state.downloadController.abort(); } catch (err) { /* ignore */ }
      state.downloadController = null;
    }
    state.downloadBusy = false;
    state.downloadToken++;
    if (el.download) {
      el.download.removeAttribute('aria-busy');
      el.download.removeAttribute('title');
      var label = el.download.querySelector('span');
      if (label) label.textContent = 'Download video';
    }
    if (resetProgress) resetDownloadProgress();
  }

  function renderDownload(result) {
    if (!el.downloadRow || !el.download) return;
    var stream = result && result.stream;
    var url = stream && stream.url;
    if (!url) {
      stopDownload(true);
      state.downloadUrl = '';
      state.downloadName = '';
      state.downloadSize = 0;
      el.downloadRow.hidden = true;
      el.download.removeAttribute('href');
      el.download.removeAttribute('download');
      return;
    }
    if (url !== state.downloadUrl || state.downloadBusy) stopDownload(true);
    state.downloadUrl = url;
    state.downloadName = downloadFileName(result);
    state.downloadSize = toNumber(stream && stream.totalSize);
    el.download.href = url;
    el.download.setAttribute('download', state.downloadName);
    el.downloadRow.hidden = false;
  }

  async function handleDownload(event) {
    if (!state.downloadUrl) return;
    if (event) event.preventDefault();

    if (state.downloadBusy) {
      stopDownload(true);
      setStatus('Unduhan dibatalkan.', 'warning');
      return;
    }

    if (state.downloadSize > MAX_BLOB_DOWNLOAD) {
      try {
        global.open(state.downloadUrl, '_blank', 'noopener');
        setStatus('File besar; video dibuka di tab baru.', 'warning');
      } catch (err) {
        setStatus('Tidak bisa membuka video. Coba lagi.', 'error');
      }
      return;
    }

    var url = state.downloadUrl;
    var name = state.downloadName || 'tiktok-video.mp4';
    var expected = toNumber(state.downloadSize);
    var token = ++state.downloadToken;
    var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    state.downloadController = controller;
    state.downloadBusy = true;
    var startedAt = Date.now();

    var label = el.download ? el.download.querySelector('span') : null;
    var original = label ? label.textContent : '';
    if (label) label.textContent = 'Menyiapkan…';
    if (el.download) {
      el.download.setAttribute('aria-busy', 'true');
      el.download.title = 'Klik untuk membatalkan unduhan';
    }
    showDownloadProgress(0, expected, 0);

    try {
      var response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (token !== state.downloadToken) return;

      var total = responseContentLength(response) || expected;
      if (total > MAX_BLOB_DOWNLOAD) {
        if (response.body && typeof response.body.cancel === 'function') {
          try { await response.body.cancel(); } catch (cancelErr) { /* ignore */ }
        }
        try {
          global.open(url, '_blank', 'noopener');
          setStatus('File besar; video dibuka di tab baru.', 'warning');
        } catch (openErr) {
          setStatus('Tidak bisa membuka video. Coba lagi.', 'error');
        }
        resetDownloadProgress();
        return;
      }
      var blob;
      if (response.body && typeof response.body.getReader === 'function') {
        var reader = response.body.getReader();
        var chunks = [];
        var received = 0;
        var lastPaintBytes = -1;
        var lastPaintAt = 0;
        var speedWindow = [{ t: startedAt, bytes: 0 }];
        if (label) label.textContent = total > 0 ? 'Mengunduh… 0%' : 'Mengunduh…';
        while (true) {
          var step = await reader.read();
          if (token !== state.downloadToken) {
            try { await reader.cancel(); } catch (cancelErr) { /* ignore */ }
            return;
          }
          if (step.done) break;
          var value = step.value;
          if (!value) continue;
          var chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          chunks.push(chunk);
          received += chunk.length;
          var now = Date.now();
          if (lastPaintBytes < 0 || received === total ||
              received - lastPaintBytes >= 32768 || now - lastPaintAt >= 120) {
            speedWindow.push({ t: now, bytes: received });
            while (speedWindow.length > 2 && now - speedWindow[0].t > 2000) speedWindow.shift();
            var windowStart = speedWindow[0];
            var windowSeconds = (now - windowStart.t) / 1000;
            var speed = windowSeconds > 0.15 ? (received - windowStart.bytes) / windowSeconds : 0;
            var percent = showDownloadProgress(received, total, speed);
            if (label && total > 0) label.textContent = 'Mengunduh… ' + percent + '%';
            lastPaintBytes = received;
            lastPaintAt = now;
          }
        }
        if (token !== state.downloadToken) return;
        showDownloadProgress(received, total || received, 0);
        blob = new Blob(chunks, {
          type: (response.headers && response.headers.get('content-type')) || 'video/mp4'
        });
      } else {
        if (label) label.textContent = 'Mengunduh…';
        blob = await response.blob();
      }

      if (token !== state.downloadToken) return;
      if (!blob || !blob.size) throw new Error('File kosong.');
      var elapsedTotal = (Date.now() - startedAt) / 1000;
      var averageSpeed = elapsedTotal > 0 ? blob.size / elapsedTotal : 0;
      if (label) label.textContent = 'Menyimpan…';
      showDownloadProgress(blob.size, blob.size || total, averageSpeed);

      var objectUrl = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = objectUrl;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 30000);
      setText(el.downloadProgressText, formatBytes(blob.size) + ' · selesai' +
        (averageSpeed ? ' · rata-rata ' + formatSpeed(averageSpeed) : ''));
      setStatus('Video berhasil diunduh.', 'success');
    } catch (err) {
      if (token !== state.downloadToken) return;
      if (err && err.name === 'AbortError') return;
      resetDownloadProgress();
      try {
        global.open(url, '_blank', 'noopener');
        setStatus('Browser tidak bisa mengunduh langsung; video dibuka di tab baru.', 'warning');
      } catch (openErr) {
        setStatus('Tidak bisa mengunduh video. Coba lagi.', 'error');
      }
    } finally {
      if (token === state.downloadToken) {
        state.downloadBusy = false;
        state.downloadController = null;
        if (el.download) {
          el.download.removeAttribute('aria-busy');
          el.download.removeAttribute('title');
        }
        if (label) label.textContent = original;
      }
    }
  }

  function renderResult(result) {
    if (!el.result) return;
    renderCover(result);
    setText(el.author, authorLabel(result));
    setText(el.title, cleanText(result && result.title) || 'Tanpa judul');
    setText(el.meta, metaLabel(result));
    renderLink(result);
    renderStats(result && result.stats);
    setText(el.engagement, 'Interaksi: ' + formatPercent(result && result.engagementRate));
    renderMethod(result);
    renderRecipe(result);
    renderDetails(result);
    setText(el.source, sourceNote(result && result.stream));
    renderDownload(result);
    el.result.hidden = false;
    if (el.result.hasAttribute('data-autoscroll')) {
      try {
        el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        try { el.result.scrollIntoView(); } catch (fallbackErr) { /* ignore */ }
      }
    }
  }

  async function handleSubmit(event) {
    if (event) event.preventDefault();

    if (state.controller) {
      try { state.controller.abort(); } catch (err) { /* ignore */ }
      state.controller = null;
    }
    var token = ++state.token;

    var raw = el.url ? el.url.value : '';
    var normalized;
    try {
      normalized = normalizeTikTokUrl(raw);
    } catch (err) {
      setBusy(false);
      setStatus(friendlyError(err), 'error');
      if (el.result) el.result.hidden = true;
      renderDownload(null);
      if (el.url) el.url.focus();
      return;
    }

    var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    state.controller = controller;
    state.lastUrl = normalized;
    if (el.result) el.result.hidden = true;
    renderDownload(null);
    setBusy(true);
    setStatus('Mengambil statistik dari TikWM…', 'loading');

    try {
      var result = await analyse(normalized, {
        signal: controller ? controller.signal : undefined,
        onPhase: function (phase) {
          if (token !== state.token) return;
          if (phase === 'probe') {
            setStatus('Statistik ditemukan. Membaca metadata stream dari CDN TikTok…', 'loading');
          }
        }
      });

      if (token !== state.token) return;
      renderResult(result);
      if (result && result.stream) {
        setStatus('Data video berhasil dimuat.', 'success');
      } else {
        setStatus('Statistik tampil, tetapi metadata stream tidak tersedia. Coba lagi beberapa saat.', 'warning');
      }
    } catch (err) {
      if (token !== state.token) return;
      if (err && err.code === 'ABORTED') return;
      if (el.result) el.result.hidden = true;
      renderDownload(null);
      setStatus(friendlyError(err), 'error');
      if (err && err.code === 'INVALID_URL' && el.url) el.url.focus();
    } finally {
      if (token === state.token) {
        setBusy(false);
        state.controller = null;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  function init() {
    if (typeof document === 'undefined' || !document.getElementById) return;

    el = {
      form: byId('ttForm'),
      url: byId('ttUrl'),
      paste: byId('ttPaste'),
      submit: byId('ttSubmit'),
      status: byId('ttStatus'),
      result: byId('ttResult'),
      cover: byId('ttCover'),
      author: byId('ttAuthor'),
      title: byId('ttTitle'),
      meta: byId('ttMeta'),
      link: byId('ttLink'),
      stats: byId('ttStats'),
      engagement: byId('ttEngagement'),
      method: byId('ttMethod'),
      recipe: byId('ttRecipe'),
      details: byId('ttDetails'),
      source: byId('ttSource'),
      downloadRow: byId('ttDownloadRow'),
      download: byId('ttDownload'),
      downloadProgress: byId('ttDownloadProgress'),
      downloadTrack: byId('ttDownloadTrack'),
      downloadFill: byId('ttDownloadFill'),
      downloadProgressText: byId('ttDownloadProgressText')
    };

    if (!el.form) return;

    var label = el.submit ? el.submit.querySelector('span') : null;
    if (label) {
      state.submitLabel = label;
      state.submitLabelText = label.textContent;
    }

    if (el.cover) {
      el.cover.addEventListener('error', function () {
        el.cover.hidden = true;
      });
      el.cover.hidden = true;
    }
    if (el.stats) el.stats.setAttribute('role', 'list');
    if (el.result) {
      el.result.setAttribute('role', 'region');
      el.result.setAttribute('aria-label', 'Hasil pemeriksaan video');
    }

    el.form.addEventListener('submit', function (event) {
      handleSubmit(event);
    });
    if (el.paste) {
      el.paste.addEventListener('click', function () {
        pasteFromClipboard();
      });
    }
    if (el.download) el.download.addEventListener('click', handleDownload);

    var checkTarget = byId('cek-tiktok');
    if (checkTarget && document.querySelectorAll) {
      var checkLinks = document.querySelectorAll('a[href="#cek-tiktok"]');
      for (var i = 0; i < checkLinks.length; i++) {
        checkLinks[i].addEventListener('click', function (event) {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          try { history.replaceState(null, '', '#cek-tiktok'); } catch (err) { /* ignore */ }
          try {
            checkTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch (err) {
            try { checkTarget.scrollIntoView(); } catch (fallbackErr) { /* ignore */ }
          }
        });
      }
    }

    var year = byId('year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  global.KoRifCanTikTokStats = {
    resolve: resolve,
    probeStream: probeStream,
    analyse: analyse,
    format: format
  };

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else if (typeof document !== 'undefined') {
    init();
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
