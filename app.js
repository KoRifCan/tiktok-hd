(function () {
  'use strict';

  var ARTIST = 'KoRifCan https://www.tiktok.com/@korifcan';
  var COMMENT = 'KoRifCan https://www.tiktok.com/@korifcan';
  var ENCODER = 'Lavf60.16.100';
  var CORE_URL = new URL('ffmpeg/ffmpeg-core.js', location.href).href;
  var WASM_URL = new URL('ffmpeg/ffmpeg-core.wasm', location.href).href;
  var WORKER_URL = new URL('patch-worker.js', location.href).href;
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
    preset: 'best',
    busy: false,
    phase: '',
    stage: 0,
    probeToken: 0,
    ffmpeg: null,
    loadPromise: null,
    worker: null,
    outUrl: null
  };

  function $(id) { return document.getElementById(id); }

  var el = {
    studioCard: $('studioCard'),
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    fileCard: $('fileCard'),
    fileName: $('fileName'),
    fileMeta: $('fileMeta'),
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
    resultMeta: $('resultMeta'),
    preview: $('preview'),
    btnDownload: $('btnDownload'),
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
    for (var i = 0; i < el.presetInputs.length; i++) el.presetInputs[i].disabled = busy;
    updateProcessUi();
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
    var token = ++state.probeToken;

    clearResult();
    hideError();
    el.progressPanel.hidden = true;
    el.fileName.textContent = file.name;
    el.fileMeta.textContent = formatBytes(file.size) + ' · membaca metadata…';
    el.fileCard.hidden = false;
    el.btnProcess.disabled = false;
    updateProcessUi();

    probeVideo(file).then(function (meta) {
      if (state.file !== file || state.probeToken !== token) return;
      state.fileMeta = meta;
      var parts = [formatBytes(file.size)];
      if (meta.width && meta.height) parts.push(meta.width + ' × ' + meta.height);
      if (meta.duration) parts.push(formatDuration(meta.duration));
      el.fileMeta.textContent = parts.join(' · ');
    });
  }

  function clearFile(scrollToStudio) {
    if (state.busy) return;
    state.file = null;
    state.fileMeta = null;
    state.probeToken++;
    el.fileInput.value = '';
    el.fileCard.hidden = true;
    el.btnProcess.disabled = true;
    el.progressPanel.hidden = true;
    hideError();
    clearResult();
    resetStages();
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
    el.resultName.textContent = name;
    el.resultSize.textContent = formatBytes(file.size) + ' → ' + formatBytes(blob.size);
    el.resultDuration.textContent = info.duration ? formatDuration(info.duration) : '—';
    el.resultPreset.textContent = PRESETS[preset].label;
    el.resultStream.textContent = (info.video && info.video.samples)
      ? info.video.samples.toLocaleString('id-ID') + ' frame · utuh'
      : 'Disalin utuh';
    el.resultMeta.textContent = 'artist & comment: KoRifCan · selesai dalam ' + (elapsedMs / 1000).toFixed(1) + ' detik';

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

      setStage(0, 'Memeriksa struktur audio…', 7);
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
      var patched = await runPatcher(outBuffer, {
        preset: preset,
        artist: ARTIST,
        comment: COMMENT,
        copyright: copyright,
        teIsReencode: '1',
        encoder: ENCODER
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
