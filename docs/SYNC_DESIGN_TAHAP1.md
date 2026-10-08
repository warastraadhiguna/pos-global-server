# Desain Kontrak Sync Cabang→Pusat — Tahap 1

**Branch:** `feature/sync-design`
**Tanggal:** 8 Oktober 2026
**Status:** DESAIN SAJA — tidak ada kode sync engine, tidak ada aplikasi pusat, tidak ada endpoint, tidak ada perubahan skema. DB produksi Semarang tidak disentuh.

Lanjutan dari [`BRANCH_IDENTITY_AUDIT.md`](BRANCH_IDENTITY_AUDIT.md) (pemetaan `sync_status`/`branch_id`) dan fitur `branch_code` yang sudah dibangun. Keputusan arsitektur yang sudah dikunci (dari instruksi): DB pusat satu set tabel gabungan dibedakan `branch_code`, sync berkala satu-arah cabang→pusat, pusat read-only, HTTPS + token rahasia per cabang + cabang yang PUSH (bukan pusat yang narik), konsolidasi awal = per-cabang + total nilai (omzet, jumlah transaksi) saja — bukan per-produk.

---

## Ringkasan

Untuk kebutuhan "omzet + jumlah transaksi per cabang" yang dikunci sebagai target Tahap 1, **tabel yang benar-benar perlu disync hanya `sales`**. Tidak ada `sale_items`, tidak ada produk, tidak ada COA. Ini sengaja seminimal mungkin — tabel lain (purchases, journal_entries, dll) memenuhi pola yang sama persis kalau/ketika dibutuhkan nanti, tapi menambahkannya sekarang berarti membangun untuk kebutuhan yang belum dikonfirmasi.

**Temuan penting yang mengubah keputusan**: ditemukan saat menyiapkan laporan ini (belum diperbaiki, murni dicatat) — `sync_status` di seluruh sistem **ditulis sekali saat INSERT, tidak pernah di-reset saat UPDATE**. Contoh konkret: `VoidService.js` meng-UPDATE `sales.status` jadi `'voided'` tanpa menyentuh `sync_status` sama sekali. Kalau sebuah nota sudah ter-sync ke pusat saat masih `'completed'`, lalu di-void BELAKANGAN, pusat tidak akan pernah tahu nota itu sudah dibatalkan — kecuali ada mekanisme yang me-reset `sync_status` kembali ke `'local_only'` saat UPDATE semacam ini terjadi. Ini BUKAN sesuatu yang saya perbaiki di laporan ini (sesuai arahan, murni desain), tapi ini keputusan yang WAJIB diambil sebelum Tahap 2 — didaftarkan di Bagian 5.

---

## 1. Daftar tabel yang disync (Tahap 1)

### Disync: `sales` SAJA

Semua kolom kecuali FK yang murni lokal (`cashier_shift_id`, `voided_by` — UUID yang tidak bermakna di pusat tanpa konteks lokal) ditambah 1 field snapshot BARU yang tidak ada di kolom tabel, dibentuk saat payload disusun:

| Field payload | Sumber |
|---|---|
| `id` | `sales.id` (UUID asli, dipakai APA ADANYA sebagai PK di pusat juga — lihat Bagian 2) |
| `saleNumber` | `sales.sale_number` |
| `cashierName` | **BARU** — teks, diisi dari `JOIN users ON sales.user_id` SAAT payload dibentuk, bukan field DB. Lihat Bagian 1.1 |
| `customerName` | `sales.customer_name` |
| `subtotal`, `discountTotal`, `dpp`, `ppnRate`, `ppnMode`, `ppnAmount`, `grandTotal`, `totalCost`, `grossProfit` | apa adanya dari `sales` |
| `status`, `voidReason`, `voidedAt` | apa adanya — **baris voided TETAP disync**, tidak difilter, supaya pusat bisa hitung omzet bersih (`status='completed'`) maupun lihat aktivitas void kalau perlu, bukan cuma dapat angka gross yang menyesatkan |
| `createdAt` | `sales.created_at` |

**Kenapa cuma `sales`, bukan `sale_items`/`sale_payments` juga**: target Tahap 1 adalah omzet (= `SUM(grand_total)` di baris `status='completed'`) dan jumlah transaksi (= `COUNT(*)` baris `sales`). Keduanya cukup dari header saja. Breakdown per metode pembayaran atau per produk eksplisit DI LUAR scope yang dikunci ("BUKAN penggabungan per-produk dulu") — kalau nanti dibutuhkan, `sale_items`/`sale_payments` tinggal ditambah ke daftar sync pakai mekanisme SAMA PERSIS yang dirancang di sini, bukan desain baru.

