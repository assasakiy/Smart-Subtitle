# Smart Subtitle AI (YouTube Extension)

Ekstensi browser Chrome & Edge Manifest V3 untuk sinkronisasi subtitle YouTube cerdas bertenaga AI OpenAI-compatible dan mode Smart Natural Segmentation lokal.

## Fitur Utama

- **Smart Segmentation (Lokal Tanpa AI)**:
  - Menggabungkan fragmen auto-caption YouTube menjadi unit kalimat yang utuh dan nyaman dibaca.
  - Mempertimbangkan jeda alami pembicara, tanda baca kalimat, dan batas kecepatan baca (CPS).
- **AI Enhancement**:
  - Rekonstruksi kalimat, perbaikan ejaan, kapitalisasi, dan terjemahan multibahasa.
  - Menggunakan API endpoint OpenAI-compatible (Groq, OpenAI, Gemini, Ollama, LM Studio, dll).
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
