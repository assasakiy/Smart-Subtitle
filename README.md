# Smart Subtitle AI (YouTube Extension)

Ekstensi browser Chrome & Edge Manifest V3 untuk sinkronisasi subtitle YouTube cerdas bertenaga AI OpenAI-compatible dan mode Smart Natural Segmentation lokal.

## Fitur Utama

- **Smart Segmentation (Lokal Tanpa AI)**:
  - Menggabungkan fragmen auto-caption YouTube menjadi unit kalimat yang utuh dan nyaman dibaca.
  - Mempertimbangkan jeda alami pembicara, tanda baca kalimat, dan batas kecepatan baca (CPS).
- **AI Enhancement**:
  - Rekonstruksi kalimat, perbaikan ejaan, kapitalisasi, dan terjemahan multibahasa.
  - Pilihan OpenAI-compatible atau QVAC lokal sepenuhnya on-device.
  - QVAC memakai `loadModel()`, `transcribe()`, dan `completion()` dari `@qvac/sdk` 0.19.1.
  - Progressive batching: menonton langsung dapat dimulai begitu batch pertama selesai diproses.
- **Penyimpanan Lokal Permanen**:
  - Subtitle tersimpan di IndexedDB browser per video ID.
  - Begitu tersimpan, video dapat ditonton kapan saja tanpa perlu memanggil AI lagi.
- **Kustomisasi Tampilan Real-time**:
  - Widget samping mengambang (`⚙`/`✕`) di tepi kiri layar video YouTube (aman digunakan dalam mode Fullscreen).
  - Slider pengatur ukuran font, posisi vertikal, lebar maksimal kotak subtitle, dan jarak antar-baris (line height).
- **Dashboard Pengaturan & Manajemen Cache**:
  - Daftar lengkap cache video beserta judul dan tautan langsung ke video.
  - Hapus selektif dengan checkbox (bulk delete).
  - Cek rilis pembaruan otomatis dari GitHub Releases.

## Cara Pemasangan Ekstensi

1. Buka `chrome://extensions` (atau `edge://extensions` di Microsoft Edge).
2. Aktifkan **Developer mode** di pojok kanan atas.
3. Klik tombol **Load unpacked** (Muat yang belum dibongkar).
4. Pilih folder ini (`Smart-Subtitle`).

## QVAC Lokal: Transkripsi dan Terjemahan On-Device

Persyaratan Windows/Linux/macOS:

- Node.js `>=22.17`
- QVAC membutuhkan Vulkan `>=1.4` di Windows/Linux
- Ruang disk dan RAM cukup untuk Whisper Tiny dan Qwen3 600M

Instalasi:

1. Buka `chrome://extensions` di browser, aktifkan **Developer mode**, lalu salin **ID** ekstensi Smart Subtitle.
2. Jalankan pendaftaran Native Messaging:
   - **Windows**: Jalankan `updater/install.bat` dan masukkan ID ekstensi saat diminta, atau jalankan via terminal:
     ```cmd
     updater\install.bat MASUKKAN_EXTENSION_ID_DI_SINI
     ```
   - **Linux / macOS**:
     ```bash
     chmod +x updater/install.sh
     ./updater/install.sh MASUKKAN_EXTENSION_ID_DI_SINI
     ```
3. Buka Dashboard → **Koneksi & Model AI**.
4. Pilih **QVAC Lokal — on-device**.
5. Klik **Pasang QVAC SDK** bila dependency belum tersedia.
6. Klik **Unduh 2 Model Lokal**. Whisper Tiny dan Qwen3 600M diunduh sekali dan disimpan di folder `qvac-data/`.
7. Klik **Jalankan QVAC** untuk memuat model ke RAM.
8. Buka popup pada video YouTube dan pilih **Audio Video (QVAC Lokal)** atau **Subtitle YouTube (AI Enhancement)**. Subtitle diproses on-device tanpa endpoint eksternal.

Tombol **Hentikan** hanya melepas model dari RAM; model di disk tidak dihapus. Sebelum menghapus extension, gunakan bagian **Persiapan hapus extension** untuk memilih apakah model/dependency lokal ikut dihapus. Chrome tidak dapat menjalankan cleanup setelah extension sudah dihapus.

## Cara Mengaktifkan Auto-Updater Lokal (Opsional)

Jika ingin ekstensi dapat di-update secara otomatis langsung dari tombol dashboard:

- **Windows**:
  - Klik kanan pada `updater/install.bat` dan pilih **Run as administrator** (atau dobel klik).
- **Linux / macOS**:
  - Jalankan `./updater/install.sh` di terminal:
    ```bash
    chmod +x updater/install.sh
    ./updater/install.sh
    ```

---
Developed by **Assasakiy Media**
Repository: [https://github.com/assasakiy/Smart-Subtitle](https://github.com/assasakiy/Smart-Subtitle)