**Tidak disync Tahap 1** (meski sudah punya `sync_status`, berdasarkan audit sebelumnya): `stock_movements`, `stock_adjustments`, `cashier_shifts`, `cash_movements`, `purchases`+items+payments, `stock_opnames`+items, `purchase_returns`+items, `sale_returns`/`sale_return_items`* (placeholder lama, sudah dihapus — lihat `sales_returns`/`sales_return_items` yang sungguhan, BELUM punya `sync_status` sama sekali, lihat catatan di `BRANCH_IDENTITY_AUDIT.md` 1.3), `activity_logs`, `journal_entries`+lines, `fixed_assets`. Semuanya kandidat alami untuk tahap konsolidasi berikutnya (laba rugi penuh per cabang, misalnya, butuh `journal_entries`), tidak didesain sekarang karena belum jadi kebutuhan yang dikunci.

### 1.1 Nama kasir — teks di payload, bukan replikasi `users`

Sesuai arahan eksplisit (`users` tidak pernah disync — kredensial, `password_hash`, `pin_hash`, `totp_secret` tidak boleh keluar toko sama sekali, dan secara desain `users` memang tidak punya `sync_status`, konsisten dengan niat itu).

Pendekatan: sync engine (Tahap 2, belum dibangun) saat menyusun payload melakukan `SELECT s.*, u.full_name AS cashier_name FROM sales s JOIN users u ON u.id = s.user_id WHERE s.sync_status = 'local_only'` — `cashier_name` jadi TEKS APA ADANYA di payload, persis pola yang SUDAH ada di skema untuk kasus serupa: `sale_payments.payment_method_name` adalah snapshot nama metode pembayaran saat transaksi (supaya struk/laporan lama tetap benar walau metode itu di-rename/dinonaktifkan belakangan) — `cashierName` di payload sync memakai prinsip snapshot yang SAMA, cuma levelnya "snapshot keluar dari cabang", bukan "snapshot ke kolom lokal".

Konsekuensi: pusat TIDAK PERNAH tahu `user_id` asli (tidak perlu, tidak diminta), cuma nama kasir sebagai teks bebas pada waktu itu. Kalau kasir ganti nama belakangan, laporan pusat untuk transaksi LAMA tetap menunjukkan nama SAAT transaksi terjadi — konsisten dengan prinsip snapshot HPP (Bagian 5 blueprint awal) yang sudah dipegang di seluruh sistem.

---

## 2. Bentuk payload & idempotency

### Struktur satu kiriman (satu kali sync berkala)

```
POST https://<host-pusat>/api/sync/batch
Authorization: Bearer <token-rahasia-per-cabang>
Content-Type: application/json

{
  "batchId": "<uuid, baru tiap PERCOBAAN kirim — lihat catatan retry>",
  "generatedAt": "2026-10-08T07:00:00.000Z",
  "sales": [
    {
      "id": "7c2e...-uuid-asli-dari-branch",
      "saleNumber": "INV-20261008-0001",
      "cashierName": "Kasir Contoh",
      "customerName": null,
      "subtotal": 150000,
      "discountTotal": 0,
      "dpp": 150000,
      "ppnRate": 11,
      "ppnMode": "exclude",
      "ppnAmount": 16500,
      "grandTotal": 166500,
      "totalCost": 90000,
      "grossProfit": 60000,
      "status": "completed",
      "voidReason": null,
      "voidedAt": null,
      "createdAt": "2026-10-08T06:45:12.000Z"
    }
  ]
}
```

Catatan desain:
- **`branchCode` TIDAK perlu ikut di body payload.** Token rahasia per cabang (Authorization header) sudah secara unik mengidentifikasi cabang mana yang mengirim — pusat me-resolve `branchCode` dari TOKEN (pemetaan token→branch_code tersimpan di pusat), bukan mempercayai klaim apa pun di body. Kalau body tetap menyertakan `branchCode` untuk kemudahan baca log, pusat WAJIB mengabaikannya dan selalu pakai hasil resolve dari token — mencegah cabang yang token-nya bocor/salah-konfigurasi menyamar sebagai cabang lain. (Defense in depth — baris ini murni prinsip keamanan yang dikunci di desain, implementasinya Tahap 2.)
- **`id` (UUID asli) dipakai APA ADANYA sebagai primary key di tabel pusat juga** — bukan di-generate ulang. Karena UUID v4 practically collision-free secara global (dirancang begitu sejak hari 1, lihat prinsip desain blueprint), satu baris `sales` dari cabang mana pun di dunia nyaris pasti punya `id` yang tidak akan pernah sama dengan baris cabang lain. Ini KUNCI idempotency: tabel pusat melakukan **UPSERT** (`INSERT ... ON DUPLICATE KEY UPDATE` di MySQL) berdasarkan `id`, bukan `INSERT` polos.
- **Retry yang aman secara desain**: kalau koneksi putus di tengah pengiriman (cabang tidak tahu apakah pusat sempat menerima atau tidak), cabang CUKUP kirim ulang batch (baris-baris) yang sama di percobaan sync berikutnya. Karena UPSERT bersifat idempotent — menerima baris dengan `id` yang SAMA dan isi yang SAMA dua kali hasilnya identik dengan menerima sekali — tidak ada risiko dobel hitung di pusat, walau ada pengiriman ganda. `batchId` baru per PERCOBAAN kirim (bukan per isi) murni untuk korelasi log/debug di kedua sisi ("percobaan kirim mana yang gagal jam berapa"), BUKAN mekanisme dedup — dedup sesungguhnya ada di `id` tiap baris, bukan di `batchId`.
- **Transaksi tunggal di pusat**: satu batch diproses dalam SATU transaksi DB di pusat — semua baris masuk atau tidak sama sekali. Ini sengaja menghindari kompleksitas "sukses sebagian" (respons per-baris, status campuran) yang belum ada gunanya pada skala toko kecil — kalau nanti volume per batch jadi sangat besar dan perlu commit sebagian demi performa, itu optimisasi Tahap selanjutnya, bukan kebutuhan sekarang.

