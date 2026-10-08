# Audit: Jalur yang Mengubah Data Ber-`sync_status` Setelah INSERT

**Branch:** `feature/sync-design`
**Tanggal:** 8 Oktober 2026
**Status:** ANALISIS SAJA — tidak ada kode diubah, tidak ada migrasi dijalankan, DB produksi tidak disentuh.

Lanjutan dari [`SYNC_DESIGN_TAHAP1.md`](SYNC_DESIGN_TAHAP1.md), yang menemukan bahwa `VoidService.js` meng-UPDATE `sales.status` tanpa mereset `sync_status`. Laporan ini menyisir SEMUA jalur serupa (bukan cuma `sales`), mengusulkan di mana reset perlu terjadi, membandingkan mekanisme (manual vs terpusat) dengan trade-off, dan menjawab pertanyaan spesifik soal pola reversal akuntansi serta `sales_returns`.

---

## 1. Daftar lengkap: semua UPDATE ke tabel yang ber-`sync_status` (atau kandidat sync berikutnya)

Disisir dengan grep menyeluruh ke semua `src/services/*.js` untuk `UPDATE <nama_tabel>` pada setiap tabel yang terdaftar punya `sync_status` di audit sebelumnya, plus tabel kandidat sync Tahap berikutnya.

| # | Tabel | Lokasi | Apa yang berubah | Sync Tahap 1? | Gap sync_status? |
|---|---|---|---|---|---|
| 1 | `sales` | `VoidService.js:57` | `status`→`'voided'`, `void_reason`, `voided_at`, `voided_by` | **YA** (satu-satunya tabel Tahap 1) | **YA — dikonfirmasi** |
| 2 | `purchases` | `PurchaseService.js:679` | `status`→`'voided'`, `void_reason`, `voided_at`, `voided_by` | Tidak (Tahap berikutnya) | **YA** — pola identik #1 |
| 3 | `journal_entries` | `AccountingService.js:205` (dipanggil dari `reverseJournalEntry`) | `status`→`'reversed'` (entri ASLI; entri pembalik adalah baris BARU, bukan UPDATE — lihat Bagian 3) | Tidak | **YA, tapi beda sifat — lihat Bagian 3** |
| 4 | `internal_stock_usages` | `InternalStockUsageService.js:260` | `status`→`'voided'`, `void_reason`, `voided_at`, `voided_by` | Tidak | **YA** — pola identik #1 |
| 5 | `stock_opnames` | `StockOpnameService.js:320` | `status`: `'in_progress'`→`'finalized'`, `finalized_by`, `finalized_at` | Tidak | **YA** — kalau sempat ter-sync saat masih `in_progress` |
| 6 | `stock_opname_items` | `StockOpnameService.js:169,223,281` | `physical_qty_base`, `variance_qty_base`, dll (proses hitung fisik) | Tidak (tabel ini child, tidak py `sync_status` sendiri) | Tidak langsung — tapi lihat catatan di Bagian 2 soal "unit sync" |
| 7 | `cashier_shifts` | `ShiftService.js:102-107` | `status`: `'open'`→`'closed'`, `closing_cash_expected/actual`, `cash_difference`, `closed_at` | Tidak | **YA** — pola identik #1 |
| 8 | `suppliers` | `SupplierService.js:45` | `name`, `contact_person`, `phone`, `address`, `is_active` (edit biasa, bukan void) | Tidak | **YA** — beda dari pola void, tapi gap yang sama: edit setelah sync tidak ter-propagate |

### Dikonfirmasi BUKAN gap (sudah dicek eksplisit, tidak ada jalur UPDATE sama sekali)

- **`fixed_assets`** — create-only. Tidak ada route/service yang meng-UPDATE baris ini sama sekali (bahkan tidak ada endpoint edit/nonaktifkan). Depresiasi bulanan membuat baris BARU di `fixed_asset_depreciation_entries` + `journal_entries`, tidak pernah menyentuh baris `fixed_assets` itu sendiri.
- **`purchase_returns`/`purchase_return_items`** — create-only, belum ada fitur void/edit sama sekali (konsisten dengan temuan sesi sebelumnya).
- **`sales_returns`/`sales_return_items`** — create-only juga (dicek: `SalesReturnService.js` cuma `SELECT ... FOR UPDATE` sbg row lock ke `sales`/`sale_items`, tidak pernah meng-UPDATE-nya). Lihat Bagian 4 soal tabel ini sendiri belum py `sync_status`.
- **Semua tabel child/ledger append-only** (`sale_items`, `sale_payments`, `purchase_items`, `purchase_payments`, `journal_entry_lines`, `stock_movements`, `cash_movements`, `activity_logs`, `stock_adjustments`) — tidak ada jalur UPDATE sama sekali, sesuai prinsip desain "ledger, bukan diedit".

