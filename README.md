# KoRifCan — TikTok Upload Prep

Situs statis untuk menyiapkan video sebelum diunggah ke TikTok, dengan dua resep:

- **Best Quality** — audio AAC 48 kHz kualitas tinggi, satu track + clone.
- **Best Quality For iPhone** — track kompatibilitas AAC 44,1 kHz 128 kbps, track HQ 48 kHz, dan clone.

Video **tidak pernah di-encode ulang**. Patcher hanya membangun ulang container MP4 di sekitar sampel video yang sudah ada. Semua proses berjalan di browser menggunakan ffmpeg.wasm dan WebAssembly; tidak ada file yang diunggah ke server.

## Cara kerja

1. Video dibaca ke memori browser.
2. `mp4-patcher.js` memeriksa sinyal HDR/DV di sumber (Dolby Vision `dvvC`/`dvcC`, brand `dby1`, RPU NAL type 62, SEI HDR10+, dan `colr` PQ/HLG).
3. ffmpeg.wasm melakukan stream copy video dan menyiapkan audio AAC (encode audio saja).
4. `mp4-patcher.js` menyusun ulang container:
   - mempertahankan setiap sampel video byte-per-byte,
   - menghapus penanda Dolby Vision level container (`dvvC`) bila opsi HDR/DV tidak aktif,
   - mengembalikan `dvvC`/`dvcC`, brand `dby1`, serta metadata statis (`colr`, `mdcv`, `clli`, `pasp`, `clap`, `fiel`) bila opsi HDR/DV aktif,
   - menulis tabel sampel, chunk offset, edit list, dan track audio sesuai resep,
   - menambahkan silent tail dan track clone,
   - menulis metadata mdta KoRifCan.
5. Hasil diunduh sebagai file MP4 baru. File asli tidak disentuh.

## HDR & Dolby Vision

Opsi **Pertahankan HDR/DV** aktif secara default bila sumbernya HDR/DV, dan
nonaktif (serta tidak bisa dipilih) untuk sumber SDR.

Yang benar-benar dilakukan opsi ini:

- Bitstream video tetap disalin byte-per-byte; tidak ada re-encode.
- Penanda container Dolby Vision (`dvvC`/`dvcC`) dan brand `dby1` dikembalikan.
- Metadata statis HDR (`colr` PQ, `mdcv`, `clli`, `pasp`, `clap`, `fiel`) dipertahankan atau ditambahkan bila hilang.
- Metadata dinamis yang sudah ada di dalam bitstream (RPU Dolby Vision dan SEI HDR10+) tetap utuh karena sampel video tidak disentuh.

Yang **tidak** dilakukan:

- Tidak mengubah video SDR menjadi HDR10, HDR10+, atau Dolby Vision.
- Tidak menambahkan metadata dinamis palsu.
- Tidak menjamin TikTok mempertahankan HDR/DV setelah upload.

Mengubah eksposur tidak bisa membuat HDR. HDR10/HDR10+ membutuhkan bitstream
10-bit PQ; HDR10+ membutuhkan metadata dinamis ST 2094-40 per scene; Dolby
Vision membutuhkan RPU per frame dan tooling berlisensi Dolby. Semua itu
memerlukan decode + encode ulang dan tetap tidak bisa disintesis hanya dari
slider eksposur. Karena itu KoRifCan memilih passthrough yang jujur, bukan label
HDR palsu.

Konversi SDR→HDR juga tidak ditawarkan di browser: selain butuh encode ulang
10-bit, core ffmpeg.wasm yang dipakai situs ini tidak menyelesaikan encode x265
dengan baik (bahkan satu frame 64×64 gagal dalam pengujian), dan encoder wasm
tanpa SIMD/threads tidak layak untuk video 1080p. Konversi nyata harus memakai
encoder desktop/server plus tooling metadata HDR10+/Dolby Vision.

Contoh hasil pada sumber Dolby Vision Profile 8.1 + HDR10+:

- 1.627/1.627 sampel video identik dengan sumber.
- `dvvC` `010010251000000000000000000000000000000000000000` dipertahankan.
- `ftyp` memuat `dby1`; `colr` tetap `nclx` 9/16/9.
- Tanpa opsi HDR, output kembali persis ke resep lama (tanpa `dvvC`/`dby1`).

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
- HDR/DV hanya dipertahankan dari sumber yang sudah HDR/DV. Sumber SDR tetap SDR; situs ini tidak melakukan konversi SDR→HDR dan tidak menambahkan label HDR palsu.
- Video wajib memiliki trek audio karena resep membangun ulang track audio.
- File besar membutuhkan RAM yang cukup; desktop lebih disarankan daripada ponsel.
- Mesin ffmpeg sekitar 31 MB dan di-cache service worker setelah kunjungan pertama.

## Lisensi

Kode situs ini dibuat untuk KoRifCan. ffmpeg.wasm mengikuti lisensi ffmpeg dan proyek asalnya.
