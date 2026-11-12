# KoRifCan — TikTok Upload Prep

Situs statis untuk menyiapkan video sebelum diunggah ke TikTok, dengan dua resep:

- **Best Quality** — audio AAC 48 kHz kualitas tinggi, satu track + clone.
- **Best Quality For iPhone** — track kompatibilitas AAC 44,1 kHz 128 kbps, track HQ 48 kHz, dan clone.

Video **tidak pernah di-encode ulang**. Patcher hanya membangun ulang container MP4 di sekitar sampel video yang sudah ada. Semua proses berjalan di browser menggunakan ffmpeg.wasm dan WebAssembly; tidak ada file yang diunggah ke server.

## Cara kerja

1. Video dibaca ke memori browser.
2. ffmpeg.wasm melakukan stream copy video dan menyiapkan audio AAC (encode audio saja).
3. `mp4-patcher.js` menyusun ulang container:
   - mempertahankan setiap sampel video byte-per-byte,
   - menghapus penanda Dolby Vision level container (`dvvC`) bila ada,
   - menulis tabel sampel, chunk offset, edit list, dan track audio sesuai resep,
   - menambahkan silent tail dan track clone,
   - menulis metadata mdta KoRifCan.
4. Hasil diunduh sebagai file MP4 baru. File asli tidak disentuh.

## Resep

### Best Quality

- Video: HEVC/H.264 stream copy, 100% sampel asli.
- Audio: AAC-LC 48 kHz stereo, target 346 kbps (encoder native ffmpeg).
- 18 frame silent tail, 8 frame terakhir memakai entri `stsd` kedua.
- Satu track audio HQ + satu track clone berbagi media data.
- Movie timescale 1000, faststart, video edit list media time 0.
- Metadata: `artist`, `comment`, `copyright`, `te_is_reencode`, `encoder`.

### Best Quality For iPhone

- Video: stream copy yang sama persis.
- Audio kompatibilitas: AAC-LC 44,1 kHz stereo 128 kbps, 7 frame tail.
- Audio HQ: AAC-LC 48 kHz stereo target 346 kbps, 19 frame tail.
- Track HQ memiliki clone; total tiga track audio.
- Movie timescale 384000; edit list kompatibilitas memakai media time 2112.
- Metadata mdta yang sama.

`copyright` berisi 32 karakter pertama SHA-256 file input sebagai sidik jari.

## Struktur

```
index.html          Halaman utama
style.css           Desain dan layout
app.js              UI, alur proses, ffmpeg.wasm
patch-worker.js     Worker untuk container patcher
mp4-patcher.js      Implementasi patcher MP4
sw.js               Cache runtime untuk aset ffmpeg
ffmpeg/             ffmpeg.wasm 5.1.4 (core + loader)
favicon.svg         Ikon situs
```

## Menjalankan lokal

Karena memakai WebAssembly dan WebCrypto, jalankan lewat HTTP lokal (bukan `file://`):

```bash
python3 -m http.server 8080
# buka http://localhost:8080
```

Tidak ada build step dan tidak ada dependensi npm.

## Catatan

- TikTok tetap memproses ulang video saat upload. Resep ini membantu mempertahankan kualitas, bukan jaminan hasil identik.
- Video wajib memiliki trek audio karena resep membangun ulang track audio.
- File besar membutuhkan RAM yang cukup; desktop lebih disarankan daripada ponsel.
- Mesin ffmpeg sekitar 31 MB dan di-cache service worker setelah kunjungan pertama.

## Lisensi

Kode situs ini dibuat untuk KoRifCan. ffmpeg.wasm mengikuti lisensi ffmpeg dan proyek asalnya.