---

## 2. Di mana reset perlu terjadi — dan dua pertanyaan di baliknya

Untuk tabel #1, #2, #4, #7, #8 di atas, pola gap-nya identik: UPDATE mengubah data bisnis TANPA mengembalikan `sync_status` ke `'local_only'`. Perbaikan mekanisnya sendiri sederhana (tambah `sync_status = 'local_only'` ke tiap SET clause) — yang jadi pertanyaan desain adalah BAGAIMANA memastikan pola ini konsisten diikuti, sekarang DAN di masa depan.

### Untuk #5 (`stock_opnames`), satu nuansa tambahan

Kalau `stock_opnames` nanti masuk scope sync, unit yang masuk akal untuk disync adalah DOKUMEN YANG SUDAH FINAL (`status='finalized'`) — opname yang masih `in_progress` belum ada nilainya untuk laporan pusat (variance belum final). Jadi "kapan baris ini boleh sync_status jadi local_only (siap dikirim)" sebenarnya BUKAN saat INSERT (seperti tabel lain), tapi saat FINALISASI. Ini pola yang sedikit berbeda dari "reset setelah berubah" — lebih ke "baru LAYAK sync setelah event tertentu, bukan sejak lahir". Dicatat di sini supaya tidak disamaratakan begitu saja dengan pola void ketika tabel ini digarap nanti.

---

## 3. Pola Reversal Akuntansi — interaksinya dengan sync (pertanyaan spesifik Anda)

