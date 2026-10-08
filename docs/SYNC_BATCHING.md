# Sync Batching — untuk backlog besar (Semarang, berbulan-bulan belum sync)

**Tanggal:** 9 Oktober 2026
**Status:** Selesai & teruji (lokal, bukan Semarang produksi — lihat Bagian uji beban).

Masalah: scheduler sync (lihat `server/docs/SYNC_DESIGN_TAHAP1.md`) sebelumnya mengirim
SEMUA baris `sync_status='local_only'` dalam satu payload sekaligus. Untuk cabang baru
(`TEST`) yang cuma punya segelintir baris, ini tidak pernah ketahuan masalahnya. Semarang
sudah jalan berbulan-bulan dengan sync mati — begitu diaktifkan, baris `local_only`-nya bisa
ribuan sekaligus. Satu payload sebesar itu berisiko: timeout, body terlalu besar, membebani
komputer toko, dan kalau gagal di tengah — SEMUA harus diulang dari awal (tidak ada progres
yang tersimpan).

## Pendekatan: satu batch per tick scheduler (bukan drain sampai habis dalam satu tick)

Dua opsi dipertimbangkan:

**A. Loop multi-batch dalam satu tick** — begitu scheduler terpicu, kirim batch 1, kalau
sukses lanjut batch 2, dst, sampai backlog BENAR-BENAR habis, baru berhenti sampai transaksi
baru menumpuk lagi.

**B. Satu batch per tick** — satu kali scheduler terpicu = satu kali kirim (maks `batch_size`
baris), lalu berhenti sampai `interval_minutes` berikutnya, berapa pun sisa backlog-nya.

**Dipilih: B.** Alasan:
- Durasi & beban satu tick jadi **selalu sama, bisa diprediksi**, berapa pun besar backlog-nya
  — 10 baris atau 10.000 baris local_only sama-sama cuma satu round-trip HTTP terbatas
  (`batch_size`). Tidak ada skenario satu tick tiba-tiba jalan bermenit-menit karena backlog
  besar, yang justru paling berisiko membebani komputer toko — persis hal yang ingin dihindari.
- Mengosongkan backlog besar (skenario Semarang persis) dikendalikan lewat
  `sync_settings.interval_minutes` yang **sudah ada** & admin-configurable — turunkan
  sementara (mis. 1 menit) untuk mempercepat pengurasan awal, naikkan lagi ke nilai normal
  (mis. 15 menit) setelah caught up. Operator (admin) yang mengendalikan kecepatan vs beban
  secara eksplisit & dapat diamati, bukan logic otomatis yang menebak "aman tidaknya" kirim
  lebih cepat.
- Opsi A menambah kerumitan nyata untuk manfaat yang sudah bisa dicapai lewat tuas yang ada:
  kapan berhenti dalam satu tick, bagaimana kegagalan DI TENGAH loop multi-batch dilaporkan
  (gagal di batch ke-5 dari rencana 10 — apakah tick ini "gagal" atau "sebagian berhasil"?),
  dan potensi tick yang berdurasi tidak terduga.

## Perubahan konkret

- `sync_settings.batch_size` (kolom baru, migrasi `add-sync-batch-size.js`, default 200,
  admin-configurable 1-2000) — maks baris **PER TABEL** (`sales` dan `sales_returns`
  masing-masing, bukan gabungan) yang dikirim dalam satu batch.
- `SyncService.runSync()` — `LIMIT` query baca `batch_size` dari `sync_settings` (bukan
  hardcode `500` seperti sebelumnya). Satu pemanggilan = satu batch, seperti sebelumnya —
  cuma limitnya sekarang configurable, bukan logic baru.
- `SyncScheduler.js` — tambah penjaga tumpang-tindih (`isRunning`). Relevan SEKARANG karena
  dengan backlog besar, sync `enabled` akan lebih sering berada dalam kondisi "masih ada sisa,
  bakal tick lagi segera" — tanpa penjaga ini, kalau satu batch kebetulan lebih lambat dari
  `interval_minutes`, tick berikutnya bisa mulai `runSync()` kedua sebelum yang pertama
  selesai (karena `last_run_at` baru ter-update SETELAH selesai).
- Urutan kirim **tetap** `ORDER BY created_at ASC` (sudah ada sejak awal, tidak berubah) —
  backlog terkuras dari yang TERLAMA dulu, jadi kalau terputus di tengah, rentang yang sudah
  sampai di pusat kontinu (bukan acak), lebih mudah dipantau owner.
- `pos-pusat`: `express.json()` limit dinaikkan dari default 100kb ke 15mb — cukup lega untuk
  `batch_size` maksimum (2000×2 tabel) dengan headroom besar, tapi tetap terbatas (bukan
  unlimited).

## Uji beban (lokal, DB dummy — bukan Semarang)

Dataset: **5000 sales** (4500 `completed`, 500 `voided`) + **265 sales_returns**, tersebar
kronologis dari 1 Juli 2026 (tiap baris +15 menit). Gross (completed) = 607.500.000, total
retur = 7.135.000 → **net omzet diharapkan = 600.365.000**.

| Uji | Hasil |
|---|---|
| Semua sampai, batch_size=200 ditegakkan | **25 batch**, tiap batch ≤200 baris sales & ≤200 baris returns (dicek eksplisit, tidak pernah lebih) |
| Total waktu (lokal) | 13,4 detik utk 5265 baris — bukan patokan kecepatan internet sungguhan, tapi membuktikan mekanismenya ringan |
| Omzet bersih di pusat setelah selesai | **600.365.000** — cocok PERSIS dgn yang diharapkan |
| Jumlah baris di pusat | 5000 sales (4500 completed, 500 voided), 265 returns — semua cocok, tidak ada yang hilang |
| **Urutan pengiriman** (kirim yang lama dulu) | 200 baris PERTAMA yang diterima pusat = PERSIS 200 transaksi terlama (`BATCH-S-00000`..`00199`). 200 baris TERAKHIR = PERSIS 200 transaksi terbaru. Dibuktikan via `received_at`, bukan diasumsikan dari kode. |
| **Gagal di tengah** — 8 batch sukses (1600 baris `synced`), penerima DIMATIKAN SUNGGUHAN (`taskkill` proses pos-pusat, bukan simulasi), 3 percobaan batch berikutnya | Ketiganya gagal bersih (`fetch failed`). Status sesudahnya: **tetap 1600 synced, 3400 local_only** — tidak regresi, tidak ada yang ter-tandai synced secara keliru. |
| **Lanjut setelah penerima hidup lagi** | Dijalankan 20 batch lagi — otomatis melanjutkan dari sisa 3400 (BUKAN mengulang 1600 yang sudah sukses), selesai total di **5000 synced, 0 local_only** dalam 17 batch tambahan (1600 + 17×200 = pas 5000). |
| Verifikasi akhir di pusat pasca-interupsi | 5000 sales, 265 returns, net omzet 600.365.000 — identik dgn hasil uji tanpa interupsi. Tidak ada duplikasi meski sempat terputus. |

Semua database uji & proses pos-pusat test dihentikan/dihapus setelah verifikasi. Server
cabang Semarang & `sync_settings`-nya tidak disentuh sama sekali sepanjang proses ini.
