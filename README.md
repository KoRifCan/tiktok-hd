# KoRifCan — TikTok Upload Prep

Situs statis untuk menyiapkan video sebelum diunggah ke TikTok, dengan dua resep:

- **Best Quality** — audio AAC 48 kHz kualitas tinggi, satu track + clone.
- **Best Quality For iPhone** — track kompatibilitas AAC 44,1 kHz 128 kbps, track HQ 48 kHz, dan clone.

Video **tidak pernah di-encode ulang**. Patcher hanya membangun ulang container MP4 di sekitar sampel video yang sudah ada. Semua proses berjalan di browser menggunakan ffmpeg.wasm dan WebAssembly; tidak ada file yang diunggah ke server.

Ada juga bagian **Cek TikTok** langsung di halaman utama untuk melihat statistik publik, metadata stream video TikTok, dan mengunduh videonya. Bagian ini terpisah dari alur upload prep dan punya pengungkapan privasi sendiri di bawah checker.

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
   - menulis metadata mdta dan atom iTunes KoRifCan.
5. Hasil diunduh sebagai file MP4 baru. File asli tidak disentuh.

## Info video

Setelah file dipilih, panel info membaca container MP4 secara lokal dan
menampilkan:

- resolusi tampilan (sudut rotasi diperhitungkan),
- frame rate rata-rata (CFR/VFR),
- durasi, codec dan profile, bit depth serta chroma subsampling,
- primaries/transfer warna (misalnya BT.2020 PQ),
- bitrate video, bitrate total, dan perkiraan kualitas dari bitrate per piksel
  per frame (bpp),
- codec audio, sample rate, jumlah kanal, dan jumlah trek audio.

Perkiraan kualitas adalah heuristik, bukan pengukuran kualitas visual. Panel ini
hanya membaca metadata container; tidak ada file yang dikirim ke server.

## Cek statistik, metadata & download TikTok