### Respons

```json
{ "accepted": true, "batchId": "...", "counts": { "sales": 1 } }
```
Respons sukses = sinyal BAGI CABANG untuk menandai baris-baris yang BARU SAJA dikirim itu `sync_status = 'synced'`. Tidak ada respons (timeout/gagal koneksi) atau respons gagal (4xx/5xx) = cabang TIDAK mengubah apa pun, baris tetap `'local_only'`, dicoba lagi di jadwal sync berikutnya — lihat Bagian 3.

---

## 3. Alur status `sync_status`

```
'local_only'  --[baris disertakan di batch yang dikirim]-->  (menunggu respons)
                                                                  |
                                       [respons 2xx accepted:true]   [gagal/timeout/tidak ada respons]
                                                  |                              |
                                                  v                              v
                                            'synced'                    tetap 'local_only'
                                                                     (dicoba lagi batch berikutnya)
```

- **Sukses**: begitu cabang menerima respons `accepted: true`, jalankan `UPDATE sales SET sync_status = 'synced' WHERE id IN (<id-id yang baru dikirim>)` — SATU update, bukan per-baris, dan HANYA untuk id yang benar-benar ada di batch yang baru direspons (bukan "semua yang local_only saat ini", untuk hindari race kalau ada baris baru masuk tepat di antara kirim & update).
- **Gagal (jaringan putus, timeout, 5xx dari pusat, dst)**: TIDAK ADA perubahan status di cabang. Baris tetap `'local_only'`, otomatis ikut batch BERIKUTNYA di jadwal sync selanjutnya. Karena UPSERT di pusat idempotent (Bagian 2), mengirim ulang baris yang SEBENARNYA sudah berhasil diterima pusat (tapi responsnya yang hilang di jalan) tetap aman — tidak pernah dobel hitung.
- **Pusat menolak tegas (4xx, mis. token salah/kedaluwarsa)**: beda dari "gagal sementara" — ini perlu di-log sbg error yang perlu perhatian admin (token salah bukan masalah yang akan sembuh sendiri dengan dicoba lagi), tapi tetap TIDAK mengubah `sync_status` (prinsip sama: jangan tandai synced kalau tidak terbukti diterima).
- **TIDAK perlu status transisi tambahan** (mis. `'sending'`/`'pending_ack'`) selama sync engine jalan sebagai SATU proses terjadwal tunggal per cabang (bukan paralel) — tidak ada skenario dua proses sync berebut baris yang sama di satu cabang. Kalau nanti arsitekturnya berubah jadi multi-proses/paralel per cabang (sangat tidak mungkin untuk skala 1 server per toko), baru perlu status transisi buat mencegah baris yang sama diproses dua proses sekaligus — SENGAJA tidak dibangun sekarang (YAGNI, konsisten dengan keputusan "jangan paksa urutan tutup buku" sebelumnya — jangan bangun pengaman untuk masalah yang belum ada).

---

## 4. Master data (produk, COA, dll) — TIDAK disync di Tahap 1

Karena tabel yang disync cuma `sales` (header), dan `sales` TIDAK punya FK langsung ke tabel master selain `user_id` (sudah diselesaikan lewat snapshot nama di Bagian 1.1), **tidak ada kebutuhan sync master data SAMA SEKALI di Tahap 1** — bukan "disederhanakan", tapi literal tidak ada yang perlu disalin, karena scope metriknya (omzet + jumlah transaksi) tidak menyentuh level produk/akun.

