(function () {
  'use strict';

  var ARTIST = 'KoRifCan https://www.tiktok.com/@korifcan';
  var COMMENT = 'KoRifCan https://www.tiktok.com/@korifcan';
  var ENCODER = 'Lavf60.16.100';
  var CORE_URL = new URL('ffmpeg/ffmpeg-core.js', location.href).href;
  var WASM_URL = new URL('ffmpeg/ffmpeg-core.wasm', location.href).href;
  var WORKER_URL = new URL('patch-worker.js?v=20261113c', location.href).href;
  var STORE_KEY = 'korifcan.preset';
  var MAX_FILE_BYTES = 1.5 * 1024 * 1024 * 1024;
  var LARGE_FILE_BYTES = 500 * 1024 * 1024;

  var PRESETS = {
    best: {
      label: 'Best Quality',
      short: 'Best Quality',
      note: 'Resep Best Quality · audio 48 kHz kualitas tinggi.',
      args: [
        '-i', 'input.mp4',
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-map_chapters', '-1',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-b:a', '346k',
        '-movflags', '+faststart',
        '-y', 'out.mp4'
      ]
    },
    iphone: {
      label: 'Best Quality For iPhone',
      short: 'iPhone',
      note: 'Resep iPhone · track 44,1 kHz + HQ 48 kHz.',
      args: [
        '-i', 'input.mp4',
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-map', '0:a:0?',
        '-map_chapters', '-1',
        '-c:v', 'copy',
        '-c:a:0', 'aac',
        '-ar:a:0', '44100',
        '-ac:a:0', '2',
        '-b:a:0', '128k',
        '-c:a:1', 'aac',
        '-ar:a:1', '48000',
        '-ac:a:1', '2',
        '-b:a:1', '346k',
        '-movflags', '+faststart',
        '-y', 'out.mp4'
      ]
    }
  };

  var STAGE_TITLES = [
    'Membaca & memeriksa video',
    'Memuat mesin ffmpeg',
    'Menyalin video & audio',
    'Menyusun container & metadata',
    'Menyiapkan unduhan'
  ];

  var state = {
    file: null,
    fileMeta: null,
    videoInfo: null,
    preset: 'best',
    busy: false,
    phase: '',
    stage: 0,
    probeToken: 0,
    ffmpeg: null,
    loadPromise: null,
    worker: null,
    outUrl: null,
    hdrInfo: null,
    hdrPreserve: true,
    hdrProbeToken: 0
  };

  function $(id) { return document.getElementById(id); }

  var el = {
    studioCard: $('studioCard'),
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    fileCard: $('fileCard'),
    fileName: $('fileName'),
    fileMeta: $('fileMeta'),
    fileDetails: $('fileDetails'),
    infoResolution: $('infoResolution'),
    infoFps: $('infoFps'),
    infoDuration: $('infoDuration'),
    infoCodec: $('infoCodec'),
    infoBitDepth: $('infoBitDepth'),
    infoColor: $('infoColor'),
    infoBitrate: $('infoBitrate'),
    infoTotalBitrate: $('infoTotalBitrate'),
    infoQuality: $('infoQuality'),
    infoQualityNote: $('infoQualityNote'),
    infoAudio: $('infoAudio'),
    btnChange: $('btnChange'),
    btnRemove: $('btnRemove'),
    btnProcess: $('btnProcess'),
    processLabel: $('processLabel'),
    processNote: $('processNote'),
    progressPanel: $('progressPanel'),
    progressTitle: $('progressTitle'),
    progressSub: $('progressSub'),
    progressPct: $('progressPct'),
    progressBar: $('progressBar'),
    barFill: $('barFill'),
    stageList: $('stageList'),
    errorBox: $('errorBox'),
    errorText: $('errorText'),
    btnErrorClose: $('btnErrorClose'),
    resultPanel: $('resultPanel'),
    resultName: $('resultName'),
    resultSize: $('resultSize'),
    resultDuration: $('resultDuration'),
    resultPreset: $('resultPreset'),
    resultStream: $('resultStream'),
    resultHdr: $('resultHdr'),
    resultMeta: $('resultMeta'),
    hdrStatus: $('hdrStatus'),
    hdrBadge: $('hdrBadge'),
    hdrToggle: $('hdrToggle'),
    hdrPreserve: $('hdrPreserve'),
    hdrToggleNote: $('hdrToggleNote'),
    preview: $('preview'),
    btnDownload: $('btnDownload'),
    studioFileName: $('studioFileName'),
    btnAgain: $('btnAgain'),
    presetInputs: document.querySelectorAll('input[name="preset"]'),
    presetOptions: document.querySelectorAll('.preset-option'),
    stages: document.querySelectorAll('#stageList .stage')
  };

  function fail(message) {
    var err = new Error(message);
    err.isUserFacing = true;
    return err;
  }

  function isVideoFile(file) {
    if (!file) return false;
    if (/\.(mp4|mov|m4v)$/i.test(file.name || '')) return true;
    return /^video\/(mp4|quicktime|x-m4v)$/i.test(file.type || '');
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do {
      n = n / 1024;
      i++;
    } while (n >= 1024 && i < units.length - 1);
    var digits = n >= 100 ? 0 : (n >= 10 ? 1 : 2);
    return n.toLocaleString('id-ID', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits
    }) + ' ' + units[i];
  }

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(Number(seconds) || 0));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    if (h > 0) {
      return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    return m + ':' + String(s).padStart(2, '0');
  }

  function formatBitrate(bps) {
    bps = Number(bps) || 0;
    if (!bps) return '—';
    if (bps >= 995000) {
      return (bps / 1000000).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' Mbps';
    }
    return Math.round(bps / 1000).toLocaleString('id-ID') + ' kbps';
  }

  function formatFps(info) {
    var fps = Number(info && info.fps) || 0;
    if (!fps) return '—';
    var digits = Math.abs(fps - Math.round(fps)) < 0.02 ? 0 : 2;
    var text = fps.toLocaleString('id-ID', { maximumFractionDigits: digits });
    return (info.fpsMode === 'vfr' ? '~' : '') + text + ' fps';
  }

  function containerLabel(file) {
    var match = /\.([a-z0-9]+)$/i.exec((file && file.name) || '');
    var ext = match ? match[1].toUpperCase() : 'MP4';
    if (ext === 'MOV' || ext === 'M4V') return ext;
    return 'MP4';
  }

  function codecLabel(info) {
    var video = (info && info.video) || {};
    var type = video.codec || '';
    var profile = '';
    if (type === 'hev1' || type === 'hvc1') {
      profile = video.profileIdc === 2 ? 'Main 10'
        : video.profileIdc === 1 ? 'Main'
        : video.profileIdc === 3 ? 'Main Still'
        : video.profileIdc === 4 ? 'RExt' : '';
      return 'HEVC' + (profile ? ' ' + profile : '');
    }
    if (type === 'avc1' || type === 'avc3') {
      profile = video.profileIdc === 66 ? 'Baseline'
        : video.profileIdc === 77 ? 'Main'
        : video.profileIdc === 88 ? 'Extended'
        : video.profileIdc === 100 ? 'High'
        : video.profileIdc === 110 ? 'High 10'
        : video.profileIdc === 122 ? 'High 4:2:2'
        : video.profileIdc === 244 ? 'High 4:4:4' : '';
      return 'H.264' + (profile ? ' ' + profile : '');
    }
    if (type === 'av01') return 'AV1';
    if (type === 'vp09') return 'VP9';
    if (type === 'mp4v') return 'MPEG-4';
    return type ? type.toUpperCase() : '—';
  }

  function colorLabel(color) {
    if (!color) return 'Tidak ditandai';
    var primaries = {
      1: 'BT.709', 4: 'BT.470M', 5: 'BT.601 PAL', 6: 'BT.601 NTSC',
      7: 'SMPTE 240M', 8: 'Film', 9: 'BT.2020', 10: 'BT.2020',
      11: 'SMPTE 428', 12: 'Display P3', 22: 'EBU 3213'
    }[color.primaries] || ('Primer ' + color.primaries);
    var transfer = {
      1: 'SDR', 4: 'Gamma 2.2', 5: 'Gamma 2.8', 6: 'SDR', 7: 'SMPTE 240M',
      8: 'Linear', 9: 'Log100', 10: 'Log316', 11: 'xvYCC', 12: 'BT.1361',
      13: 'sRGB', 14: 'BT.2020 10-bit', 15: 'BT.2020 12-bit',
      16: 'PQ', 17: 'SMPTE 428', 18: 'HLG'
    }[color.transfer] || ('Transfer ' + color.transfer);
    return primaries + ' · ' + transfer;
  }

  function channelLabel(channels) {
    if (channels === 1) return 'mono';
    if (channels === 2) return 'stereo';
    return channels + ' kanal';
  }

  function audioLabel(audio) {
    if (!audio || !audio.codec) return 'Tidak ada audio';
    var names = {
      mp4a: 'AAC', alac: 'ALAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3',
      Opus: 'Opus', fLaC: 'FLAC', lpcm: 'PCM', samr: 'AMR'
    };
    var parts = [names[audio.codec] || audio.codec.toUpperCase()];
    if (audio.sampleRate) {
      parts.push(audio.sampleRate >= 1000
        ? (audio.sampleRate / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' kHz'
        : audio.sampleRate.toLocaleString('id-ID') + ' Hz');
    }
    if (audio.channels) parts.push(channelLabel(audio.channels));
    var text = parts.join(' · ');
    if (audio.trackCount > 1) text += ' · ' + audio.trackCount + ' trek';
    return text;
  }

  function qualityLabel(info) {
    var video = (info && info.video) || {};
    var width = Number(info && info.width) || 0;
    var height = Number(info && info.height) || 0;
    var fps = Number(info && info.fps) || 0;
    var bitrate = Number(video.bitrate) || 0;
    if (!width || !height || !fps || !bitrate) return { label: '—', note: '' };
    var bpp = bitrate / (width * height * fps);
    var label = bpp >= 0.15 ? 'Sangat tinggi'
      : bpp >= 0.08 ? 'Tinggi'
      : bpp >= 0.04 ? 'Sedang'
      : bpp >= 0.02 ? 'Hemat'
      : 'Sangat hemat';
    return {
      label: label,
      note: bpp.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + ' bpp · estimasi'
    };
  }

  function updateFileMeta(file) {
    var parts = [formatBytes(file.size), containerLabel(file)];
    var info = state.videoInfo;
    if (info && info.found) {
      if (info.width && info.height) parts.push(info.width + ' × ' + info.height);
      if (info.duration) parts.push(formatDuration(info.duration));
    } else if (state.fileMeta) {
      if (state.fileMeta.width && state.fileMeta.height) parts.push(state.fileMeta.width + ' × ' + state.fileMeta.height);
      if (state.fileMeta.duration) parts.push(formatDuration(state.fileMeta.duration));
    }
    el.fileMeta.textContent = parts.join(' · ');
  }

  function renderVideoInfo(file, info) {
    if (!info || !info.found) {
      el.fileDetails.hidden = true;
      return;
    }
    var video = info.video || {};
    el.infoResolution.textContent = info.width && info.height ? info.width + ' × ' + info.height : '—';
    el.infoFps.textContent = formatFps(info);
    el.infoDuration.textContent = info.duration ? formatDuration(info.duration) : '—';
    el.infoCodec.textContent = codecLabel(info);
    var depth = video.bitDepth ? video.bitDepth + '-bit' : '—';
    if (video.chroma) depth += ' · ' + video.chroma;
    el.infoBitDepth.textContent = depth;
    el.infoColor.textContent = colorLabel(info.color);
    el.infoBitrate.textContent = formatBitrate(video.bitrate);
    el.infoTotalBitrate.textContent = formatBitrate(info.duration ? (file.size * 8) / info.duration : 0);
    var quality = qualityLabel(info);
    el.infoQuality.textContent = quality.label;
    el.infoQualityNote.textContent = quality.note;
    el.infoQuality.parentElement.title = 'Perkiraan dari bitrate per piksel per frame. Bukan jaminan kualitas visual.';
    el.infoAudio.textContent = audioLabel(info.audio);
    el.fileDetails.hidden = false;
  }

  function hdrIsHdr(kind) {
    return kind === 'dolby-vision' || kind === 'hdr10plus' || kind === 'hdr10' || kind === 'hlg';
  }

  function updateHdrUi(info, checking) {
    if (!el.hdrStatus || !el.hdrBadge || !el.hdrPreserve) return;
    var found = !!(info && info.found);
    var isHdr = found && hdrIsHdr(info.kind);
    var badgeClass = 'hdr-badge';
    var badge = 'Belum diperiksa';
    var status = 'Pilih video untuk memeriksa format HDR.';

    if (checking) {
      badge = 'Memeriksa…';
      status = 'Membaca metadata HDR dari file…';
    } else if (!info) {
      badge = 'Belum diperiksa';
    } else if (!found) {
      badge = 'Tidak terbaca';
      status = 'Struktur MP4 tidak terbaca untuk deteksi HDR. Video tetap bisa diproses sebagai SDR.';
    } else if (info.kind === 'dolby-vision') {
      badgeClass += ' is-hdr is-dv';
      badge = info.hdr10plus ? 'DV + HDR10+' : 'Dolby Vision';
      var dvExtra = info.dv && info.dv.profile ? ' Profile ' + info.dv.profile : '';
      status = 'Dolby Vision' + dvExtra + ' terdeteksi.' +
        (info.hdr10plus ? ' HDR10+ juga ada.' : '') +
        ' Metadata HDR/DV asli bisa dipertahankan.';
    } else if (info.kind === 'hdr10plus') {
      badgeClass += ' is-hdr';
      badge = 'HDR10+';
      status = 'HDR10+ terdeteksi. Metadata dinamis per-scene ikut tersalin bersama bitstream.';
    } else if (info.kind === 'hdr10') {
      badgeClass += ' is-hdr';
      badge = 'HDR10';
      status = 'HDR10 terdeteksi. Metadata statis dipertahankan; HDR10+ tidak bisa dibuat tanpa encode ulang.';
    } else if (info.kind === 'hlg') {
      badgeClass += ' is-hdr';
      badge = 'HLG';
      status = 'HLG terdeteksi. Sinyal HDR dipertahankan.';
    } else if (info.kind === 'sdr') {
      badgeClass += ' is-sdr';
      badge = 'SDR';
      status = 'Sumber SDR (BT.709). SDR tidak bisa diubah menjadi HDR10+/Dolby Vision tanpa encode ulang; tidak ada metadata HDR/DV untuk dipertahankan.';
    } else {
      badge = 'HDR?';
      status = 'Format HDR tidak dikenali. Hasil tetap aman sebagai SDR.';
    }

    el.hdrBadge.className = badgeClass;
    el.hdrBadge.textContent = badge;
    el.hdrStatus.textContent = status;

    var enabled = isHdr;
    el.hdrPreserve.disabled = state.busy || !enabled;
    el.hdrToggle.classList.toggle('is-disabled', !enabled);
    el.hdrPreserve.checked = enabled && state.hdrPreserve;
    if (state.busy) {
      el.hdrToggleNote.textContent = 'Tunggu proses selesai.';
    } else if (!enabled) {
      el.hdrToggleNote.textContent = 'Nonaktif — sumber SDR tetap SDR; konversi HDR butuh encode ulang.';
    } else if (state.hdrPreserve) {
      el.hdrToggleNote.textContent = 'Aktif — penanda HDR/DV dan metadata statis disalin ke hasil.';
    } else {
      el.hdrToggleNote.textContent = 'Nonaktif — metadata HDR/DV dilepas mengikuti resep lama.';
    }
  }

  async function probeMedia(file) {
    var result = { hdr: null, video: null };
    var patcher = window.KoRifCanPatcher;
    if (!patcher || (!patcher.inspectHdr && !patcher.inspectVideo)) return result;
    var headSize = Math.min(file.size, 8 * 1024 * 1024);
    try {
      var head = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
      if (patcher.inspectHdr) {
        result.hdr = patcher.inspectHdr(head, { scanSamples: true, maxSamples: 90 });
      }
      if (patcher.inspectVideo) {
        result.video = patcher.inspectVideo(head);
      }
      var needHdr = !result.hdr || !result.hdr.found;
      var needVideo = !result.video || !result.video.found;
      if ((needHdr || needVideo) && file.size > headSize) {
        var tailSize = Math.min(file.size, 8 * 1024 * 1024);
        var tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
        if (needHdr && patcher.inspectHdr) {
          var tailHdr = patcher.inspectHdr(tail, { scanSamples: false });
          if (tailHdr && tailHdr.found) result.hdr = tailHdr;
        }
        if (needVideo && patcher.inspectVideo) {
          var tailVideo = patcher.inspectVideo(tail);
          if (tailVideo && tailVideo.found) result.video = tailVideo;
        }
      }
    } catch (err) {
      console.warn('[media]', err);
    }
    return result;
  }

  function readStoredPreset() {
    try {
      var value = localStorage.getItem(STORE_KEY);
      return value === 'iphone' || value === 'best' ? value : null;
    } catch (err) {
      return null;
    }
  }

  function storePreset(preset) {
    try { localStorage.setItem(STORE_KEY, preset); } catch (err) { /* ignore */ }
  }

  function setPreset(preset, persist) {
    if (preset !== 'iphone') preset = 'best';
    state.preset = preset;
    for (var i = 0; i < el.presetInputs.length; i++) {
      el.presetInputs[i].checked = el.presetInputs[i].value === preset;
    }
    for (var j = 0; j < el.presetOptions.length; j++) {
      el.presetOptions[j].classList.toggle('is-selected', el.presetOptions[j].getAttribute('data-preset') === preset);
    }
    if (persist !== false) storePreset(preset);
    updateProcessUi();
  }

  function baseNote() {
    if (!state.file) return 'Pilih video dulu untuk mulai.';
    if (state.file.size > LARGE_FILE_BYTES) {
      return 'File besar — sebaiknya gunakan desktop dengan RAM cukup.';
    }
    return PRESETS[state.preset].note;
  }

  function updateProcessUi() {
    if (state.busy) {
      el.processLabel.textContent = 'Memproses…';
    } else if (state.file) {
      el.processLabel.textContent = 'Proses · ' + PRESETS[state.preset].short;
    } else {
      el.processLabel.textContent = 'Proses video';
    }
    el.btnProcess.disabled = state.busy || !state.file;
    if (!state.busy) el.processNote.textContent = baseNote();
  }

  function setBusy(busy) {
    state.busy = busy;
    document.body.classList.toggle('is-busy', busy);
    el.studioCard.setAttribute('aria-busy', busy ? 'true' : 'false');
    el.dropzone.setAttribute('aria-disabled', busy ? 'true' : 'false');
    el.fileInput.disabled = busy;
    el.btnChange.disabled = busy;
    el.btnRemove.disabled = busy;
    el.btnAgain.disabled = busy;
    if (el.hdrPreserve) el.hdrPreserve.disabled = busy || !hdrIsHdr(state.hdrInfo && state.hdrInfo.kind);
    for (var i = 0; i < el.presetInputs.length; i++) el.presetInputs[i].disabled = busy;
    updateProcessUi();
    updateHdrUi(state.hdrInfo);
    if (busy) el.processNote.textContent = 'Jangan tutup tab ini selama proses berjalan.';
  }

  function setProgress(pct) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    el.barFill.style.width = pct + '%';
    el.progressPct.textContent = pct + '%';
    el.progressBar.setAttribute('aria-valuenow', String(pct));
  }

  function setStage(index, sub, pct) {
    state.stage = index;
    for (var i = 0; i < el.stages.length; i++) {
      el.stages[i].classList.toggle('is-done', i < index);
      el.stages[i].classList.toggle('is-active', i === index);
      el.stages[i].classList.remove('is-error');
    }
    el.progressTitle.textContent = STAGE_TITLES[index] || 'Sedang menyiapkan videomu';
    el.progressSub.textContent = sub || 'Jangan tutup tab ini selama proses berjalan.';
    setProgress(pct);
  }

  function resetStages() {
    for (var i = 0; i < el.stages.length; i++) {
      el.stages[i].classList.remove('is-active', 'is-done', 'is-error');
    }
  }

  function beginProgress() {
    el.progressPanel.hidden = false;
    el.resultPanel.hidden = true;
    el.errorBox.hidden = true;
    resetStages();
    setStage(0, 'Membaca file dari perangkat…', 2);
    try {
      el.progressPanel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    } catch (err) { /* ignore */ }
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function hideError() {
    el.errorBox.hidden = true;
    el.errorText.textContent = '';
  }

  function showError(err) {
    var message = friendlyError(err);
    el.resultPanel.hidden = true;
    el.errorText.textContent = message;
    el.errorBox.hidden = false;
    if (state.busy) {
      el.progressPanel.hidden = false;
      el.progressTitle.textContent = 'Proses terhenti';
      el.progressSub.textContent = 'Periksa pesan di bawah, lalu coba lagi.';
      if (el.stages[state.stage]) el.stages[state.stage].classList.add('is-error');
    } else {
      el.progressPanel.hidden = true;
    }
    try {
      el.errorBox.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    } catch (e) { /* ignore */ }
  }

  function friendlyError(err) {
    if (err && err.isUserFacing) return err.message;
    var message = String((err && err.message) || err || '');
    if (/memory|allocation|out of bounds|RangeError|Array buffer/i.test(message)) {
      return 'Memori browser tidak cukup untuk video ini. Coba file yang lebih kecil atau gunakan desktop dengan RAM cukup.';
    }
    if (/WebAssembly|wasm|not supported/i.test(message)) {
      return 'Browser ini belum bisa menjalankan mesin video. Gunakan Chrome, Edge, Firefox, atau Safari versi terbaru.';
    }
    if (/fetch|network|Failed to load|load ffmpeg|importScripts/i.test(message)) {
      return 'Mesin ffmpeg gagal dimuat. Periksa koneksi internet, lalu muat ulang halaman dan coba lagi.';
    }
    if (/audio|soun|trek audio/i.test(message)) {
      return 'Video ini tidak memiliki trek audio. Tambahkan musik atau suara di editor terlebih dahulu, lalu proses lagi.';
    }
    return 'Terjadi kesalahan saat memproses video. Pastikan file MP4/MOV tidak rusak, lalu coba lagi.';
  }

  function clearResult() {
    if (state.outUrl) {
      try { URL.revokeObjectURL(state.outUrl); } catch (err) { /* ignore */ }
      state.outUrl = null;
    }
    try {
      el.preview.pause();
      el.preview.removeAttribute('src');
      el.preview.load();
    } catch (err) { /* ignore */ }
    el.resultPanel.hidden = true;
  }

  function probeVideo(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var video = document.createElement('video');
      var settled = false;
      var timer = setTimeout(function () {
        finish({ duration: 0, width: 0, height: 0 });
      }, 8000);

      function finish(meta) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          video.removeAttribute('src');
          video.load();
        } catch (err) { /* ignore */ }
        URL.revokeObjectURL(url);
        resolve(meta);
      }

      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = function () {
        finish({
          duration: isFinite(video.duration) && video.duration > 0 ? video.duration : 0,
          width: video.videoWidth || 0,
          height: video.videoHeight || 0
        });
      };
      video.onerror = function () {
        finish({ duration: 0, width: 0, height: 0 });
      };
      video.src = url;
    });
  }

  function setFile(file) {
    if (!file || state.busy) return;
    if (!isVideoFile(file)) {
      showError(fail('Pilih file MP4 atau MOV. Format lain belum didukung untuk resep ini.'));
      return;
    }
    if (!file.size) {
      showError(fail('File ini kosong. Pilih video lain.'));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showError(fail('File terlalu besar untuk diproses di browser (maksimal 1,5 GB). Coba video yang lebih kecil.'));
      return;
    }

    state.file = file;
    state.fileMeta = null;
    state.videoInfo = null;
    state.hdrInfo = null;
    var token = ++state.probeToken;
    var hdrToken = ++state.hdrProbeToken;

    clearResult();
    hideError();
    el.progressPanel.hidden = true;
    el.fileName.textContent = file.name;
    el.fileMeta.textContent = formatBytes(file.size) + ' · membaca metadata…';
    el.fileDetails.hidden = true;
    el.fileCard.hidden = false;
    el.btnProcess.disabled = false;
    updateHdrUi(null, true);
    updateProcessUi();

    probeVideo(file).then(function (meta) {
      if (state.file !== file || state.probeToken !== token) return;
      state.fileMeta = meta;
      updateFileMeta(file);
    });

    probeMedia(file).then(function (result) {
      if (state.file !== file || state.hdrProbeToken !== hdrToken) return;
      state.hdrInfo = result.hdr;
      state.videoInfo = result.video;
      updateHdrUi(result.hdr);
      renderVideoInfo(file, result.video);
      updateFileMeta(file);
    });
  }

  function clearFile(scrollToStudio) {
    if (state.busy) return;
    state.file = null;
    state.fileMeta = null;
    state.videoInfo = null;
    state.hdrInfo = null;
    state.probeToken++;
    state.hdrProbeToken++;
    el.fileInput.value = '';
    el.fileCard.hidden = true;
    el.fileDetails.hidden = true;
    el.btnProcess.disabled = true;
    el.progressPanel.hidden = true;
    hideError();
    clearResult();
    resetStages();
    updateHdrUi(null);
    updateProcessUi();
    if (scrollToStudio) {
      try {
        el.dropzone.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
      } catch (err) { /* ignore */ }
    }
  }

  async function sha256hex(buffer) {
    if (!(window.crypto && crypto.subtle && crypto.subtle.digest)) {
      throw fail('Browser memblokir WebCrypto. Buka halaman lewat HTTPS, lalu coba lagi.');
    }
    var digest = await crypto.subtle.digest('SHA-256', buffer);
    var bytes = new Uint8Array(digest);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex.slice(0, 32);
  }

  function ensureFFmpeg() {
    if (state.ffmpeg) return Promise.resolve(state.ffmpeg);
    if (state.loadPromise) return state.loadPromise;

    state.loadPromise = (async function () {
      if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) {
        throw fail('Mesin ffmpeg gagal dimuat. Muat ulang halaman, lalu coba lagi.');
      }
      var ffmpeg = new window.FFmpegWASM.FFmpeg();
      ffmpeg.on('log', function (event) {
        if (event && event.message && /error|invalid|failed|No such/i.test(event.message)) {
          console.warn('[ffmpeg]', event.message);
        }
      });
      ffmpeg.on('progress', function (event) {
        if (!state.busy || state.phase !== 'ffmpeg' || !event) return;
        var ratio = Number(event.progress);
        if (!isFinite(ratio)) return;
        ratio = Math.max(0, Math.min(1, ratio));
        setProgress(20 + ratio * 58);
        el.progressSub.textContent = 'Menyalin video dan menyiapkan audio… ' + Math.round(ratio * 100) + '%';
      });
      try {
        await ffmpeg.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
      } catch (err) {
        try { ffmpeg.terminate(); } catch (e) { /* ignore */ }
        throw err;
      }
      state.ffmpeg = ffmpeg;
      return ffmpeg;
    })();

    state.loadPromise.catch(function () {
      state.loadPromise = null;
    });
    return state.loadPromise;
  }

  function destroyFFmpeg() {
    if (state.ffmpeg) {
      try { state.ffmpeg.terminate(); } catch (err) { /* ignore */ }
      state.ffmpeg = null;
    }
    state.loadPromise = null;
  }

  function disposeWorker() {
    if (state.worker) {
      try { state.worker.terminate(); } catch (err) { /* ignore */ }
      state.worker = null;
    }
  }

  function runPatcher(buffer, opts) {
    return new Promise(function (resolve, reject) {
      var worker;
      try {
        worker = new Worker(WORKER_URL);
      } catch (err) {
        reject(fail('Worker pemrosesan gagal dibuat. Muat ulang halaman, lalu coba lagi.'));
        return;
      }
      state.worker = worker;
      var settled = false;

      function finish(err, data) {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (e) { /* ignore */ }
        if (state.worker === worker) state.worker = null;
        if (err) reject(err);
        else resolve(data);
      }

      worker.onmessage = function (event) {
        var data = event.data || {};
        if (data.ok && data.buffer) {
          finish(null, { buffer: data.buffer, info: data.info || {} });
        } else {
          finish(fail(data.error || 'Gagal menyusun container MP4.'));
        }
      };
      worker.onerror = function (event) {
        finish(fail((event && event.message) || 'Worker pemrosesan gagal.'));
      };
      worker.onmessageerror = function () {
        finish(fail('Hasil pemrosesan gagal dikirim dari worker.'));
      };

      try {
        worker.postMessage({ buffer: buffer, opts: opts }, [buffer]);
      } catch (err) {
        finish(fail('Gagal mengirim video ke worker pemrosesan.'));
      }
    });
  }

  function outputName(original, preset) {
    var base = String(original || 'video')
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .trim();
    if (!base) base = 'video';
    return base + (preset === 'iphone' ? '-korifcan-iphone.mp4' : '-korifcan.mp4');
  }

  function showResult(file, data, preset, elapsedMs) {
    var blob = new Blob([data.buffer], { type: 'video/mp4' });
    var info = data.info || {};
    var hdr = info.hdr || {};
    var name = outputName(file.name, preset);

    if (state.outUrl) {
      try { URL.revokeObjectURL(state.outUrl); } catch (err) { /* ignore */ }
    }
    state.outUrl = URL.createObjectURL(blob);

    el.preview.src = state.outUrl;
    el.preview.load();
    el.preview.onloadedmetadata = function () {
      if (isFinite(el.preview.duration) && el.preview.duration > 0) {
        el.resultDuration.textContent = formatDuration(el.preview.duration);
      }
    };

    el.btnDownload.href = state.outUrl;
    el.btnDownload.download = name;
    el.studioFileName.textContent = name;
    el.resultName.textContent = name;
    el.resultSize.textContent = formatBytes(file.size) + ' → ' + formatBytes(blob.size);
    el.resultDuration.textContent = info.duration ? formatDuration(info.duration) : '—';
    el.resultPreset.textContent = PRESETS[preset].label;
    el.resultStream.textContent = (info.video && info.video.samples)
      ? info.video.samples.toLocaleString('id-ID') + ' frame · utuh'
      : 'Disalin utuh';
    if (el.resultHdr) {
      if (hdr.preserved && hdr.dolbyVision) el.resultHdr.textContent = hdr.hdr10plus ? 'DV + HDR10+ aktif' : 'Dolby Vision aktif';
      else if (hdr.preserved && hdr.hdr10plus) el.resultHdr.textContent = 'HDR10+ aktif';
      else if (hdr.preserved && hdr.source === 'hdr10') el.resultHdr.textContent = 'HDR10 aktif';
      else if (hdr.preserved && hdr.source === 'hlg') el.resultHdr.textContent = 'HLG aktif';
      else if (hdr.preserved) el.resultHdr.textContent = 'HDR aktif';
      else el.resultHdr.textContent = 'Tidak aktif';
    }
    el.resultMeta.textContent = 'metadata KoRifCan: mdta + iTunes · selesai dalam ' + (elapsedMs / 1000).toFixed(1) + ' detik';

    el.progressPanel.hidden = true;
    el.resultPanel.hidden = false;
    try {
      el.resultPanel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    } catch (err) { /* ignore */ }
  }

  async function processFile() {
    if (state.busy || !state.file) return;

    var file = state.file;
    var preset = state.preset;
    var started = (window.performance && performance.now) ? performance.now() : Date.now();

    setBusy(true);
    clearResult();
    hideError();
    beginProgress();

    var ab = null;

    try {
      setStage(0, 'Membaca file dari perangkat…', 3);
      ab = await file.arrayBuffer();
      if (!ab || ab.byteLength < 32) throw fail('File kosong atau tidak valid.');

      setStage(0, 'Menghitung sidik jari file…', 6);
      var copyright = await sha256hex(ab);

      setStage(0, 'Memeriksa metadata HDR & Dolby Vision…', 7);
      var hdrInfo = state.hdrInfo;
      try {
        if (window.KoRifCanPatcher && window.KoRifCanPatcher.inspectHdr) {
          hdrInfo = window.KoRifCanPatcher.inspectHdr(new Uint8Array(ab), { maxSamples: 240 });
          state.hdrInfo = hdrInfo;
          updateHdrUi(hdrInfo);
        }
      } catch (err) {
        console.warn('[hdr]', err);
      }

      setStage(0, 'Memeriksa struktur audio…', 8);
      try {
        if (window.KoRifCanPatcher && window.KoRifCanPatcher.normalizeForDecode) {
          window.KoRifCanPatcher.normalizeForDecode(new Uint8Array(ab));
        }
      } catch (err) {
        // A file with an unusual sample table can still be handled by ffmpeg.
        console.warn('[normalize]', err);
      }

      setStage(1, 'Menyiapkan mesin ffmpeg… halaman pertama mengunduh ±31 MB.', 9);
      var ffmpeg = await ensureFFmpeg();

      setStage(1, 'Menulis video ke memori ffmpeg…', 15);
      await ffmpeg.writeFile('input.mp4', new Uint8Array(ab));
      ab = null;

      setStage(2, 'Menyalin video dan menyiapkan audio…', 20);
      state.phase = 'ffmpeg';
      var code = await ffmpeg.exec(PRESETS[preset].args);
      state.phase = '';
      await ffmpeg.deleteFile('input.mp4').catch(function () {});
      if (code !== 0) {
        throw fail('Mesin ffmpeg gagal memproses video ini (kode ' + code + '). Pastikan file tidak rusak dan memiliki trek audio.');
      }

      var out = await ffmpeg.readFile('out.mp4');
      await ffmpeg.deleteFile('out.mp4').catch(function () {});
      if (!out || !out.byteLength) throw fail('Hasil ffmpeg kosong. Coba lagi dengan video lain.');
      var outBuffer = (out.byteOffset === 0 && out.byteLength === out.buffer.byteLength)
        ? out.buffer
        : out.slice().buffer;
      out = null;

      destroyFFmpeg();

      setStage(3, 'Menyusun container, audio, dan metadata…', 84);
      var hdrOpts = {
        preserve: false,
        sourceKind: (hdrInfo && hdrInfo.kind) || 'unknown',
        hdr10plus: !!(hdrInfo && hdrInfo.hdr10plus)
      };
      if (state.hdrPreserve && hdrInfo && hdrIsHdr(hdrInfo.kind)) {
        hdrOpts.preserve = true;
        hdrOpts.dolbyVision = !!(hdrInfo.dv && hdrInfo.dv.profile);
        hdrOpts.dvBoxType = hdrInfo.dv ? hdrInfo.dv.type : 'dvvC';
        hdrOpts.dvConfigHex = hdrInfo.dv ? hdrInfo.dv.configHex : '';
        hdrOpts.staticBoxes = hdrInfo.staticBoxes || {};
      }
      var patched = await runPatcher(outBuffer, {
        preset: preset,
        artist: ARTIST,
        comment: COMMENT,
        copyright: copyright,
        teIsReencode: '1',
        encoder: ENCODER,
        hdr: hdrOpts
      });

      setStage(4, 'Menyiapkan file unduhan…', 97);
      var elapsed = ((window.performance && performance.now) ? performance.now() : Date.now()) - started;
      el.progressPct.textContent = '100%';
      el.barFill.style.width = '100%';
      showResult(file, patched, preset, elapsed);
    } catch (err) {
      console.error(err);
      showError(err);
    } finally {
      state.phase = '';
      destroyFFmpeg();
      disposeWorker();
      setBusy(false);
    }
  }

  function resetAll() {
    clearFile(false);
    try {
      el.dropzone.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    } catch (err) { /* ignore */ }
  }

  function bind() {
    el.dropzone.addEventListener('click', function () {
      if (!state.busy) el.fileInput.click();
    });
    el.dropzone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!state.busy) el.fileInput.click();
      }
    });

    var dragDepth = 0;
    el.dropzone.addEventListener('dragenter', function (event) {
      event.preventDefault();
      event.stopPropagation();
      dragDepth++;
      if (!state.busy) el.dropzone.classList.add('drag');
    });
    el.dropzone.addEventListener('dragover', function (event) {
      event.preventDefault();
      event.stopPropagation();
    });
    el.dropzone.addEventListener('dragleave', function (event) {
      event.preventDefault();
      event.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) el.dropzone.classList.remove('drag');
    });
    el.dropzone.addEventListener('drop', function (event) {
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      el.dropzone.classList.remove('drag');
      if (state.busy) return;
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files[0]) setFile(files[0]);
    });

    window.addEventListener('dragover', function (event) { event.preventDefault(); });
    window.addEventListener('drop', function (event) { event.preventDefault(); });

    el.fileInput.addEventListener('change', function () {
      var file = el.fileInput.files && el.fileInput.files[0];
      el.fileInput.value = '';
      if (file) setFile(file);
    });

    el.btnChange.addEventListener('click', function () {
      if (!state.busy) el.fileInput.click();
    });
    el.btnRemove.addEventListener('click', function () {
      clearFile(false);
    });
    el.btnProcess.addEventListener('click', processFile);
    el.btnAgain.addEventListener('click', resetAll);
    el.btnErrorClose.addEventListener('click', hideError);

    for (var i = 0; i < el.presetInputs.length; i++) {
      el.presetInputs[i].addEventListener('change', function (event) {
        if (event.target.checked) setPreset(event.target.value);
      });
    }

    if (el.hdrPreserve) {
      el.hdrPreserve.addEventListener('change', function () {
        state.hdrPreserve = el.hdrPreserve.checked;
        updateHdrUi(state.hdrInfo);
      });
    }

    window.addEventListener('beforeunload', function (event) {
      if (!state.busy) return;
      event.preventDefault();
      event.returnValue = '';
    });

    window.addEventListener('pagehide', function () {
      destroyFFmpeg();
      disposeWorker();
    });
  }

  function initReveal() {
    var items = document.querySelectorAll('[data-reveal]');
    if (!items.length) return;
    if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
      for (var i = 0; i < items.length; i++) items[i].classList.add('is-visible');
      return;
    }
    document.documentElement.classList.add('js-reveal');
    var observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          entries[i].target.classList.add('is-visible');
          observer.unobserve(entries[i].target);
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    for (var j = 0; j < items.length; j++) {
      items[j].style.transitionDelay = ((j % 3) * 70) + 'ms';
      observer.observe(items[j]);
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(new URL('sw.js', location.href).href).catch(function () {});
    });
  }

  function init() {
    bind();
    setPreset(readStoredPreset() || 'best', false);
    updateHdrUi(null);
    updateProcessUi();
    var year = $('year');
    if (year) year.textContent = String(new Date().getFullYear());
    initReveal();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