Checker tersedia langsung di halaman utama, di bagian
[`#cek-tiktok`](https://korifcan.github.io/tiktok-hd/#cek-tiktok), setelah Studio.
Tidak ada halaman terpisah. Setelah pengecekan berhasil, tombol **Download video**
mengambil file dari CDN TikTok dan menampilkan progres unduhan berupa persentase,
jumlah byte, serta kecepatan unduhan saat itu (rata-rata saat selesai). Alur
upload prep tidak berubah.

| Bagian | Isi |
| --- | --- |
| Statistik publik | Tayangan, suka, komentar, bagikan, disimpan, dan engagement rate (suka + komentar + bagikan + disimpan ÷ tayangan). |
| Video | Penulis dan @username, judul, tanggal, wilayah, cover, dan tautan ke TikTok. |
| Stream | Resolusi, FPS, durasi, codec, bit depth/chroma, HDR/DV, bitrate video dan audio, serta ukuran file. |
| Metode | Nilai metadata `artist` pada stream. Video hasil resep KoRifCan menampilkan `KoRifCan`; bila metadata hilang, `Tidak terdeteksi`. |
| Resep | Nilai metadata `comment` pada stream: `Best Quality` atau `Best Quality For iPhone`. |
| Cara cek | Berapa banyak file yang dibaca untuk metadata: file penuh, 2 MB pertama, atau 2 MB terakhir. |
| Kualitas stream | Label HD/SD dan status watermark dari stream yang dipilih TikWM. |
| Download | Tombol di kartu hasil yang mengambil file MP4 dari stream CDN yang sama, dengan progres unduhan. Tombol **Tempel** di kolom link membaca clipboard. |

Urutan kerjanya:

1. URL TikTok dikirim ke [TikWM](https://tikwm.com) untuk mengambil statistik
   dan URL stream bertanda tangan.
2. Browser mengirim `Range` request ke CDN TikTok: 2 MB pertama; bila `moov`
   tidak ditemukan, 2 MB terakhir.
3. `mp4-patcher.js` membaca `moov` lewat `inspectVideo`/`inspectHdr`. Tidak ada
   ffprobe, tidak ada re-encode, dan tidak ada backend.
4. Bila tombol **Download video** ditekan, browser mengambil file penuh dari
   URL stream yang sudah ditemukan sambil memperbarui progres, lalu
   menyimpannya sebagai MP4. Menekan tombol lagi saat unduhan berjalan akan
   membatalkannya.

Batas baca metadata sekitar 4 MB; video yang lebih besar dari itu tidak diunduh
penuh saat pengecekan. Kartu hasil menampilkan **Metode** (dari metadata `artist`),
**Resep** (dari metadata `comment`), dan **Cara cek** (2 MB pertama, 2 MB terakhir,
atau file penuh), bersama kualitas stream yang dipilih. Metadata yang tampil
berasal dari stream yang diberikan TikWM, bukan dari file asli di perangkat
pengunggah.

TikTok sering menghapus metadata `artist`/`comment` saat memproses ulang video.
Karena itu **Tidak terdeteksi** berarti metadata tidak ditemukan pada stream,
bukan bukti bahwa video tidak pernah memakai resep KoRifCan. Untuk file KoRifCan
lama yang `comment`-nya masih berisi `KoRifCan`, nama resep disimpulkan dari
jumlah trek audio (2 trek → Best Quality, 3 trek → Best Quality For iPhone).

### Privasi

Upload prep tetap **100% lokal** — file yang dipilih tidak dikirim ke mana pun.
Di bagian cek TikTok, URL video dikirim ke TikWM dan sebagian file diambil dari
CDN TikTok. Tombol download mengambil file dari CDN TikTok, bukan dari server
KoRifCan. Tidak ada file yang diunggah ke server KoRifCan.

### Batasan

- TikWM adalah API pihak ketiga tidak resmi dan bukan layanan resmi TikTok;
  CORS, rate limit, dan ketersediaan bisa berubah sewaktu-waktu.
- Statistik bisa berasal dari cache TikTok/TikWM dan tidak selalu real-time.
- Metadata mengikuti stream tertentu dari TikWM; stream lain dari video yang
  sama bisa berbeda.
- TikTok dapat menghapus metadata `artist`/`comment` setelah upload, sehingga
  deteksi resep bersifat best-effort dan bisa menampilkan `Tidak terdeteksi`.
- Postingan foto atau slideshow tidak didukung.
- Pengecekan maksimal membaca sekitar 4 MB; bila stream tidak bisa diprobe,
  statistik tetap ditampilkan tanpa detail metadata.

## Upload ke TikTok Studio

Upload **wajib lewat TikTok Studio di browser**, bukan aplikasi TikTok.
Aplikasi TikTok melakukan kompresi tambahan; TikTok Studio web tidak
menambahkan kompresi aplikasi itu. Tidak perlu ekstensi browser tambahan, dan
file hasil tetap MP4 biasa.

Setelah proses selesai, tombol **Upload lewat TikTok Studio** membuka halaman
upload TikTok Studio di tab baru. Unduh hasil lewat tombol **Unduh video**
terlebih dahulu, lalu seret atau pilih file hasil unduhan di tab TikTok Studio.
Browser tidak mengizinkan situs lain mengisi input file TikTok secara
programatis, jadi file tidak bisa dikirim langsung dari halaman ini. Tidak ada
file yang dikirim ke server KoRifCan.

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
- Metadata mdta: `artist` = `KoRifCan`, `comment` = `Best Quality`, `copyright`,
  `te_is_reencode`, `encoder`.
- Atom iTunes: `©ART`, `©cmt`, `©nam`, `©wrt`, `©alb`, `©grp`, `cprt`, `©too`.
  Semua atom branding bernilai `KoRifCan`; `©too` tetap berisi encoder.
  Tidak ada branding ADJN.

### Best Quality For iPhone

- Video: stream copy yang sama persis.
- Audio kompatibilitas: AAC-LC 44,1 kHz stereo 128 kbps, 7 frame tail.
- Audio HQ: AAC-LC 48 kHz stereo target 346 kbps, 19 frame tail.
- Track HQ memiliki clone; total tiga track audio.
- Movie timescale 384000; edit list kompatibilitas memakai media time 2112.
- Metadata mdta dan atom iTunes yang sama, dengan `comment` =
  `Best Quality For iPhone`.

`copyright` (mdta) berisi 32 karakter pertama SHA-256 file input sebagai
sidik jari. Semua atom iTunes branding, termasuk `cprt`, berisi `KoRifCan`.

## Struktur

```
index.html          Halaman utama (upload prep + cek/download TikTok)
404.html            Halaman error kustom (animasi, tanpa dependensi tambahan)
style.css           Desain dan layout
tiktok-stats.css    Gaya cek statistik di halaman utama
app.js              UI, alur proses, ffmpeg.wasm
tiktok-stats.js     Alur cek statistik, probe stream, dan download
patch-worker.js     Worker untuk container patcher
mp4-patcher.js      Implementasi patcher MP4
sw.js               Cache runtime untuk aset ffmpeg
ffmpeg/             ffmpeg.wasm 5.1.4 (core + loader)
fonts/              Font self-hosted + lisensi OFL
favicon.svg         Ikon situs
og-image.png        Kartu preview 1200×630 untuk media sosial
apple-touch-icon.png  Ikon home screen iOS
icon-192.png        Ikon manifest Android
icon-512.png        Ikon manifest Android
manifest.webmanifest  Metadata PWA ringan
robots.txt          Aturan crawler + lokasi sitemap
sitemap.xml         Sitemap halaman utama
```

## Tipografi

Situs memakai dua font variabel self-hosted, tanpa dependensi Google Fonts saat runtime:

- **Bricolage Grotesque** untuk heading dan wordmark — memberi karakter yang lebih hangat dan tidak kaku.
- **Plus Jakarta Sans** untuk body, tombol, dan UI — tetap modern dan mudah dibaca di layar kecil.

Keduanya berlisensi SIL Open Font License 1.1. Berkas lisensi ada di
`fonts/OFL-BricolageGrotesque.txt` dan `fonts/OFL-PlusJakartaSans.txt`.
Metadata teknis (nama file, codec, bitrate) tetap memakai font monospace sistem.

## SEO & berbagi

Halaman utama memakai URL absolut `https://korifcan.github.io/tiktok-hd/` untuk
canonical, `og:url`, `og:image`, dan sitemap. Metadata yang tersedia:

- Open Graph lengkap dengan kartu `og-image.png` 1200×630 untuk preview WhatsApp,
  Facebook, LinkedIn, dan Discord.
- Twitter Card `summary_large_image`.
- JSON-LD `WebSite`, `Person`, `SoftwareApplication`, dan `FAQPage`.
- `robots.txt`, `sitemap.xml`, `apple-touch-icon.png`, dan manifest ikon Android.

Karena situs ini adalah GitHub Pages project site di subpath `/tiktok-hd/`,
crawler hanya otomatis membaca `robots.txt` di root domain
(`https://korifcan.github.io/robots.txt`), bukan `robots.txt` di subpath ini.
Kirim `sitemap.xml` lewat Google Search Console, atau salin aturan yang sama ke
repo root domain jika ingin `robots.txt` berlaku otomatis.

Jika situs pindah domain, ganti URL absolut di `index.html`, `robots.txt`, dan
`sitemap.xml`, lalu buat ulang `og-image.png` karena footer kartu memuat URL situs.

## Halaman error

`404.html` menggantikan tampilan 404 default GitHub Pages. Halaman memakai token
warna, font, dan tombol dari `style.css`, ditambah visual pemutar video
"signal lost" dengan angka 404 glitch, timeline, scanline, dan animasi masuk.
Semua animasi dimatikan otomatis saat pengguna mengaktifkan
`prefers-reduced-motion`.

Halaman ini memakai `noindex,follow`, menampilkan rute yang diminta, dan
memakai path absolut `/tiktok-hd/` agar aset serta tautan tetap benar meskipun
URL yang hilang berada di kedalaman berbeda.

GitHub Pages hanya memakai `404.html` di root repo untuk status 404. Error lain
seperti 403, 500, dan 502 tetap halaman platform dan tidak bisa diganti dari
repo ini. Jika situs pindah ke domain sendiri, sesuaikan path `/tiktok-hd/` di
`404.html`.

## Menjalankan lokal

Karena memakai WebAssembly dan WebCrypto, jalankan lewat HTTP lokal (bukan `file://`):

```bash
python3 -m http.server 8080
# buka http://localhost:8080 (bagian Cek TikTok ada di #cek-tiktok)
```

Tidak ada build step dan tidak ada dependensi npm.

## Catatan

- TikTok tetap memproses ulang video saat upload. Resep ini membantu mempertahankan kualitas, bukan jaminan hasil identik.
- HDR/DV hanya dipertahankan dari sumber yang sudah HDR/DV. Sumber SDR tetap SDR; situs ini tidak melakukan konversi SDR→HDR dan tidak menambahkan label HDR palsu.
- Video wajib memiliki trek audio karena resep membangun ulang track audio.
- File besar membutuhkan RAM yang cukup; desktop lebih disarankan daripada ponsel.
- Mesin ffmpeg sekitar 31 MB dan di-cache service worker setelah kunjungan pertama.
- Aset lokal memakai query versi (`?v=...`) agar browser tidak memakai `app.js`/`style.css` lama dari cache. Naikkan versinya saat mengubah file tersebut.

## Lisensi

Kode situs ini dibuat untuk KoRifCan. ffmpeg.wasm mengikuti lisensi ffmpeg dan proyek asalnya. Font Bricolage Grotesque dan Plus Jakarta Sans memakai SIL Open Font License 1.1; teks lisensinya tersedia di folder `fonts/`.