Ini otomatis menjawab celah yang diangkat di audit sebelumnya (produk/COA tidak punya `sync_status`, UUID beda tiap instalasi) — celah itu TETAP ADA, tapi tidak relevan untuk Tahap 1 karena tidak ada tabel Tahap 1 yang butuh resolve identitas produk/akun lintas cabang. Kalau Tahap 2+ menambah `sale_items` (utk breakdown per produk, eksplisit di luar scope sekarang), pola yang sama dengan `cashierName` berlaku: payload bawa `productName` sebagai teks (JOIN ke `products` saat payload dibentuk), BUKAN sync tabel `products` utuh — kecuali nanti memang eksplisit dibutuhkan agregasi "total terjual produk X di semua cabang" yang presisi (butuh identitas produk yang disamakan lintas cabang, misalnya lewat `sku` sebagai kunci, bukan `product_id` UUID yang beda per cabang) — itu keputusan terpisah untuk saat kebutuhannya benar-benar muncul, BUKAN dirancang sekarang.

---

## 5. Yang BELUM diputuskan — perlu keputusan Anda sebelum Tahap 2

1. **Celah `sync_status` tidak ter-reset saat UPDATE (temuan Ringkasan di atas)** — ini PALING PENTING karena menyangkut korektnes, bukan preferensi. `VoidService.js` (dan kemungkinan jalur UPDATE lain ke tabel ber-`sync_status`) mengubah data tanpa mengembalikan `sync_status` ke `'local_only'`. Perlu diputuskan: apakah SETIAP UPDATE ke baris yang relevan-sync (void, dll) wajib menyertakan `sync_status = 'local_only'` di query UPDATE-nya (perbaikan tersebar, menyentuh beberapa service), atau ada pendekatan lain yang Anda mau pertimbangkan? Ini murni ditemukan & dilaporkan di sini, TIDAK diperbaiki (sesuai arahan Tahap 1).
2. **Apakah `sales` voided yang baru dibatalkan SETELAH sync perlu di-push ULANG ke pusat** — ini konsekuensi langsung dari poin 1. Kalau jawabannya "ya" (pusat harus tahu status void), maka solusi poin 1 wajib diambil. Kalau jawabannya "untuk Tahap 1 belum perlu, omzet gross vs net belum jadi concern" — poin 1 bisa ditunda, tapi perlu KEPUTUSAN EKSPLISIT, bukan default diam-diam.
3. **Scope tabel**: apakah "total nilai" yang dimaksud BENAR-BENAR cuma omzet penjualan (sesuai saya asumsikan & desain di atas), atau sebenarnya juga mencakup total beban/laba bersih per cabang (yang berarti `journal_entries` perlu masuk Tahap 1 juga, bukan ditunda)? Kalau yang kedua, daftar tabel di Bagian 1 perlu diperluas sebelum Tahap 2 mulai dibangun.
4. **Interval sync & lokasi konfigurasinya** — "berkala, interval bisa diatur" dikunci, tapi belum diputuskan: diatur di mana (env var `SYNC_INTERVAL_MINUTES` ala pola `config/db.js` yang sudah ada? Atau tabel DB biar bisa diubah admin lewat UI tanpa restart server, mirip `backup_settings.schedule_time`)? Dan siapa yang MEMICU — proses terjadwal internal server cabang (mirip `BackupScheduler.js` yang sudah ada polanya), atau cron OS terpisah?
5. **Provisioning token rahasia per cabang** — bagaimana token dibuat & didistribusikan pertama kali ke tiap instalasi cabang (manual oleh Anda per cabang baru? Digenerate otomatis saat instalasi lalu didaftarkan manual ke pusat?), dan mekanisme revoke/rotate kalau suatu saat token bocor.
6. **Bentuk tabel di pusat** — usulan saya (default, menunggu konfirmasi): kolom di pusat = salinan field payload apa adanya + `branch_code` (dari resolve token, BUKAN dari body) + `received_at`. Simpel, tidak ada transformasi/ETL di Tahap 1. Apakah ini cukup, atau Anda mau pusat punya skema laporan yang sudah pre-agregat (mis. tabel ringkasan harian per cabang) sejak awal?
7. **Kebijakan retry** — berapa kali/berapa lama dicoba ulang sebelum dianggap "gagal, perlu perhatian admin" dan bagaimana admin diberi tahu (notifikasi di pos-admin? Log file saja)? Bukan keputusan arsitektur besar, tapi perlu nilai konkret sebelum implementasi Tahap 2.

---

## Yang SENGAJA tidak dikerjakan di Tahap 1 (sesuai arahan)

Tidak ada sync engine, tidak ada endpoint `/api/sync/batch` sungguhan, tidak ada aplikasi pusat, tidak ada perubahan skema (termasuk TIDAK menambah `sync_status` ke `sales_returns`/`sales_return_items` meski itu relevan — itu perbaikan Tahap 2, bukan desain). Dokumen ini murni kontrak yang disepakati dulu sebelum satu baris kode pun ditulis.
