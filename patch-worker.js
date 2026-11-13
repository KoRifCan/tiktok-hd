/* KoRifCan container patcher worker.
 * A fresh worker is created for every run so large transfers never share
 * state between two consecutive processes. */
importScripts('mp4-patcher.js?v=20261113c');

self.onmessage = function (event) {
  var data = event.data || {};
  try {
    var input = new Uint8Array(data.buffer);
    var result = KoRifCanPatcher.patch(input, data.opts || {});
    var out = new Uint8Array(result.size);
    var offset = 0;
    for (var i = 0; i < result.parts.length; i++) {
      out.set(result.parts[i], offset);
      offset += result.parts[i].length;
    }
    if (offset !== result.size) {
      throw new Error('Ukuran hasil patch tidak konsisten.');
    }
    self.postMessage({
      ok: true,
      buffer: out.buffer,
      info: {
        preset: result.preset,
        duration: result.duration,
        movieTimescale: result.movieTimescale,
        movieDuration: result.movieDuration,
        video: result.video,
        audio: result.audio,
        hdr: result.hdr
      }
    }, [out.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