`AccountingService.reverseJournalEntry` melakukan DUA hal sekaligus:
1. **UPDATE** entri ASLI: `status` → `'reversed'` (ini masuk daftar gap #3 di atas).
2. **INSERT** entri BARU (entri pembalik, `reversed_entry_id` menunjuk balik ke entri asli, debit/kredit dibalik). Baris baru ini otomatis `sync_status='local_only'` default — AKAN ikut sync normal tanpa perlu perbaikan apa pun, karena memang baris baru.

**Jawaban atas "apakah pusat perlu tahu keduanya, atau cukup status berubah"** — tergantung level kebutuhan, dan BEDA dari kasus void `sales`:

- **Untuk KETEPATAN ANGKA (total nilai/laba rugi)**: pusat TIDAK PERLU tahu entri asli berubah status. Kalau KEDUA baris (asli + pembalik) ter-sync — baris pembalik PASTI ter-sync karena dia baris baru — debit/kreditnya SALING MENIADAKAN saat dijumlah di pusat, PERSIS seperti cara laporan LOKAL sudah bekerja sekarang (tidak ada filter `status='posted'` di `AccountingReportService.js` — total yang benar justru muncul KARENA kedua entri dijumlahkan bersama). Jadi secara ARITMATIKA, status asli yang "basi" (tetap kebaca `'posted'` di pusat walau sebenarnya sudah `'reversed'`) TIDAK merusak angka total.
- **Untuk KETEPATAN TAMPILAN/AUDIT** (mis. admin pusat buka buku besar per entri dan ingin lihat mana yang sudah dibatalkan): status asli yang basi AKAN menyesatkan di tampilan itu — entri yang sebenarnya sudah dibatalkan tetap kelihatan `'posted'`.

**Beda sifat dari gap `sales.status` (void)**: kalau `sales` yang sudah di-void tidak ter-reset syncnya, pusat salah hitung OMZET (angka gross vs net jadi salah — ini korup SECARA ARITMATIKA, bukan cuma tampilan, karena tidak ada "baris pembalik" terpisah untuk sales — statusnya LANGSUNG diubah di baris yang sama, tidak seperti jurnal yang selalu bikin baris baru). Ini alasan kenapa saya pisahkan kolom "Gap sync_status?" jadi catatan khusus di tabel #3 — levelnya beda dari #1/#2/#4/#7/#8.

**Implikasi**: kalau/ketika `journal_entries` masuk scope sync, perbaikan gap #3 bisa jadi PRIORITAS LEBIH RENDAH dibanding gap #1/#2/#4 (yang korup angka), TAPI tetap perlu diputuskan apakah laporan pusat level lanjutan butuh tampilan per-entri yang akurat atau cukup total yang sudah benar.

---

## 4. `sales_returns` — perlu sync_status Tahap 1?

Dua hal terpisah yang perlu dipisahkan jelas:

**(a) Apakah `sales_returns` perlu masuk SCOPE sync Tahap 1 (selain `sales`)?**
Ini pertanyaan SCOPE, bukan pertanyaan "gap". Karena retur penjualan TIDAK PERNAH mengubah baris `sales` asli (dikonfirmasi di Bagian 1 — murni dokumen berdiri sendiri, `sales.grand_total` tetap apa adanya meski sudah ada retur), kalau Tahap 1 cuma sync `sales`, maka **omzet di pusat akan GROSS (sebelum retur), bukan bersih**. Kalau itu belum masalah untuk level "per-cabang + total nilai" awal — biarkan saja, `sales_returns` menyusul Tahap berikutnya bersama tabel lain. Kalau "total nilai" dimaksud harus sudah bersih dari retur sejak awal, `sales_returns` perlu ikut masuk SEKARANG. Ini sebenarnya perpanjangan dari pertanyaan #3 yang sudah saya daftarkan di laporan sebelumnya ("apakah total nilai cuma omzet kotor atau sudah termasuk pengurang") — belum ada jawaban eksplisit, jadi saya angkat lagi di sini secara konkret.

**(b) Kalau YA masuk scope — apa yang perlu disiapkan?**
- Perlu migrasi `ALTER TABLE sales_returns ADD COLUMN sync_status ...` dan `sales_return_items` juga (pola idempotent SAMA PERSIS seperti migrasi-migrasi sebelumnya — `add-branch-code.js` dkk — AMAN dijalankan di Semarang live, tidak menyentuh data existing).
- **Kabar baiknya**: karena `sales_returns` TERKONFIRMASI create-only (tidak ada jalur UPDATE sama sekali, Bagian 1), begitu kolom `sync_status` ditambah, TIDAK ADA gap reset-setelah-update yang perlu dikhawatirkan untuk tabel ini — kasusnya BERSIH, tidak serumit `sales`/`purchases`. Tinggal tambah kolom + sertakan di payload sync, selesai.

Saya TIDAK menjalankan migrasi ini sekarang — murni dicatat sebagai pilihan yang tersedia kalau keputusan (a) adalah "ya, masuk Tahap 1".

---

## 5. Mekanisme reset — opsi & trade-off (keputusan Anda)

### Opsi A — Eksplisit manual, per UPDATE statement

Tambah `sync_status = 'local_only'` langsung ke SET clause tiap UPDATE yang relevan (baris #1, #2, #4, #7, #8 — dan #3 kalau diputuskan perlu):
```sql
UPDATE sales SET status = 'voided', void_reason = ?, voided_at = NOW(), voided_by = ?, sync_status = 'local_only' WHERE id = ?
```

**Trade-off:**
- (+) Konsisten dengan gaya kode yang SUDAH ada di seluruh codebase ini — tidak ada ORM, tidak ada query-builder bersama, setiap service menulis SQL-nya sendiri secara eksplisit. Ini bukan pola baru, cuma menambah satu kolom ke pola yang sudah ada.
- (+) Terlihat jelas saat membaca kode satu service — reviewer langsung lihat "oh, ini memang reset sync" tanpa perlu tahu ada mekanisme tersembunyi di tempat lain.
- (+) Tidak berisiko menyentuh tabel yang BELUM punya kolom `sync_status` (mis. `sales_returns` saat ini) — murni ditambah per lokasi yang memang butuh, tidak ada logic generik yang bisa salah sasaran.
- (−) **Rawan terlupa** — persis seperti gap yang baru ditemukan. Tidak ada yang akan ERROR atau bahkan terlihat kalau developer baru menambah UPDATE serupa (mis. fitur edit pembelian nanti) dan lupa menambahkan baris ini — silent correctness bug, sama persis dengan yang sedang diperbaiki sekarang.
- (−) Perlu audit manual berkala (seperti laporan ini) untuk memastikan semua jalur sudah tercakup — tidak ada jaring pengaman otomatis.

### Opsi B — Trigger database (MySQL `BEFORE UPDATE`)

Trigger otomatis di level MySQL yang men-set `NEW.sync_status = 'local_only'` setiap kali baris di tabel ber-sync berubah.

**Trade-off:**
- (+) Mustahil terlupa untuk tabel yang sudah dipasangi trigger — berlaku otomatis, termasuk untuk kode yang belum ditulis.
- (−) **Masalah mendasar**: sync engine SENDIRI nanti juga meng-UPDATE baris ini (`UPDATE sales SET sync_status = 'synced' WHERE id IN (...)` — lihat `SYNC_DESIGN_TAHAP1.md` Bagian 3). Trigger naif akan langsung menimpa balik `'synced'` jadi `'local_only'` lagi SAAT ITU JUGA, bikin baris itu TIDAK PERNAH bisa berstatus `'synced'` — infinite re-dirty. Butuh logic tambahan di trigger (bandingkan `OLD` vs `NEW` utk kolom-kolom LAIN selain `sync_status`, baru override kalau ada yang beda) — bisa dikerjakan, tapi menambah kerumitan SQL tersembunyi.
- (−) **Bertentangan dengan prinsip desain yang sudah dipegang konsisten di seluruh sistem ini**: "Pisahkan logic ke service layer... jangan taruh business logic di route handler langsung" (Bagian 8 blueprint awal) — walau soal trigger vs route handler bukan hal yang sama persis, semangatnya sama: SEMUA logic bisnis sejauh ini hidup di kode Node yang bisa dibaca/di-debug/di-test langsung, BUKAN di database. Sampai saat ini **tidak ada satu trigger pun** di `schema.sql` — ini akan jadi yang PERTAMA, preseden yang mengubah karakter arsitektur.
- (−) Debugging jadi lebih sulit — developer yang bertanya "kenapa baris ini balik jadi local_only" harus tahu untuk cek definisi trigger di database, bukan cuma baca kode service.

### Opsi C — Helper/wrapper terpusat di lapis Node

Fungsi bersama (mis. `markSyncableUpdate(conn, table, id, fields)`) yang SEMUA update status-changing ke tabel ber-sync WAJIB lewat situ — helper ini otomatis menambahkan `sync_status: 'local_only'` ke `fields` sebelum membangun query UPDATE.

**Trade-off:**
- (+) Satu sumber kebenaran, tetap di lapis Node (konsisten dengan prinsip "logic di service layer", bukan di DB) — lebih selaras dgn arsitektur yang ada dibanding Opsi B.
- (+) Lebih sulit terlupa dibanding Opsi A — begitu helper ini jadi "cara yang benar" melakukan update semacam ini, pola penggunaannya bisa ditegakkan lewat code review.
- (−) **Pola baru yang belum ada presedennya** — sejauh ini SETIAP service di codebase ini menulis SQL-nya sendiri secara mandiri/inline, tidak ada lapisan query-builder atau helper bersama di mana pun. Memperkenalkan ini adalah perubahan gaya arsitektur, bukan cuma tambal gap.
- (−) Perlu me-refactor 5-6 lokasi yang SUDAH ada (lebih banyak file tersentuh dibanding Opsi A, yang cuma menambah satu klausa ke query yang sudah ada) untuk migrasi ke pola baru ini.
- (−) Masih bergantung disiplin developer memilih memakai helper ini utk fitur BARU nanti — bukan jaminan mutlak seperti trigger, cuma lebih "jalan yang gampang & benar" dibanding Opsi A.

### Opsi D — Opsi A + jaring pengaman otomatis (bukan runtime, tapi audit terprogram)

Tetap manual per-service (seperti Opsi A), TAPI ditambah satu script kecil (dijalankan manual atau sbg bagian dari proses tertentu — BUKAN bagian dari runtime aplikasi) yang:
1. Membaca `schema.sql` untuk tahu tabel mana yang punya kolom `sync_status`.
2. Grep semua `UPDATE <tabel>` di `src/services/*.js` untuk tabel-tabel itu.
3. Tandai/gagalkan kalau ada UPDATE yang SET clause-nya TIDAK menyebut `sync_status` sama sekali.

**Trade-off:**
- (+) Mempertahankan gaya kode yang sudah ada (tidak ada trigger, tidak ada abstraksi runtime baru) — SET clause tetap eksplisit & terbaca langsung di tiap service, sama seperti Opsi A.
- (+) Langsung menjawab kelemahan UTAMA Opsi A ("rawan lupa") — tanpa mekanisme otomatis di runtime, cukup pengecekan terprogram yang bisa dijalankan kapan saja (atau dijadwalkan) utk menangkap lupa SEBELUM jadi bug produksi, bukan sesudah.
- (−) Bukan jaminan mutlak seperti trigger (Opsi B) — cuma sekuat seberapa rutin script ini dijalankan/diperhatikan hasilnya. Butuh disiplin menjalankannya, walau jauh lebih ringan dibanding audit manual total seperti laporan ini.
- (−) Satu script tambahan yang perlu dirawat (kalau pola penulisan SQL berubah gaya penulisannya, regex script ini bisa perlu disesuaikan).

Saya CONDONG ke **Opsi A atau D** — keduanya paling selaras dengan karakter arsitektur yang SUDAH konsisten dipegang di seluruh sistem ini sejauh perjalanan proyek ini (tidak ada trigger, tidak ada lapisan abstraksi query bersama, semua eksplisit & terbaca di service masing-masing) — tapi ini keputusan Anda, terutama soal apakah jaring pengaman otomatis (D) sepadan dengan usaha membuatnya untuk ukuran tim/kecepatan kerja sekarang.

---

## 6. Pola yang bisa dipakai ulang — ringkasan untuk Tahap berikutnya

Kalau Opsi A atau D dipilih, pola konkretnya untuk SETIAP tabel baru yang masuk scope sync nanti:

1. Tabel itu dibuat — `sync_status` default `'local_only'` (sudah ada polanya di semua tabel transaksi).
2. **Identifikasi SEMUA jalur UPDATE** ke tabel itu (gunakan tabel di Bagian 1 sbg template — sisir tiap service yang menyentuh tabel itu).
3. Untuk tiap jalur UPDATE yang DITEMUKAN: putuskan apakah perubahan itu "material" utk laporan pusat (biasanya: ya, kalau mengubah kolom yang masuk payload sync — status, nilai, dll; tidak, kalau cuma kolom internal yang tidak pernah dikirim). Kalau material, tambahkan `sync_status = 'local_only'` ke SET clause (atau lewat helper, kalau Opsi C/D dipilih).
4. Kasus khusus seperti `stock_opnames` (Bagian 2) — tabel yang "baru layak sync setelah event tertentu", bukan sejak INSERT — perlu dipikirkan kapan TEPATNYA `sync_status` pertama kali boleh dianggap "siap kirim", bukan diasumsikan sama dgn tabel lain.
5. Kasus seperti reversal jurnal (Bagian 3) — kalau tabel itu punya pola "baris asli ditandai + baris baru dibuat" (bukan diedit in-place), pertimbangkan apakah stale status di baris asli benar-benar merusak ANGKA (perlu diperbaiki segera) atau cuma TAMPILAN (bisa ditunda).

---

## Ringkasan keputusan yang diperlukan dari Anda

1. Opsi A, B, C, atau D (Bagian 5) — mekanisme reset yang dipakai.
2. Apakah gap `journal_entries` (reversal, Bagian 3) perlu diperbaiki SEKARANG (bareng sales/purchases/dll) atau bisa ditunda karena sifatnya cuma tampilan, tidak merusak total.
3. Apakah `sales_returns` masuk scope sync Tahap 1 (Bagian 4) — ini menentukan apakah migrasi `sync_status` utk tabel itu perlu disiapkan sekarang juga.
4. (Carry-over dari laporan sebelumnya, masih relevan) — apakah "total nilai" yang dimaksud utk Tahap 1 sudah harus bersih dari retur, atau gross dulu cukup.

---

## Keputusan & Implementasi (8 Oktober 2026)

1. **Mekanisme**: Opsi C (helper Node terpusat) + Opsi D (jaring pengaman audit terprogram) — bukan manual murni, bukan trigger DB.
   - `src/utils/syncStatus.js` — `markDirtyForSync(queryable, table, id)`, dipanggil dari SEMUA 5 jalur aktif (`VoidService.voidSale`, `PurchaseService.voidPurchase`, `InternalStockUsageService.voidInternalStockUsage`, `ShiftService.closeShift`, `SupplierService.updateSupplier`). `SYNCABLE_TABLES` di modul yang sama = satu daftar kebenaran, juga dipakai `audit-sync-status.js`.
   - `src/db/audit-sync-status.js` — jaring pengaman: `node src/db/audit-sync-status.js` (atau `npm run audit:sync-status`), membaca langsung dari database (bukan grep kode), aturan SPESIFIK per tabel (status-based utk sales/purchases/internal_stock_usages/cashier_shifts, `updated_at > created_at` utk suppliers yang tidak punya kolom status). Keluar kode 1 kalau ada baris inkonsisten, 0 kalau bersih — bisa dipanggil kapan pun/dijadwalkan.
2. **`journal_entries` (reversal)**: DITUNDA ke Lapis 3, sesuai analisis (stale status cuma soal tampilan, bukan angka). Dicatat eksplisit lewat komentar kode di `AccountingService.reverseJournalEntry` DAN di `src/utils/syncStatus.js` supaya tidak terlupa alasannya.
3. **`sales_returns`**: MASUK Lapis 1 (keputusan: omzet pusat harus bersih dari retur). Kolom `sync_status` ditambah lewat `add-sales-returns-sync-status.js` (idempotent, dibackport ke `schema.sql`, didaftarkan di `package.json`). TIDAK diikutkan ke `SYNCABLE_TABLES`/`markDirtyForSync` — dikonfirmasi create-only, tidak ada jalur UPDATE sama sekali, default `'local_only'` saat INSERT sudah cukup.
4. **`stock_opnames`**: TIDAK disamakan dengan pola reset — komentar eksplisit ditambahkan di `StockOpnameService.finalizeOpname` menandai ini kasus "baru layak sync setelah event tertentu", supaya tidak ikut ditambal pakai `markDirtyForSync` secara keliru nanti.

### Verifikasi (DB lokal, bukan produksi)

- **5 jalur reset**, diuji end-to-end lewat fungsi SERVICE sungguhan (bukan SQL manual) — buat data dummy (produk/supplier/stok), tandai baris `sync_status='synced'`, jalankan aksi asli (`voidPurchase`, `closeShift`, `voidSale`, `voidInternalStockUsage`, `updateSupplier`), cek baris kembali `'local_only'`. **10/10 assertion lolos** (5 setup + 5 hasil).
- **Audit script**: dijalankan bersih di DB dummy (0 inkonsistensi) — lalu SENGAJA disuntik 1 baris tidak konsisten langsung lewat SQL (melewati helper, mensimulasikan "developer lupa") — audit script **berhasil menangkapnya** (nama tabel, id, deskripsi lengkap, exit code 1). Setelah dicek, bukan masalah skrip-nya sendiri — baris itu memang sengaja dirusak utk tes.
- **Migrasi `sales_returns.sync_status`**: diuji di DB yang SUDAH berisi baris `sales_returns`/`sales_return_items` dummy (dibuat sebelum migrasi, simulasi data existing Semarang) — data lama (grand_total, total_cost, reason, dll) tetap utuh, `sync_status` ter-backfill otomatis jadi `'local_only'`. Dijalankan 2x — kedua kali aman (kedua kalinya 0 perubahan, idempotent).
- **Kesetaraan schema.sql**: DB fresh (schema.sql + seed.js terbaru) dibandingkan ke DB lama yang di-migrasi incremental (schema.sql lama + seed.js lama + migrasi dijalankan manual) — diff `information_schema.COLUMNS`/`KEY_COLUMN_USAGE`/`STATISTICS`: **kosong**, identik.

Semua database uji & script sementara sudah dihapus setelah verifikasi — tidak ada DB produksi yang disentuh sepanjang proses ini.
