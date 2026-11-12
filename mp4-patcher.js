/* KoRifCan TikTok upload prep - MP4 container patcher.
 *
 * The video bitstream is never re-encoded. This module only rebuilds the
 * MP4 container around the exact samples produced by the ffmpeg stream-copy
 * step:
 *   - keeps every video sample byte-for-byte,
 *   - optionally restores the source HDR/Dolby Vision container signalling
 *     (dvvC/dby1, mdcv, clli, colr) without touching those samples,
 *   - rebuilds one or two AAC audio tracks with the KoRifCan silent tails,
 *   - clones the HQ audio track (shared media data, separate trak),
 *   - writes KoRifCan mdta metadata,
 *   - relocates chunk offsets for the rebuilt faststart moov.
 *
 * It deliberately expands every audio chunk to one sample per chunk. Some
 * ffmpeg builds put several AAC packets in the final chunk; keeping the
 * original stsc in that case produces broken decode timelines.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KoRifCanPatcher = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ARTIST = 'KoRifCan https://www.tiktok.com/@korifcan';
  var COMMENT = 'KoRifCan https://www.tiktok.com/@korifcan';
  var ENCODER = 'Lavf60.16.100';

  // Silent AAC packets recovered from the reference recipes.
  // Best Quality / iPhone HQ (48 kHz): 18 or 19 packets, starting with the
  // 23-byte "Lavc" packet for Best and a 6-byte packet for iPhone.
  var TAIL_HQ_BEST = makeTail('de02004c61766336322e31312e31303000422008c11838', 17);
  var TAIL_HQ_IPHONE = makeTail('217004608c1c', 18);
  var TAIL_COMPAT_441 = makeTail('211004608c1c', 6);

  // Extra samples used by the 44.1 kHz compatibility track. The reference
  // file gives this shift a final partial frame of 162 samples.
  var COMPAT_TAIL_DURATIONS = [1024, 1024, 1024, 1024, 1024, 1024, 162];

  // AudioSpecificConfig values and sample-entry bitrates recovered from the
  // two reference containers.
  var DSI_48K_5 = hex('119056e500');
  var DSI_48K_2 = hex('1190');
  var DSI_48K_8 = hex('118004c040002000');
  var DSI_441K_5 = hex('121056e500');

  function makeTail(firstHex, restCount) {
    var first = hex(firstHex);
    var rest = hex('211004608c1c');
    var bytes = [first];
    var sizes = [first.length];
    for (var i = 0; i < restCount; i++) {
      bytes.push(rest);
      sizes.push(rest.length);
    }
    return { bytes: concat(bytes), sizes: sizes, count: sizes.length };
  }

  // ---------------------------------------------------------------------
  // Byte utilities
  // ---------------------------------------------------------------------

  function hex(s) {
    var a = new Uint8Array(s.length / 2);
    for (var i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16);
    return a;
  }

  function u32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  function i32(b, o) {
    var v = u32(b, o);
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }
  function u64(b, o) {
    return u32(b, o) * 4294967296 + u32(b, o + 4);
  }
  function u16(b, o) {
    return ((b[o] << 8) | b[o + 1]) >>> 0;
  }
  function w32(b, o, v) {
    v = v >>> 0;
    b[o] = (v >>> 24) & 255;
    b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255;
    b[o + 3] = v & 255;
  }
  function w64(b, o, v) {
    w32(b, o, Math.floor(v / 4294967296));
    w32(b, o + 4, v % 4294967296);
  }
  function fourcc(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }
  function ascii(s) {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255;
    return a;
  }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return Buffer.from(s, 'utf8');
  }
  function zeros(n) {
    return new Uint8Array(n);
  }
  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], o);
      o += parts[i].length;
    }
    return out;
  }
  function box(type, payload) {
    var out = new Uint8Array(8 + payload.length);
    w32(out, 0, out.length);
    out.set(ascii(type), 4);
    out.set(payload, 8);
    return out;
  }
  function u32b(v) {
    var a = new Uint8Array(4);
    w32(a, 0, v);
    return a;
  }
  function u16b(v) {
    return new Uint8Array([(v >>> 8) & 255, v & 255]);
  }
  function u8b(v) {
    return new Uint8Array([v & 255]);
  }
  function u24b(v) {
    return new Uint8Array([(v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  }
  function copyBytes(b, start, end) {
    return new Uint8Array(b.subarray(start, end));
  }

  // ---------------------------------------------------------------------
  // Box parser
  // ---------------------------------------------------------------------

  function parseBoxes(b, start, end) {
    var out = [], pos = start;
    while (pos + 8 <= end) {
      var size = u32(b, pos);
      var type = fourcc(b, pos + 4);
      var hdr = 8;
      if (size === 1) {
        if (pos + 16 > end) break;
        size = u64(b, pos + 8);
        hdr = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < hdr || pos + size > end) break;
      out.push({ pos: pos, size: size, type: type, hdr: hdr });
      pos += size;
    }
    return out;
  }
  function childBoxes(b, parent) {
    return parseBoxes(b, parent.pos + parent.hdr, parent.pos + parent.size);
  }
  function findBox(list, type) {
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
    return null;
  }
  function boxBytes(b, b0) {
    return b.subarray(b0.pos, b0.pos + b0.size);
  }
  function copyBox(b, b0) {
    return new Uint8Array(b.subarray(b0.pos, b0.pos + b0.size));
  }
  function payloadBytes(b, b0) {
    return b.subarray(b0.pos + b0.hdr, b0.pos + b0.size);
  }

  // ---------------------------------------------------------------------
  // Table readers
  // ---------------------------------------------------------------------

  function readStts(b, bx) {
    var p = bx.pos + bx.hdr;
    var n = u32(b, p + 4), out = [], o = p + 8;
    for (var i = 0; i < n; i++) {
      out.push({ count: u32(b, o), delta: u32(b, o + 4) });
      o += 8;
    }
    return out;
  }
  function readStsc(b, bx) {
    var p = bx.pos + bx.hdr;
    var n = u32(b, p + 4), out = [], o = p + 8;
    for (var i = 0; i < n; i++) {
      out.push({ firstChunk: u32(b, o), samplesPerChunk: u32(b, o + 4), desc: u32(b, o + 8) });
      o += 12;
    }
    return out;
  }
  function readStsz(b, bx) {
    var p = bx.pos + bx.hdr;
    var fixed = u32(b, p + 4), n = u32(b, p + 8);
    var out = new Array(n);
    if (fixed) {
      for (var i = 0; i < n; i++) out[i] = fixed;
    } else {
      var o = p + 12;
      for (var j = 0; j < n; j++) { out[j] = u32(b, o); o += 4; }
    }
    return out;
  }
  function readStco(b, bx, wide) {
    var p = bx.pos + bx.hdr;
    var n = u32(b, p + 4), out = [], o = p + 8;
    for (var i = 0; i < n; i++) {
      out.push(wide ? u64(b, o) : u32(b, o));
      o += wide ? 8 : 4;
    }
    return out;
  }
  function readStsd(b, bx) {
    var p = bx.pos + bx.hdr;
    var n = u32(b, p + 4), o = p + 8, out = [];
    for (var i = 0; i < n; i++) {
      if (o + 8 > bx.pos + bx.size) break;
      var esz = u32(b, o);
      if (esz < 8 || o + esz > bx.pos + bx.size) break;
      out.push({
        type: fourcc(b, o + 4),
        size: esz,
        bytes: copyBytes(b, o, o + esz)
      });
      o += esz;
    }
    return out;
  }
  function readSbgp(b, bx) {
    var p = bx.pos + bx.hdr;
    var version = b[p];
    var grouping = fourcc(b, p + 4);
    var entryStart = p + (version === 1 ? 16 : 12);
    var countAt = p + (version === 1 ? 12 : 8);
    var n = u32(b, countAt);
    var entries = [];
    for (var i = 0; i < n; i++) {
      entries.push({
        sampleCount: u32(b, entryStart + i * 8),
        groupIndex: u32(b, entryStart + i * 8 + 4)
      });
    }
    return { version: version, grouping: grouping, entries: entries, headerSize: entryStart - p };
  }

  // ---------------------------------------------------------------------
  // Table builders
  // ---------------------------------------------------------------------

  function buildStts(entries) {
    var parts = [u32b(0), u32b(entries.length)];
    for (var i = 0; i < entries.length; i++) {
      parts.push(u32b(entries[i].count), u32b(entries[i].delta));
    }
    return box('stts', concat(parts));
  }
  function buildStsc(entries) {
    var parts = [u32b(0), u32b(entries.length)];
    for (var i = 0; i < entries.length; i++) {
      parts.push(u32b(entries[i].firstChunk), u32b(entries[i].samplesPerChunk), u32b(entries[i].desc));
    }
    return box('stsc', concat(parts));
  }
  function buildStsz(sizes) {
    var parts = [u32b(0), u32b(0), u32b(sizes.length)];
    for (var i = 0; i < sizes.length; i++) parts.push(u32b(sizes[i]));
    return box('stsz', concat(parts));
  }
  function buildStco(offsets) {
    var parts = [u32b(0), u32b(offsets.length)];
    for (var i = 0; i < offsets.length; i++) {
      if (offsets[i] > 0xffffffff) throw new Error('File terlalu besar untuk stco 32-bit.');
      parts.push(u32b(offsets[i]));
    }
    return box('stco', concat(parts));
  }
  function buildStsd(entries) {
    var parts = [u32b(0), u32b(entries.length)];
    for (var i = 0; i < entries.length; i++) parts.push(entries[i]);
    return box('stsd', concat(parts));
  }
  function buildSbgp(info, addSamples) {
    var entries = [];
    for (var i = 0; i < info.entries.length; i++) {
      entries.push({ sampleCount: info.entries[i].sampleCount, groupIndex: info.entries[i].groupIndex });
    }
    if (entries.length) {
      entries[entries.length - 1].sampleCount += addSamples;
    } else if (addSamples > 0) {
      entries.push({ sampleCount: addSamples, groupIndex: 1 });
    }
    var parts = [u32b(info.version === 1 ? 0x01000000 : 0), ascii(info.grouping)];
    if (info.version === 1) parts.push(u32b(0));
    parts.push(u32b(entries.length));
    for (var j = 0; j < entries.length; j++) {
      parts.push(u32b(entries[j].sampleCount), u32b(entries[j].groupIndex));
    }
    return box('sbgp', concat(parts));
  }

  // ---------------------------------------------------------------------
  // Track parsing
  // ---------------------------------------------------------------------

  function getHandler(b, trak) {
    var mdia = findBox(childBoxes(b, trak), 'mdia');
    if (!mdia) return '';
    var hdlr = findBox(childBoxes(b, mdia), 'hdlr');
    if (!hdlr) return '';
    return fourcc(b, hdlr.pos + hdlr.hdr + 8);
  }
  function getTrackId(b, trak) {
    var tkhd = findBox(childBoxes(b, trak), 'tkhd');
    if (!tkhd) return 0;
    var p = tkhd.pos + tkhd.hdr;
    return b[p] === 0 ? u32(b, p + 12) : u32(b, p + 20);
  }
  function getDuration(b, mdhd) {
    var p = mdhd.pos + mdhd.hdr;
    return b[p] === 0 ? u32(b, p + 16) : u64(b, p + 24);
  }
  function getTimescale(b, mdhd) {
    var p = mdhd.pos + mdhd.hdr;
    return b[p] === 0 ? u32(b, p + 12) : u32(b, p + 20);
  }

  function parseTrak(b, trak) {
    var kids = childBoxes(b, trak);
    var tkhd = findBox(kids, 'tkhd');
    var edts = findBox(kids, 'edts');
    var mdia = findBox(kids, 'mdia');
    if (!tkhd || !mdia) throw new Error('Struktur track MP4 tidak lengkap.');
    var mdiaKids = childBoxes(b, mdia);
    var mdhd = findBox(mdiaKids, 'mdhd');
    var hdlr = findBox(mdiaKids, 'hdlr');
    var minf = findBox(mdiaKids, 'minf');
    if (!mdhd || !hdlr || !minf) throw new Error('Struktur media MP4 tidak lengkap.');
    var minfKids = childBoxes(b, minf);
    var stbl = findBox(minfKids, 'stbl');
    if (!stbl) throw new Error('Struktur sample table MP4 tidak lengkap.');

    var info = {
      box: trak,
      kids: kids,
      tkhd: tkhd,
      edts: edts,
      mdia: mdia,
      mdiaKids: mdiaKids,
      mdhd: mdhd,
      hdlr: hdlr,
      minf: minf,
      minfKids: minfKids,
      stbl: stbl,
      stblKids: childBoxes(b, stbl),
      handler: getHandler(b, trak),
      trackId: getTrackId(b, trak),
      timescale: getTimescale(b, mdhd),
      duration: getDuration(b, mdhd),
      stsd: null,
      sizes: null,
      chunks: null,
      stsc: null,
      stts: null,
      stcoBox: null,
      co64Box: null,
      sbgp: null,
      sbgpBox: null
    };

    for (var i = 0; i < info.stblKids.length; i++) {
      var k = info.stblKids[i];
      if (k.type === 'stsd') info.stsd = readStsd(b, k);
      else if (k.type === 'stsz') info.sizes = readStsz(b, k);
      else if (k.type === 'stco') { info.stcoBox = k; info.chunks = readStco(b, k, false); }
      else if (k.type === 'co64') { info.co64Box = k; info.chunks = readStco(b, k, true); }
      else if (k.type === 'stsc') info.stsc = readStsc(b, k);
      else if (k.type === 'stts') info.stts = readStts(b, k);
      else if (k.type === 'sbgp') { info.sbgpBox = k; info.sbgp = readSbgp(b, k); }
    }
    return info;
  }

  function samplesPerChunk(stsc, chunkIndex) {
    var chosen = null;
    for (var i = 0; i < stsc.length; i++) {
      if (stsc[i].firstChunk <= chunkIndex) chosen = stsc[i];
      else break;
    }
    if (!chosen) throw new Error('stsc tidak valid.');
    return chosen.samplesPerChunk;
  }

  // ---------------------------------------------------------------------
  // HDR / Dolby Vision inspection
  // ---------------------------------------------------------------------

  function bytesToHex(a) {
    var out = '';
    for (var i = 0; i < a.length; i++) out += a[i].toString(16).padStart(2, '0');
    return out;
  }

  function findMoovOffset(b) {
    // A moov at the end of a file is not the first box in a tail slice.
    // Search for a plausible moov header and verify it contains mvhd.
    for (var i = 4; i + 8 <= b.length; i++) {
      if (b[i] !== 0x6d || b[i + 1] !== 0x6f || b[i + 2] !== 0x6f || b[i + 3] !== 0x76) continue;
      var start = i - 4;
      var size = u32(b, start);
      if (size === 0) size = b.length - start;
      else if (size === 1) {
        if (start + 16 > b.length) continue;
        size = u64(b, start + 8);
      }
      if (size < 16 || start + size > b.length) continue;
      var top = parseBoxes(b, start, start + size);
      if (!top.length || top[0].type !== 'moov') continue;
      var kids = childBoxes(b, top[0]);
      if (findBox(kids, 'mvhd')) return start;
    }
    return -1;
  }

  function readEntryInfo(entry) {
    var kids = parseBoxes(entry, 86, entry.length);
    var out = {
      type: fourcc(entry, 4),
      kids: kids,
      colr: null,
      dv: null,
      staticBoxes: {},
      bitDepth: 0,
      nalLength: 4
    };
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      var p = kid.pos + kid.hdr;
      if (kid.type === 'hvcC') {
        if (p + 22 <= entry.length) {
          out.bitDepth = (entry[p + 17] & 7) + 8;
          out.nalLength = (entry[p + 21] & 3) + 1;
        }
      } else if (kid.type === 'colr') {
        if (p + 4 > entry.length) continue;
        var colrType = fourcc(entry, p);
        if ((colrType === 'nclx' || colrType === 'nclc') && p + 11 <= entry.length) {
          out.colr = {
            type: colrType,
            primaries: u16(entry, p + 4),
            transfer: u16(entry, p + 6),
            matrix: u16(entry, p + 8),
            fullRange: colrType === 'nclx' ? (entry[p + 10] >> 7) : 0
          };
        }
      } else if (kid.type === 'dvvC' || kid.type === 'dvcC') {
        var payload = payloadBytes(entry, kid);
        if (payload.length >= 5) {
          out.dv = {
            type: kid.type,
            major: payload[0],
            minor: payload[1],
            profile: payload[2] >> 1,
            level: ((payload[2] & 1) << 5) | (payload[3] >> 3),
            rpu: (payload[3] >> 2) & 1,
            el: (payload[3] >> 1) & 1,
            bl: payload[3] & 1,
            compatibility: payload[4] >> 4,
            configHex: bytesToHex(payload)
          };
        }
      }
      if (kid.type === 'colr' || kid.type === 'mdcv' || kid.type === 'clli' ||
          kid.type === 'pasp' || kid.type === 'clap' || kid.type === 'fiel') {
        out.staticBoxes[kid.type] = bytesToHex(copyBox(entry, kid));
      }
    }
    return out;
  }

  function seiHasHdr10Plus(b, start, end) {
    var p = start;
    while (p + 2 <= end) {
      var payloadType = 0;
      while (p < end && b[p] === 0xff) { payloadType += 255; p++; }
      if (p >= end) return false;
      payloadType += b[p++];
      var payloadSize = 0;
      while (p < end && b[p] === 0xff) { payloadSize += 255; p++; }
      if (p >= end) return false;
      payloadSize += b[p++];
      if (p + payloadSize > end) return false;
      if (payloadType === 4 && payloadSize >= 6 &&
          b[p] === 0xb5 && b[p + 1] === 0x00 && b[p + 2] === 0x3c &&
          b[p + 3] === 0x00 && b[p + 4] === 0x01 && b[p + 5] === 0x04) {
        return true;
      }
      p += payloadSize;
    }
    return false;
  }

  function scanSampleNals(b, start, size, nalLength, found) {
    var p = start, end = start + size;
    while (p + nalLength <= end) {
      var len = 0;
      for (var i = 0; i < nalLength; i++) len = (len << 8) | b[p + i];
      var nalStart = p + nalLength;
      if (len <= 0 || nalStart + len > end) break;
      var type = (b[nalStart] >> 1) & 0x3f;
      if (type === 62) found.dvRpu = true;
      if ((type === 39 || type === 40) && seiHasHdr10Plus(b, nalStart + 2, nalStart + len)) {
        found.hdr10plus = true;
      }
      p = nalStart + len;
    }
  }

  function scanVideoHdr(b, video, entryInfo, options) {
    var found = { hdr10plus: false, dvRpu: false };
    if (!video || !video.sizes || !video.chunks || !video.stsc) return found;
    if (entryInfo.type !== 'hev1' && entryInfo.type !== 'hvc1') return found;
    var maxSamples = Math.min(options.maxSamples || 240, video.sizes.length);
    var maxBytes = options.maxBytes || (16 * 1024 * 1024);
    var bytesRead = 0;
    var si = 0;
    for (var ci = 1; ci <= video.chunks.length && si < maxSamples; ci++) {
      var off = video.chunks[ci - 1];
      var spc = samplesPerChunk(video.stsc, ci);
      for (var k = 0; k < spc && si < maxSamples && si < video.sizes.length; k++) {
        var size = video.sizes[si];
        if (off >= b.length) return found;
        if (off + size > b.length) return found;
        scanSampleNals(b, off, size, entryInfo.nalLength, found);
        bytesRead += size;
        off += size;
        si++;
        if (bytesRead > maxBytes) return found;
        if (found.hdr10plus && found.dvRpu) return found;
      }
    }
    return found;
  }

  function inspectHdr(input, options) {
    options = options || {};
    var original = input instanceof Uint8Array ? input : new Uint8Array(input);
    var b = original;
    var top = parseBoxes(b, 0, b.length);
    var moov = findBox(top, 'moov');
    var hasDby1 = false;
    var ftyp = findBox(top, 'ftyp');
    if (ftyp) {
      var fp = ftyp.pos + ftyp.hdr, fe = ftyp.pos + ftyp.size;
      while (fp + 4 <= fe) {
        if (fourcc(b, fp) === 'dby1') { hasDby1 = true; break; }
        fp += 4;
      }
    }
    if (!moov) {
      var moovOffset = findMoovOffset(b);
      if (moovOffset < 0) {
        return {
          found: false, kind: 'unknown', codec: '', bitDepth: 0,
          hdr10plus: false, dvRpu: false, dolbyVision: false, dv: null,
          staticBoxes: {}, color: null, hasDby1: false
        };
      }
      b = b.subarray(moovOffset);
      top = parseBoxes(b, 0, b.length);
      moov = findBox(top, 'moov');
    }
    if (!moov) {
      return {
        found: false, kind: 'unknown', codec: '', bitDepth: 0,
        hdr10plus: false, dvRpu: false, dolbyVision: false, dv: null,
        staticBoxes: {}, color: null, hasDby1: false
      };
    }

    var moovKids = childBoxes(b, moov);
    var video = null;
    for (var t = 0; t < moovKids.length; t++) {
      if (moovKids[t].type !== 'trak') continue;
      var tr;
      try { tr = parseTrak(b, moovKids[t]); } catch (err) { continue; }
      if (tr.handler === 'vide') { video = tr; break; }
    }
    if (!video || !video.stsd || !video.stsd.length) {
      return {
        found: false, kind: 'unknown', codec: '', bitDepth: 0,
        hdr10plus: false, dvRpu: false, dolbyVision: false, dv: null,
        staticBoxes: {}, color: null, hasDby1: false
      };
    }

    var entryInfo = readEntryInfo(video.stsd[0].bytes);
    var scan = { hdr10plus: false, dvRpu: false };
    // Sample offsets from stco are absolute file offsets. Only scan when the
    // inspected buffer starts at the beginning of that same file.
    if (options.scanSamples !== false && b === original) {
      try { scan = scanVideoHdr(b, video, entryInfo, options); } catch (err) { /* detection is best-effort */ }
    }

    var color = entryInfo.colr;
    var transfer = color ? color.transfer : 0;
    // Only container-level DV signalling makes a file recognizable as Dolby
    // Vision to players. An RPU NAL without dvvC/dby1 is just a residual
    // bitstream payload (for example after DV signalling was stripped).
    var dolbyVision = !!(entryInfo.dv || hasDby1);
    var kind = 'sdr';
    if (dolbyVision) kind = 'dolby-vision';
    else if (scan.hdr10plus) kind = 'hdr10plus';
    else if (transfer === 16) kind = 'hdr10';
    else if (transfer === 18) kind = 'hlg';
    else if (!color && (entryInfo.type !== 'hev1' && entryInfo.type !== 'hvc1')) kind = 'sdr';
    else if (!color && entryInfo.bitDepth <= 8) kind = 'sdr';
    else if (!color) kind = 'unknown';

    return {
      found: true,
      kind: kind,
      codec: entryInfo.type,
      bitDepth: entryInfo.bitDepth || 0,
      hdr10plus: scan.hdr10plus,
      dvRpu: scan.dvRpu,
      dolbyVision: dolbyVision,
      dv: entryInfo.dv,
      staticBoxes: entryInfo.staticBoxes,
      color: color,
      hasDby1: hasDby1,
      videoSamples: video.sizes ? video.sizes.length : 0
    };
  }

  function expandAudioSamples(info) {
    if (!info.sizes || !info.chunks || !info.stsc) {
      throw new Error('Tabel audio tidak lengkap.');
    }
    var out = [], si = 0;
    for (var ci = 1; ci <= info.chunks.length; ci++) {
      var spc = samplesPerChunk(info.stsc, ci);
      var off = info.chunks[ci - 1];
      for (var k = 0; k < spc; k++) {
        if (si >= info.sizes.length) {
          throw new Error('Tabel audio tidak konsisten (chunk berisi sample berlebih).');
        }
        out.push({ size: info.sizes[si], offset: off });
        off += info.sizes[si];
        si++;
      }
    }
    if (si !== info.sizes.length) {
      throw new Error('Tabel audio tidak konsisten (' + si + '/' + info.sizes.length + ' sample).');
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Field patchers
  // ---------------------------------------------------------------------

  function patchTkhd(b, bx, id, duration) {
    var p = copyBytes(b, bx.pos + bx.hdr, bx.pos + bx.size);
    var v = p[0];
    if (v === 0) {
      w32(p, 12, id);
      w32(p, 20, duration);
    } else {
      w32(p, 20, id);
      w64(p, 28, duration);
    }
    return box('tkhd', p);
  }
  function patchMdhd(b, bx, duration) {
    var p = copyBytes(b, bx.pos + bx.hdr, bx.pos + bx.size);
    var v = p[0];
    if (v === 0) w32(p, 16, duration);
    else w64(p, 24, duration);
    return box('mdhd', p);
  }
  function patchMvhd(b, bx, timescale, duration, nextTrackId) {
    var p = copyBytes(b, bx.pos + bx.hdr, bx.pos + bx.size);
    var v = p[0];
    if (v === 0) {
      w32(p, 12, timescale);
      w32(p, 16, duration);
      w32(p, 96, nextTrackId);
    } else {
      w32(p, 20, timescale);
      w64(p, 24, duration);
      w32(p, 108, nextTrackId);
    }
    return box('mvhd', p);
  }
  function buildElst(segmentDuration, mediaTime) {
    return box('elst', concat([
      u32b(0), u32b(1),
      u32b(segmentDuration), u32b(mediaTime >>> 0), u32b(0x00010000)
    ]));
  }
  function buildEdts(segmentDuration, mediaTime) {
    return box('edts', buildElst(segmentDuration, mediaTime));
  }

  // ---------------------------------------------------------------------
  // AAC sample entry builder
  // ---------------------------------------------------------------------

  function descriptor(tag, payload) {
    if (payload.length >= 0x80) throw new Error('Descriptor AAC terlalu besar.');
    return concat([u8b(tag), new Uint8Array([0x80, 0x80, 0x80, payload.length]), payload]);
  }
  function buildMp4aEntry(sampleRate, channels, dsi, esId, maxBitrate, avgBitrate) {
    var esPayload = concat([
      u16b(esId), u8b(0),
      descriptor(4, concat([
        u8b(0x40), u8b(0x15), u24b(0),
        u32b(maxBitrate), u32b(avgBitrate),
        descriptor(5, dsi)
      ])),
      descriptor(6, u8b(0x02))
    ]);
    var esds = box('esds', concat([u32b(0), descriptor(3, esPayload)]));
    var btrt = box('btrt', concat([u32b(0), u32b(maxBitrate), u32b(avgBitrate)]));
    var fixed = concat([
      zeros(6), u16b(1),
      u16b(0), u16b(0), u32b(0),
      u16b(channels), u16b(16), u16b(0), u16b(0),
      u32b(sampleRate * 65536)
    ]);
    return box('mp4a', concat([fixed, esds, btrt]));
  }
  function entryBits(entry) {
    var sr = u32(entry, 32) / 65536;
    var ch = u16(entry, 24);
    var max = 0, avg = 0;
    var kids = parseBoxes(entry, 36, entry.length);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].type === 'btrt') {
        max = u32(entry, kids[i].pos + kids[i].hdr + 4);
        avg = u32(entry, kids[i].pos + kids[i].hdr + 8);
      }
    }
    return { sampleRate: Math.round(sr), channels: ch || 2, max: max, avg: avg };
  }

  // ---------------------------------------------------------------------
  // Audio track planning and rebuilding
  // ---------------------------------------------------------------------

  function addTailDurations(stts, durations) {
    var out = [];
    for (var i = 0; i < stts.length; i++) out.push({ count: stts[i].count, delta: stts[i].delta });
    for (var j = 0; j < durations.length; j++) {
      var d = durations[j];
      if (out.length && out[out.length - 1].delta === d) out[out.length - 1].count++;
      else out.push({ count: 1, delta: d });
    }
    return out;
  }
  function sttsTotal(entries) {
    var n = 0;
    for (var i = 0; i < entries.length; i++) n += entries[i].count * entries[i].delta;
    return n;
  }
  function tailDurations(tail) {
    var out = [];
    for (var i = 0; i < tail.count; i++) out.push(1024);
    return out;
  }

  function makeAudioPlan(b, info, role, tail, trackId, mediaTime, segmentDuration, preset) {
    var mainSamples = expandAudioSamples(info);
    var durations = role === 'compat' ? COMPAT_TAIL_DURATIONS : tailDurations(tail);
    var mainStts = [];
    for (var i = 0; i < info.stts.length; i++) mainStts.push({ count: info.stts[i].count, delta: info.stts[i].delta });
    var newStts = addTailDurations(mainStts, durations);
    var totalDuration = sttsTotal(newStts);

    return {
      info: info,
      role: role,
      preset: preset,
      tail: tail,
      mainSamples: mainSamples,
      mainCount: mainSamples.length,
      totalCount: mainSamples.length + tail.count,
      stts: newStts,
      duration: totalDuration,
      trackId: trackId,
      mediaTime: mediaTime,
      segmentDuration: segmentDuration,
      nextTrackId: trackId + 1,
      tailBase: 0,
      mediaShift: 0,
      stsdSingle: false,
      clone: false
    };
  }

  function audioChunkOffsets(plan, mediaShift, tailBase) {
    var out = [];
    var i;
    for (i = 0; i < plan.mainSamples.length; i++) {
      out.push(plan.mainSamples[i].offset + mediaShift);
    }
    if (plan.role === 'compat') {
      // All compatibility-tail samples live in one final chunk.
      out.push(tailBase);
    } else {
      var acc = tailBase;
      for (i = 0; i < plan.tail.sizes.length; i++) {
        out.push(acc);
        acc += plan.tail.sizes[i];
      }
    }
    return out;
  }

  function audioStsc(plan) {
    var entries = [{ firstChunk: 1, samplesPerChunk: 1, desc: 1 }];
    if (plan.role === 'compat') {
      if (plan.tail.count > 1) {
        entries.push({
          firstChunk: plan.mainCount + 1,
          samplesPerChunk: plan.tail.count,
          desc: 1
        });
      }
    } else if (!plan.clone && plan.tail.count >= 8) {
      // The reference recipe marks the last eight silent frames with the
      // alternate sample description.
      entries.push({
        firstChunk: plan.mainCount + plan.tail.count - 7,
        samplesPerChunk: 1,
        desc: 2
      });
    }
    return entries;
  }

  function buildAudioStsd(b, plan, mediaShift) {
    var entries = [];
    if (plan.role === 'compat') {
      entries.push(buildMp4aEntry(44100, 2, DSI_441K_5, 3, 123360, 123360));
      return buildStsd(entries);
    }
    if (plan.clone) {
      if (plan.preset === 'iphone') {
        entries.push(buildMp4aEntry(48000, 2, DSI_48K_2, 3, 129344, 129344));
      } else {
        entries.push(buildMp4aEntry(48000, 2, DSI_48K_5, 2, 333746, 333746));
      }
      return buildStsd(entries);
    }
    if (plan.preset === 'iphone') {
      entries.push(buildMp4aEntry(48000, 2, DSI_48K_2, 2, 129344, 129344));
      entries.push(buildMp4aEntry(48000, 2, DSI_48K_8, 2, 129344, 129344));
    } else {
      entries.push(buildMp4aEntry(48000, 2, DSI_48K_5, 2, 333746, 333746));
      entries.push(buildMp4aEntry(48000, 2, DSI_48K_8, 2, 259228, 240066));
    }
    return buildStsd(entries);
  }

  function buildAudioStbl(b, plan, mediaShift, tailBase) {
    var kids = plan.info.stblKids;
    var parts = [];
    var sawStsd = false, sawStts = false, sawStsc = false, sawStsz = false, sawStco = false, sawSbgp = false;
    var offsets = audioChunkOffsets(plan, mediaShift, tailBase);
    var sizes = [];
    for (var i = 0; i < plan.mainSamples.length; i++) sizes.push(plan.mainSamples[i].size);
    for (var j = 0; j < plan.tail.sizes.length; j++) sizes.push(plan.tail.sizes[j]);

    for (var k = 0; k < kids.length; k++) {
      var kid = kids[k];
      if (kid.type === 'stsd') {
        parts.push(buildAudioStsd(b, plan, mediaShift));
        sawStsd = true;
      } else if (kid.type === 'stts') {
        parts.push(buildStts(plan.stts));
        sawStts = true;
      } else if (kid.type === 'stsc') {
        parts.push(buildStsc(audioStsc(plan)));
        sawStsc = true;
      } else if (kid.type === 'stsz') {
        parts.push(buildStsz(sizes));
        sawStsz = true;
      } else if (kid.type === 'stco' || kid.type === 'co64') {
        if (!sawStco) {
          parts.push(buildStco(offsets));
          sawStco = true;
        }
      } else if (kid.type === 'sbgp') {
        parts.push(buildSbgp(plan.info.sbgp, plan.tail.count));
        sawSbgp = true;
      } else {
        parts.push(copyBox(b, kid));
      }
    }
    if (!sawStsd) throw new Error('stsd audio tidak ditemukan.');
    if (!sawStts) throw new Error('stts audio tidak ditemukan.');
    if (!sawStsc) throw new Error('stsc audio tidak ditemukan.');
    if (!sawStsz) throw new Error('stsz audio tidak ditemukan.');
    if (!sawStco) throw new Error('stco audio tidak ditemukan.');
    if (!sawSbgp && plan.info.sbgp) parts.push(buildSbgp(plan.info.sbgp, plan.tail.count));
    return box('stbl', concat(parts));
  }

  function buildAudioMinf(b, plan, mediaShift, tailBase) {
    var kids = plan.info.minfKids;
    var parts = [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].type === 'stbl') parts.push(buildAudioStbl(b, plan, mediaShift, tailBase));
      else parts.push(copyBox(b, kids[i]));
    }
    return box('minf', concat(parts));
  }

  function buildAudioMdia(b, plan, mediaShift, tailBase) {
    var kids = plan.info.mdiaKids;
    var parts = [];
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid.type === 'mdhd') parts.push(patchMdhd(b, kid, plan.duration));
      else if (kid.type === 'minf') parts.push(buildAudioMinf(b, plan, mediaShift, tailBase));
      else parts.push(copyBox(b, kid));
    }
    return box('mdia', concat(parts));
  }

  function buildAudioTrak(b, plan, mediaShift, tailBase) {
    var parts = [
      patchTkhd(b, plan.info.tkhd, plan.trackId, plan.segmentDuration),
      buildEdts(plan.segmentDuration, plan.mediaTime),
      buildAudioMdia(b, plan, mediaShift, tailBase)
    ];
    // Preserve unusual extra children except the ones we rebuilt.
    for (var i = 0; i < plan.info.kids.length; i++) {
      var t = plan.info.kids[i].type;
      if (t !== 'tkhd' && t !== 'edts' && t !== 'mdia') parts.push(copyBox(b, plan.info.kids[i]));
    }
    return box('trak', concat(parts));
  }

  // ---------------------------------------------------------------------
  // Video track rebuilding
  // ---------------------------------------------------------------------

  function buildVideoStsd(b, info, hdr) {
    var preserve = !!(hdr && hdr.preserve);
    var staticBoxes = (hdr && hdr.staticBoxes) || {};
    var dvConfig = (preserve && hdr && hdr.dvConfigHex) ? hex(hdr.dvConfigHex) : null;
    var dvType = (hdr && hdr.dvBoxType) || 'dvvC';
    var entries = [];
    for (var e = 0; e < info.stsd.length; e++) {
      var entry = info.stsd[e].bytes;
      var kids = parseBoxes(entry, 86, entry.length);
      var parts = [];
      var changed = false;
      var sawDv = false;
      var sawStatic = {};
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        var type = kid.type;
        if (type === 'dvvC' || type === 'dvcC') {
          changed = true;
          if (preserve) {
            if (dvConfig && !sawDv) {
              parts.push({ type: dvType, bytes: box(dvType, dvConfig) });
              sawDv = true;
            } else if (!dvConfig) {
              parts.push({ type: type, bytes: copyBytes(entry, kid.pos, kid.pos + kid.size) });
              sawDv = true;
            }
          }
          continue;
        }
        parts.push({ type: type, bytes: copyBytes(entry, kid.pos, kid.pos + kid.size) });
        if (type === 'colr' || type === 'mdcv' || type === 'clli' ||
            type === 'pasp' || type === 'clap' || type === 'fiel') {
          sawStatic[type] = true;
        }
      }

      if (preserve) {
        if (dvConfig && !sawDv) {
          var dvAt = parts.length;
          for (var d = 0; d < parts.length; d++) {
            if (parts[d].type === 'hvcC') { dvAt = d + 1; break; }
          }
          parts.splice(dvAt, 0, { type: dvType, bytes: box(dvType, dvConfig) });
          changed = true;
        }
        var keep = ['colr', 'mdcv', 'clli', 'pasp', 'clap', 'fiel'];
        for (var s = 0; s < keep.length; s++) {
          var key = keep[s];
          if (!staticBoxes[key] || sawStatic[key]) continue;
          var addAt = parts.length;
          for (var q = 0; q < parts.length; q++) {
            if (parts[q].type === 'btrt') { addAt = q; break; }
          }
          parts.splice(addAt, 0, { type: key, bytes: hex(staticBoxes[key]) });
          changed = true;
        }
      }

      if (!changed) {
        entries.push(entry);
      } else {
        var head = copyBytes(entry, 0, 86);
        var bodyParts = [];
        for (var p = 0; p < parts.length; p++) bodyParts.push(parts[p].bytes);
        var body = concat(bodyParts);
        var size = head.length + body.length;
        var out = new Uint8Array(size);
        out.set(head, 0);
        out.set(body, 86);
        w32(out, 0, size);
        entries.push(out);
      }
    }
    return buildStsd(entries);
  }

  function buildVideoStbl(b, info, mediaShift, hdr) {
    var parts = [];
    for (var i = 0; i < info.stblKids.length; i++) {
      var kid = info.stblKids[i];
      if (kid.type === 'stsd') {
        parts.push(buildVideoStsd(b, info, hdr));
      } else if (kid.type === 'stco') {
        var offs = readStco(b, kid, false);
        for (var j = 0; j < offs.length; j++) offs[j] += mediaShift;
        parts.push(buildStco(offs));
      } else if (kid.type === 'co64') {
        var offs64 = readStco(b, kid, true);
        for (var k = 0; k < offs64.length; k++) offs64[k] += mediaShift;
        parts.push(buildStco(offs64));
      } else {
        parts.push(copyBox(b, kid));
      }
    }
    return box('stbl', concat(parts));
  }

  function buildVideoMinf(b, info, mediaShift, hdr) {
    var parts = [];
    for (var i = 0; i < info.minfKids.length; i++) {
      if (info.minfKids[i].type === 'stbl') parts.push(buildVideoStbl(b, info, mediaShift, hdr));
      else parts.push(copyBox(b, info.minfKids[i]));
    }
    return box('minf', concat(parts));
  }

  function buildVideoMdia(b, info, mediaShift, segmentDuration, hdr) {
    var parts = [];
    for (var i = 0; i < info.mdiaKids.length; i++) {
      var kid = info.mdiaKids[i];
      if (kid.type === 'minf') parts.push(buildVideoMinf(b, info, mediaShift, hdr));
      else parts.push(copyBox(b, kid));
    }
    return box('mdia', concat(parts));
  }

  function buildVideoTrak(b, info, mediaShift, segmentDuration, hdr) {
    var parts = [
      patchTkhd(b, info.tkhd, 1, segmentDuration),
      buildEdts(segmentDuration, 0),
      buildVideoMdia(b, info, mediaShift, segmentDuration, hdr)
    ];
    for (var i = 0; i < info.kids.length; i++) {
      var t = info.kids[i].type;
      if (t !== 'tkhd' && t !== 'edts' && t !== 'mdia') parts.push(copyBox(b, info.kids[i]));
    }
    return box('trak', concat(parts));
  }

  // ---------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------

  function buildUdta(opts, preset) {
    var entries = [
      ['artist', opts.artist || ARTIST],
      ['comment', opts.comment || COMMENT],
      ['copyright', opts.copyright || ''],
      ['te_is_reencode', opts.teIsReencode || '1'],
      ['encoder', opts.encoder || ENCODER]
    ];
    var hdlr = box('hdlr', concat([
      u32b(0), u32b(0), ascii('mdta'), zeros(12), u8b(0)
    ]));
    var keyParts = [u32b(0), u32b(entries.length)];
    var itemParts = [];
    for (var i = 0; i < entries.length; i++) {
      var keyBody = concat([ascii('mdta'), ascii(entries[i][0])]);
      keyParts.push(concat([u32b(4 + keyBody.length), keyBody]));
      var value = utf8(String(entries[i][1] == null ? '' : entries[i][1]));
      var dataBox = box('data', concat([u32b(1), u32b(0), value]));
      itemParts.push(concat([u32b(8 + dataBox.length), u32b(i + 1), dataBox]));
    }
    var meta = box('meta', concat([u32b(0), hdlr, box('keys', concat(keyParts)), box('ilst', concat(itemParts))]));
    return box('udta', meta);
  }

  // ---------------------------------------------------------------------
  // Main patcher
  // ---------------------------------------------------------------------

  // Rewrites only the sample-table entries that point at the alternate
  // 48 kHz AAC configuration used by the final tail of a KoRifCan file.
  // ffmpeg 5.1 cannot reconfigure its resampler for that config (it decodes
  // as SL+SR), so re-feeding a prepared file would otherwise fail. Mapping
  // those samples back to the primary entry keeps the bitstream readable
  // without touching unrelated MP4 files.
  function normalizeForDecode(input) {
    var b = input instanceof Uint8Array ? input : new Uint8Array(input);
    var changed = 0;
    var top = parseBoxes(b, 0, b.length);
    var moov = findBox(top, 'moov');
    if (!moov) return 0;
    var kids = childBoxes(b, moov);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].type !== 'trak') continue;
      var tr;
      try { tr = parseTrak(b, kids[i]); } catch (err) { continue; }
      if (tr.handler !== 'soun' || !tr.stsd || tr.stsd.length < 2 || !tr.stsc) continue;
      var stscBox = findBox(tr.stblKids, 'stsc');
      if (!stscBox) continue;
      var entriesAt = stscBox.pos + stscBox.hdr + 8;
      for (var e = 0; e < tr.stsc.length; e++) {
        var desc = tr.stsc[e].desc;
        if (desc <= 1 || desc > tr.stsd.length) continue;
        if (!isAltAacEntry(tr.stsd[desc - 1])) continue;
        w32(b, entriesAt + e * 12 + 8, 1);
        changed++;
      }
    }
    return changed;
  }
  function isAltAacEntry(entry) {
    if (!entry || entry.type !== 'mp4a') return false;
    var bytes = entry.bytes, pat = DSI_48K_8;
    for (var i = 0; i + pat.length <= bytes.length; i++) {
      var hit = true;
      for (var j = 0; j < pat.length; j++) {
        if (bytes[i + j] !== pat[j]) { hit = false; break; }
      }
      if (hit) return true;
    }
    return false;
  }

  function patch(input, opts) {
    opts = opts || {};
    var preset = opts.preset === 'iphone' ? 'iphone' : 'best';
    var b = input instanceof Uint8Array ? input : new Uint8Array(input);
    var top = parseBoxes(b, 0, b.length);
    var moov = null, mdat = null;
    for (var i = 0; i < top.length; i++) {
      if (top[i].type === 'moov') moov = top[i];
      else if (top[i].type === 'mdat') mdat = top[i];
    }
    if (!moov) throw new Error('File MP4 tidak memiliki moov.');
    if (!mdat) throw new Error('File MP4 tidak memiliki mdat.');
    if (mdat.pos + mdat.size !== b.length) throw new Error('mdat harus berada di akhir file.');

    var moovKids = childBoxes(b, moov);
    var mvhd = findBox(moovKids, 'mvhd');
    if (!mvhd) throw new Error('mvhd tidak ditemukan.');

    var video = null;
    var audios = [];
    for (var t = 0; t < moovKids.length; t++) {
      if (moovKids[t].type !== 'trak') continue;
      var tr = parseTrak(b, moovKids[t]);
      if (tr.handler === 'vide' && !video) video = tr;
      else if (tr.handler === 'soun') audios.push(tr);
    }
    if (!video) throw new Error('Track video tidak ditemukan.');
    if (!audios.length) throw new Error('Video tidak memiliki track audio.');
    if (preset === 'iphone' && audios.length < 2) {
      throw new Error('Preset iPhone membutuhkan dua track audio dari ffmpeg.');
    }
    if (!video.stsd || !video.stsd.length) throw new Error('stsd video tidak ditemukan.');
    if (!video.chunks) throw new Error('stco video tidak ditemukan.');

    var movieTs = preset === 'iphone' ? 384000 : 1000;
    var videoTs = video.timescale;
    var videoDuration = video.duration;
    var videoTkhdDuration = Math.ceil(videoDuration * movieTs / videoTs);
    var compatTkhdDuration = Math.round(Math.floor(videoDuration * 1000 / videoTs) * movieTs / 1000);

    // Build the audio plans. In the iPhone file the compatibility track is
    // first and the HQ track second, matching ffmpeg's output order.
    var plans = [];
    var compatPlan = null;
    var hqPlan = null;
    if (preset === 'iphone') {
      compatPlan = makeAudioPlan(b, audios[0], 'compat', TAIL_COMPAT_441, 4, 2112, compatTkhdDuration, preset);
      hqPlan = makeAudioPlan(b, audios[1], 'hq', TAIL_HQ_IPHONE, 2, 0, 0, preset);
      plans = [compatPlan, hqPlan];
    } else {
      hqPlan = makeAudioPlan(b, audios[0], 'hq', TAIL_HQ_BEST, 2, 0, 0, preset);
      plans = [hqPlan];
    }

    var movieDuration = Math.ceil(hqPlan.duration * movieTs / hqPlan.info.timescale);
    hqPlan.segmentDuration = movieDuration;
    if (compatPlan) compatPlan.segmentDuration = compatTkhdDuration;
    var clonePlan = makeAudioPlan(b, hqPlan.info, 'hq', hqPlan.tail, 3, 0, movieDuration, preset);
    clonePlan.clone = true;
    clonePlan.mainSamples = hqPlan.mainSamples;
    clonePlan.mainCount = hqPlan.mainCount;
    clonePlan.totalCount = hqPlan.totalCount;
    clonePlan.stts = hqPlan.stts;
    clonePlan.duration = hqPlan.duration;

    var nextTrackId = preset === 'iphone' ? 5 : 4;

    // Tail layout at the end of mdat: iPhone compatibility tail first, then
    // the HQ tail. Best only has the HQ tail.
    var tailParts = [];
    var compatTailBaseOffset = 0;
    var hqTailBaseOffset = 0;
    if (compatPlan) {
      tailParts.push(compatPlan.tail.bytes);
      hqTailBaseOffset += compatPlan.tail.bytes.length;
    }
    tailParts.push(hqPlan.tail.bytes);
    var tailBytes = concat(tailParts);

    var oldMdatDataStart = mdat.pos + mdat.hdr;
    var oldMdatPayloadSize = mdat.size - mdat.hdr;

    var preserveHdr = !!(opts.hdr && opts.hdr.preserve);
    var preserveDv = preserveHdr && !!(opts.hdr.dvConfigHex);

    function makeMoov(mediaShift, newTailStart, plansWithOffsets) {
      var parts = [];
      parts.push(patchMvhd(b, mvhd, movieTs, movieDuration, nextTrackId));
      parts.push(buildVideoTrak(b, video, mediaShift, videoTkhdDuration, opts.hdr));
      if (compatPlan) {
        parts.push(buildAudioTrak(b, compatPlan, mediaShift, newTailStart + compatTailBaseOffset));
      }
      parts.push(buildAudioTrak(b, hqPlan, mediaShift, newTailStart + hqTailBaseOffset));
      parts.push(buildUdta(opts, preset));
      parts.push(buildAudioTrak(b, clonePlan, mediaShift, newTailStart + hqTailBaseOffset));
      return box('moov', concat(parts));
    }

    // First pass: size only. All table offsets have fixed width, so a dummy
    // layout produces exactly the same moov size as the real one.
    var dummyMoov = makeMoov(0, 0);
    var ftypBrands = [ascii('isom'), u32b(0x200), ascii('isom')];
    if (preserveDv) ftypBrands.push(ascii('dby1'));
    ftypBrands.push(ascii('iso2'), ascii('mp41'));
    var ftyp = box('ftyp', concat(ftypBrands));
    var free = box('free', new Uint8Array(0));
    var newMdatDataStart = ftyp.length + dummyMoov.length + free.length + 8;
    var mediaShift = newMdatDataStart - oldMdatDataStart;
    var newTailStart = newMdatDataStart + oldMdatPayloadSize;
    var finalMoov = makeMoov(mediaShift, newTailStart);

    if (finalMoov.length !== dummyMoov.length) {
      // Extremely defensive: run one more pass if a builder ever changes size.
      newMdatDataStart = ftyp.length + finalMoov.length + free.length + 8;
      mediaShift = newMdatDataStart - oldMdatDataStart;
      newTailStart = newMdatDataStart + oldMdatPayloadSize;
      finalMoov = makeMoov(mediaShift, newTailStart);
    }

    var mdatHeader = new Uint8Array(8);
    w32(mdatHeader, 0, 8 + oldMdatPayloadSize + tailBytes.length);
    mdatHeader.set(ascii('mdat'), 4);

    var mdatPayload = b.subarray(oldMdatDataStart, oldMdatDataStart + oldMdatPayloadSize);
    var parts = [ftyp, finalMoov, free, mdatHeader, mdatPayload, tailBytes];
    var size = 0;
    for (var q = 0; q < parts.length; q++) size += parts[q].length;

    return {
      parts: parts,
      size: size,
      preset: preset,
      duration: movieDuration / movieTs,
      movieTimescale: movieTs,
      movieDuration: movieDuration,
      video: {
        timescale: videoTs,
        duration: videoDuration,
        segmentDuration: videoTkhdDuration,
        samples: video.sizes ? video.sizes.length : 0
      },
      audio: plans.map(function (p) {
        return {
          role: p.role,
          trackId: p.trackId,
          timescale: p.info.timescale,
          duration: p.duration,
          samples: p.totalCount,
          tailFrames: p.tail.count
        };
      }),
      hdr: {
        preserved: preserveHdr,
        dolbyVision: preserveDv,
        source: (opts.hdr && opts.hdr.sourceKind) || null,
        hdr10plus: !!(opts.hdr && opts.hdr.hdr10plus)
      }
    };
  }

  return {
    patch: patch,
    inspectHdr: inspectHdr,
    normalizeForDecode: normalizeForDecode,
    TAIL_HQ_BEST: TAIL_HQ_BEST,
    TAIL_HQ_IPHONE: TAIL_HQ_IPHONE,
    TAIL_COMPAT_441: TAIL_COMPAT_441
  };
});
