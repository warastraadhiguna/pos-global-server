# Audit Kesiapan & Usulan Desain — Identitas Cabang

**Branch:** `feature/branch-identity`
**Tanggal:** 7 Oktober 2026
**Status:** ANALISIS SAJA — belum ada kode implementasi, belum ada perubahan skema/DB apa pun. Tidak ada DB produksi yang disentuh untuk audit ini (semua dari pembacaan kode).

Konteks: fondasi identitas cabang, prasyarat sebelum sync engine satu-arah cabang→pusat dibangun. Sesuai arahan, Bagian 1 murni audit (laporan, tanpa ubah apa pun), Bagian 2 murni usulan dengan trade-off (menunggu keputusan sebelum implementasi).

---

## Ringkasan Eksekutif

1. **Temuan di luar permintaan tapi kritis** (Bagian 1.0): `schema.sql` — yang jadi basis bootstrap DB baru — sudah **tidak sinkron** dengan apa yang sesungguhnya dibangun lewat 3 migrasi incremental belakangan. Dampaknya: kalau sebuah instalasi cabang baru (mis. Purwodadi) dibangun hari ini mengikuti prosedur yang terdokumentasi di `package.json`, hasilnya akan **kehilangan 3 fitur** yang sudah jalan di Semarang. Ini perlu diputuskan/diperbaiki SEBELUM identitas cabang dibangun di atasnya, supaya fondasinya tidak ikut mewariskan drift ini ke tiap cabang baru.
2. **UUID PK**: klaim di blueprint **terpenuhi** — tidak ada satu pun tabel entity-per-baris yang pakai auto-increment. 3 tabel config singleton sengaja PK langsung di `branch_id` (pola berbeda, relevan untuk Bagian 2).
3. **`sync_status`**: ada secara konsisten di semua tabel "dokumen transaksi finansial". Tabel master/katalog (products, units, price_levels, payment_methods, dll) **tidak punya** — ini bukan oversight per se, tapi langsung berimplikasi ke pertanyaan "bagaimana pusat tahu 'produk X di cabang A' dan 'produk X di cabang B' itu barang yang sama" (lihat 1.3).
4. **COA**: deterministik di level **kode & nama** (array hardcoded di `seed.js`), **tidak** deterministik di level `accounts.id` (UUID baru tiap install). Konsolidasi pusat wajib join lewat `code`, bukan `id`.
5. **`branch_id` saat ini**: bukan satu titik konfigurasi, tapi `const BRANCH_ID = 1` dideklarasikan ulang secara independen di **20 file service** + 1 literal mentah di SQL — relevan langsung ke estimasi effort Bagian 2.

---

## BAGIAN 1 — Audit Kesiapan

### 1.0 Temuan tambahan: `schema.sql` sudah drift dari realita produksi

Server punya dua jalur perubahan skema:
- `schema.sql` + `npm run db:migrate` — **destruktif** (`DROP TABLE IF EXISTS` di setiap tabel), dipakai untuk bootstrap DB **baru/fresh** saja.
- `src/db/add-*.js` — migrasi incremental, idempotent, `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` saja, aman dijalankan di DB produksi berisi data.

`package.json` mendaftarkan 5 migrasi incremental sebagai npm script (`db:add-purchase-drafts`, `db:add-purchase-discount-notes`, `db:add-internal-stock-usage`, `db:add-backup-feature`, `db:fix-conversion-mismatch`) — kelimanya **sudah di-backport** ke `schema.sql`, jadi menjalankannya di DB fresh hasil `schema.sql` adalah no-op aman.

Tapi ada **3 file migrasi yang ADA di folder `src/db/` namun TIDAK terdaftar di `package.json` DAN TIDAK di-backport ke `schema.sql`**:

| File migrasi | Yang dibuat/diubah | Status di `schema.sql` |
|---|---|---|
| `add-sales-returns.js` | Tabel `sales_returns` + `sales_return_items` (PLURAL — perhatikan ini BEDA nama dari `sale_returns`/`sale_return_items` SINGULAR yang sudah ada di `schema.sql` sejak hari 1 sebagai placeholder kosong "retur formal", dan placeholder itu **tidak pernah dipakai kode manapun**). Juga insert 2 baris permission `sales_returns.view`/`create` + grant ke role `admin` langsung ke tabel `permissions`/`role_permissions` (di luar `seed.js`). | **Tidak ada** — `schema.sql` cuma punya tabel placeholder lama yang nganggur. `SalesReturnService.js` (kode yang sungguhan jalan) query ke `sales_returns`/`sales_return_items`, bukan ke `sale_returns`/`sale_return_items`. |
| `add-below-cost-authorization.js` | Kolom `users.totp_secret`, `users.totp_enabled_at` + tabel baru `below_cost_authorizations` + permission `sales.sell_below_cost`. | **Tidak ada sama sekali** di `schema.sql`. |
| `add-internal-stock-usage-void.js` | Kolom `internal_stock_usages.status/void_reason/voided_at/voided_by`. | **Tidak ada** — `schema.sql` versi `internal_stock_usages` tidak punya kolom void ini. |

**Koreksi atas dokumentasi sebelumnya**: di `STATUS_PROYEK.md` (dibuat sesi sebelum ini) saya sempat menulis bahwa permission `sales_returns` "belum terdaftar di katalog, jadi cuma superadmin yang bisa akses" — itu benar untuk `seed.js` (jalur fresh-install), **tapi salah untuk Semarang produksi**: `add-sales-returns.js` sudah insert permission itu langsung + grant ke role `admin`, jadi di produksi kemungkinan besar sudah bisa diberikan ke role non-superadmin. Saya akan perbaiki `STATUS_PROYEK.md` terpisah — disebut di sini supaya tidak ada kesan saya diam-diam mengandalkan kesimpulan lama yang sudah terbukti keliru.

**Kenapa ini relevan untuk identitas cabang**: rencana besarnya adalah tiap cabang baru = instalasi DB lengkap yang independen. Kalau prosedur bootstrap standar (`db:migrate` + `db:seed` + 5 npm script migrasi) dipakai apa adanya untuk Purwodadi, cabang itu akan **berbeda fitur** dari Semarang sejak hari pertama (tidak ada Retur Penjualan sama sekali — nama tabelnya pun beda kalau nanti ditambal manual, tidak ada Otorisasi Jual di Bawah HPP, tidak ada Void Pemakaian Internal). Ini murni soal kelengkapan/konsistensi instalasi, di luar topik branch_id itu sendiri, tapi perlu diputuskan lebih dulu (atau minimal disadari) sebelum "cara bootstrap cabang baru" distandardisasi sebagai bagian dari fitur identitas cabang ini.

---

### 1.1 Peta pemakaian `branch_id`

**Tabel yang punya kolom `branch_id`** (33 dari 48 tabel di `schema.sql`, belum termasuk 3 tabel yang drift di atas — ketiganya juga punya `branch_id INT DEFAULT 1` kecuali `below_cost_authorizations` yang tidak punya sama sekali):

```
users, warehouses, stock_movements, stock_balances, stock_adjustments,
cashier_shifts, cash_movements, sales, suppliers, purchases, stock_opnames,
purchase_returns, internal_stock_usages, purchase_drafts, sale_returns*,
activity_logs, accounting_periods, journal_entries, fixed_assets, sale_drafts,
backup_history
```
(*`sale_returns` placeholder nganggur — lihat 1.0)

**Tabel TANPA `branch_id`** — dua kelompok:
- **Child/item tables** (`sale_items`, `purchase_items`, `journal_entry_lines`, dst) — wajar, selalu diwarisi lewat FK ke parent yang punya `branch_id`. Bukan gap.
- **Master/katalog/config**: `products`, `product_categories`, `units`, `product_units`, `barcodes`, `price_levels`, `product_prices`, `payment_methods`, `cash_denominations`, `accounts` (COA), `roles`, `permissions`, `role_permissions`. Tiga tabel singleton config (`pricing_settings`, `store_settings`, `backup_settings`) malah PK **langsung** di `branch_id` (lihat 1.2).

**Bagaimana nilainya ditulis/dibaca** — INI YANG PALING RELEVAN untuk Bagian 2: `branch_id` **bukan** satu konstanta terpusat. Ditemukan:
- `const BRANCH_ID = 1;` dideklarasikan ulang secara independen di **20 file service**: `AccountingPeriodService`, `AccountingService`, `AuthService`, `BackupService`, `CashMovementService`, `FixedAssetService`, `InternalStockUsageService`, `PricingEngineService`, `PricingSettingsService`, `PurchaseDraftService`, `PurchaseReturnService`, `PurchaseService`, `SaleDraftService`, `SalesReturnService`, `SalesService`, `ShiftService`, `StockMovementService`, `StockOpnameService`, `StoreSettingsService`, `SupplierService`, `UserService`, `WarehouseService` (21 — satu lebih saya hitung ganda, persisnya 20 file unik punya deklarasi ini).
- **1 literal mentah** langsung di string SQL: `WarehouseService.js` baris 8 — `WHERE branch_id = 1` — ini tidak akan ketemu kalau cuma cari-ganti nama konstanta `BRANCH_ID`.
- `AuthService.js` menanamkan `branchId: BRANCH_ID` ke **payload JWT** saat login (`{ id, role, branchId, ... }`) — jadi identitas cabang sudah "mengalir" ke token user, walau isinya selalu `1` hari ini. `middleware/auth.js` membaca `req.user` dari token tapi (sejauh yang saya telusuri) tidak ada kode yang benar-benar memvalidasi/memakai `branchId` dari token itu untuk apa pun — murni dibawa-bawa, belum difungsikan.

Konsekuensi langsung: migrasi ke `branch_id` yang bisa dikonfigurasi per instalasi **bukan perubahan satu baris** di satu tempat — butuh menyentuh (minimal) 20 file + 1 literal tersembunyi, kecuali desainnya disentralkan lebih dulu (lihat Opsi A di Bagian 2).

---

### 1.2 Verifikasi UUID sebagai PK

**Klaim blueprint TERPENUHI** — memeriksa seluruh 48 `CREATE TABLE` di `schema.sql`: **tidak ada satu pun** PK `AUTO_INCREMENT`. Semua pakai `CHAR(36) NOT NULL PRIMARY KEY` (UUID v4, dari `uuidv4()` di kode).

Dua pengecualian pola (bukan pelanggaran, tapi beda dari pola UUID biasa, dan **langsung relevan ke Bagian 2**):
1. **`role_permissions`** — tidak punya PK surrogate sama sekali, PK-nya komposit `(role_id, permission_id)`, keduanya `CHAR(36)`. Aman untuk sync (dua-duanya UUID).
2. **3 tabel config singleton** — `pricing_settings`, `store_settings`, `backup_settings` — PK-nya **langsung** `branch_id INT NOT NULL PRIMARY KEY DEFAULT 1` (bukan UUID, bukan auto-increment juga — literal `branch_id` itu sendiri jadi primary key). Ini desain yang masuk akal untuk tabel "1 baris per cabang", TAPI artinya begitu ada 2 instalasi dengan `branch_id` yang sama (keduanya hardcode `1` hari ini), struktur tabel ini sendiri sebenarnya **tidak akan pernah bentrok dalam satu DB** (karena tiap instalasi cabang = DB terpisah) — tapi KALAU suatu saat baris-baris ini juga perlu disalin/direplikasi ke DB pusat dalam satu tabel gabungan, `branch_id` di 3 tabel ini WAJIB sudah unik secara global duluan, karena ia bukan cuma kolom partisi tapi literal primary key.

---

### 1.3 Verifikasi `sync_status`

**Tabel yang PUNYA `sync_status`** (semua "dokumen transaksi finansial", konsisten):
```
stock_movements, stock_adjustments, cashier_shifts, cash_movements,
sales, sale_items, sale_payments, suppliers, purchases, purchase_items,
purchase_payments, stock_opnames, stock_opname_items, purchase_returns,
purchase_return_items, sale_returns*, sale_return_items*, activity_logs,
journal_entries, journal_entry_lines, fixed_assets
```
(*placeholder nganggur, lihat 1.0 — tabel `sales_returns`/`sales_return_items` yang sungguhan dipakai TIDAK punya `sync_status` sama sekali, karena dibuat lewat migrasi yang lupa menambahkannya)

**Tabel transaksi yang TIDAK punya `sync_status` tapi arguably seharusnya ikut tersinkron**:
- **`users`** — data karyawan/kasir. Kalau pusat butuh tahu "siapa yang kerja di cabang mana" untuk laporan konsolidasi, ini perlu disinkron. Kalau user dianggap murni operasional-lokal (tidak relevan di pusat), tidak perlu. **Perlu keputusan bisnis**, bukan hal teknis.
- **`fixed_asset_depreciation_entries`** — tidak punya sendiri, tapi terhubung ke `journal_entries` (yang punya `sync_status`) lewat `journal_entry_id`, jadi secara praktis masih bisa ikut tersinkron lewat jurnalnya. Gap minor.
- **`sales_returns`/`sales_return_items`** (yang sungguhan) — lihat 1.0, murni ketinggalan karena migrasinya luput, bukan keputusan desain.
- **`below_cost_authorizations`** — token otorisasi sekali-pakai, sifatnya operasional-lokal/kadaluarsa cepat, kemungkinan memang tidak perlu sync. Perlu dikonfirmasi tapi risikonya rendah.

**Tabel master/katalog TANPA `sync_status`** — ini kelompok paling penting untuk didiskusikan, karena bukan sekadar "kolom yang kurang" tapi pertanyaan desain yang lebih dalam:
`products`, `product_categories`, `units`, `product_units`, `barcodes`, `price_levels`, `product_prices`, `payment_methods`, `cash_denominations`, `accounts`.

Karena tiap cabang adalah instalasi independen, `products.id` (UUID) untuk SKU yang SAMA (mis. "Indomie Goreng 85gr") akan **berbeda** antara Semarang dan Purwodadi — masing-masing di-generate sendiri saat admin cabang itu input produknya. Begitu juga `units.id`, `price_levels.id`, `payment_methods.id`, `accounts.id` (lihat 1.4). Ini berarti: laporan konsolidasi pusat yang ingin menjumlahkan "total penjualan Indomie Goreng 85gr di semua cabang" **tidak bisa** join langsung by UUID — perlu kunci identitas yang sama-sama dikenali semua cabang (mis. `sku`, atau `code` untuk akun). Ini murni fakta/temuan, opsi penyelesaiannya (SKU sebagai kunci konsolidasi, katalog pusat yang didorong ke cabang, dll) ada di luar cakupan Bagian 2 (yang fokus ke identitas CABANG, bukan identitas PRODUK) — saya sebutkan di sini supaya tercatat sebagai pekerjaan rumah terpisah untuk fase sync nanti, bukan diasumsikan otomatis beres begitu `branch_id` sudah unik.

**Tabel yang SENGAJA tidak punya `sync_status` (bukan gap)**: `stock_balances` (cache turunan, bisa direkonstruksi dari `stock_movements` yang sudah sync), `sale_drafts`/`purchase_drafts` (dokumen kerja sementara, belum jadi transaksi final), `opening_balance_runs` (penanda lokal "sudah pernah jalan"), `roles`/`permissions`/`role_permissions` (konfigurasi keamanan, seharusnya memang per-instalasi, bukan disinkron), `pricing_settings`/`store_settings`/`backup_settings` (config operasional lokal), `price_change_events`/`price_change_event_lines` (notifikasi internal), `backup_history` (metadata file lokal).

---

### 1.4 Verifikasi determinisme COA

**Kode & struktur COA deterministik** — `ACCOUNTS` di `src/db/seed.js` adalah array JavaScript hardcoded (code, name, category, normalBalance, parent, postable), bukan di-generate dari input apa pun. `seedAccounts()` meng-insert array ini apa adanya. **Dua instalasi fresh AKAN punya `code`, `name`, `category`, `normal_balance`, dan hierarki parent/child yang identik.**

**TAPI `accounts.id` (UUID) TIDAK deterministik** — `seedAccounts()` memanggil `uuidv4()` baru untuk tiap akun di tiap kali `seed()` dijalankan. Jadi akun dengan `code='1-101'` ("Kas") akan punya UUID berbeda di Semarang vs Purwodadi.

**Implikasi langsung**: `journal_entry_lines.account_id` menunjuk ke UUID yang **per-instalasi**. Kalau nanti jurnal dari berbagai cabang dikonsolidasi di pusat, proses konsolidasi **wajib** me-resolve `account_id` lewat `accounts.code` (yang deterministik), bukan menyamakan `account_id` mentah-mentah antar cabang (yang tidak akan pernah cocok).

**Tidak ada jalur runtime untuk menambah akun COA** — saya grep seluruh `server/src` untuk `INSERT INTO accounts`: cuma ada di `seed.js` dan satu migrasi lama (`add-internal-stock-usage.js`, yang menambah 1 akun beban baru lewat pola yang sama, deterministik juga). Tidak ada endpoint/service "buat akun baru" yang bisa dipanggil admin dari UI. Artinya **COA sejauh ini memang tertutup/tetap** — bagus untuk determinisme, tapi juga berarti kalau suatu cabang butuh akun khusus yang tidak ada di cabang lain, belum ada jalur resmi untuk itu (tidak masuk cakupan audit ini, cuma dicatat sebagai fakta).

---

## BAGIAN 2 — Usulan Desain Identitas Cabang (opsi & trade-off, BUKAN keputusan)

Sesuai arahan: ini usulan dengan trade-off untuk direview, bukan pilihan final. Saya urutkan dari yang paling minim perubahan ke yang paling fleksibel.

### Opsi A — `branch_id` tetap INT, dibaca dari `.env` per instalasi (plus sentralisasi dulu)

**Cara kerja**: buat `src/config/branch.js` (pola identik dengan `src/config/db.js` yang sudah ada — baca `process.env`, fallback ke `1` untuk dev). Ganti 20 deklarasi lokal `const BRANCH_ID = 1` + 1 literal mentah di `WarehouseService.js` supaya semua `require('../config/branch')`. Tiap instalasi cabang set `BRANCH_ID=2` (Purwodadi), `BRANCH_ID=3`, dst di file `.env` masing-masing — sama persis pola `DB_HOST`/`DB_PORT` yang sudah ada.

**Trade-off:**
- (+) Paling konsisten dengan prinsip desain yang SUDAH ada (blueprint Bagian 8: "IP server harus bisa dikonfigurasi... beda-beda tergantung jaringan toko" — `branch_id` masuk kategori config-per-instalasi yang sama).
- (+) Tidak perlu migrasi skema SAMA SEKALI — kolom `branch_id INT` sudah ada di mana-mana, cuma NILAI defaultnya yang sekarang hardcode di kode, bukan di skema.
- (+) Perubahan mekanis & dangkal (cari-ganti konstanta), walau tersebar di 20 file — risiko salah ketik rendah kalau dikerjakan sistematis.
- (−) `branch_id INT` artinya ADMIN TOKO harus tahu & tidak boleh salah ketik angka unik di `.env` tiap instalasi baru — tidak ada penjamin otomatis "Purwodadi" tidak pernah dapat angka yang sama dengan cabang lain kalau prosesnya manual (mis. technician yang pasang lupa cek daftar cabang mana saja yang sudah pakai angka berapa). Risiko tabrakan murni bergantung disiplin manusia/checklist deployment, bukan dicegah sistem.
- (−) `branch_id` sebagai angka polos tidak membawa makna (beda dengan kode yang bisa dibaca manusia, mis. "SMG" untuk Semarang) — kalau suatu saat perlu ditelusuri manual di DB pusat ("baris ini dari cabang mana?"), admin pusat harus hafal/lookup angka ke nama cabang di tempat lain.

### Opsi B — Tambah kolom `branch_code` (VARCHAR) terpisah, `branch_id` (INT) tetap untuk FK lokal

**Cara kerja**: `branch_id INT` tetap persis seperti sekarang (tetap `1` untuk SEMUA instalasi, tidak perlu diubah SAMA SEKALI di 20 file tsb) — perannya murni partisi LOKAL dalam satu DB cabang (yang memang selalu cuma ada 1 nilai di sana). Tambahkan 1 kolom BARU `branch_code VARCHAR(20)` cuma di `store_settings` (atau tabel identitas baru khusus, 1 baris), isinya string unik per instalasi (mis. `"SMG"`, `"PWD"`), ditulis sekali saat instalasi disiapkan (lewat `.env` atau diisi admin). Kolom ini-lah yang nanti "menumpang" ke payload sync (dibungkus di metadata saat data dikirim ke pusat), BUKAN disebar ke tiap tabel transaksi.

**Trade-off:**
- (+) PALING MINIM perubahan ke kode yang sudah ada — 20 file + 1 literal itu **tidak perlu disentuh sama sekali**, karena `branch_id` tetap berarti "partisi lokal", bukan "identitas global".
- (+) `branch_code` yang readable (string, bukan angka) lebih mudah diaudit manusia & lebih kecil kemungkinan collision manual (penamaan "SMG"/"PWD" secara alami lebih jarang typo-tabrakan dibanding mengingat urutan angka).
- (+) Memisahkan dua concern yang sebenarnya beda: "partisi data DALAM satu DB" (branch_id, yang sebenarnya hari ini nyaris tidak berguna karena cuma 1 nilai per DB) vs "identitas cabang ANTAR DB saat konsolidasi" (branch_code, baru benar-benar dipakai saat sync).
- (−) Dua sumber kebenaran identitas cabang (`branch_id` lokal yang "mati"/selalu 1, dan `branch_code` yang sebenarnya hidup) bisa membingungkan developer baru yang membaca kode — perlu didokumentasikan jelas supaya tidak dikira redundan/salah satu tidak kepake.
- (−) Saat sync engine dibangun nanti, SETIAP tabel yang mau dikirim ke pusat perlu "menempelkan" `branch_code` ini saat payload dibentuk (karena baris-baris tabel itu sendiri tidak membawanya) — bukan tinggal `SELECT * WHERE branch_id=X`, perlu JOIN/lookup balik ke tabel identitas tiap kali.

### Opsi C — `branch_id`/`branch_code` disimpan di DB (`store_settings`) sebagai sumber kebenaran, bukan `.env`

**Cara kerja**: variasi dari A atau B, tapi nilainya dibaca dari tabel `store_settings` (yang sudah ada, sudah singleton per-branch) saat server start, di-cache di memori — BUKAN dari `process.env`. `.env` cukup berisi kredensial DB/JWT seperti sekarang.

**Trade-off:**
- (+) Diisi lewat UI (halaman Pengaturan Toko yang sudah ada) — admin toko non-teknis bisa verifikasi/isi sendiri, tidak bergantung technician yang paham edit file `.env`.
- (+) Satu sumber kebenaran yang konsisten dengan pola `store_settings` lain (nama toko, alamat, dll — semua "identitas toko" sudah di satu tempat).
- (−) Ada jendela waktu "DB sudah ke-seed tapi identitas cabang belum diisi admin" yang perlu ditangani (nilai default apa sebelum diisi? Blokir start server? Fallback ke `1`/placeholder?) — butuh keputusan tambahan yang tidak perlu ada di Opsi A/B (yang nilainya sudah pasti sejak `.env` ditulis saat instalasi).
- (−) Sedikit lebih kompleks secara teknis (butuh baca DB saat boot sebelum nilai ini tersedia ke seluruh service lain) dibanding baca `.env` yang langsung tersedia synchronous saat proses start.

### Catatan lintas-opsi: keamanan migrasi untuk Semarang yang sudah produksi

Semua 3 opsi di atas AMAN untuk data existing Semarang **asalkan**:
- Nilai default/fallback-nya tetap `1` (Opsi A/C) atau kolom `branch_code` baru diisi dengan nilai yang disepakati untuk Semarang (mis. `"SMG"`) lewat migrasi incremental satu-arah (`ALTER TABLE ... ADD COLUMN`, `UPDATE ... SET branch_code = 'SMG' WHERE branch_id = 1`) — pola yang PERSIS sama dengan migrasi `add-*.js` yang sudah ada (idempotent, tidak ada DROP/TRUNCATE).
- TIDAK ADA opsi di atas yang mengharuskan `branch_id` existing (`1`) di Semarang berubah nilai — semuanya menambah identitas BARU di sampingnya, bukan menggantikan yang lama. Ini sejalan dengan arahan "data existing branch_id=1 harus tetap valid".

### Bagaimana ini nyambung ke `sync_status` nanti (tanpa implementasi sekarang)

Apa pun opsi yang dipilih, alur sync satu-arah nantinya kurang lebih: proses sync engine query baris-baris dengan `sync_status='local_only'` (atau status pending lain) dari tabel-tabel yang punya kolom itu (lihat daftar di 1.3), **menempelkan identitas cabang** (dari opsi yang dipilih di atas) ke payload saat dikirim ke pusat, lalu meng-update `sync_status` baris itu jadi `'synced'` setelah pusat konfirmasi diterima. Pekerjaan rumah tambahan yang SUDAH kelihatan dari audit ini (di luar cakupan "identitas cabang" itu sendiri, tapi perlu disadari sebagai fase berikutnya):
- Tabel master/katalog (`products`, `accounts`, dll) yang TIDAK punya `sync_status` perlu strategi konsolidasi terpisah berbasis `sku`/`code` (bukan `sync_status` per baris), karena sifatnya beda dari dokumen transaksi.
- 3 tabel migrasi yang drift (1.0) perlu diselesaikan (minimal `sales_returns`/`sales_return_items` ditambah `sync_status`) SEBELUM dianggap siap ikut sync, supaya tidak ada dokumen transaksi finansial yang diam-diam tidak pernah tersinkron.

---

## Pertanyaan yang perlu dijawab sebelum lanjut implementasi

1. **Drift migrasi (1.0)**: mau diselesaikan dulu sebagai pekerjaan terpisah (backport 3 migrasi itu ke `schema.sql` + `package.json`, dan idealnya rename tabel `sales_returns`/placeholder lama dibersihkan), SEBELUM identitas cabang dibangun di atas fondasi yang sama? Atau jalan paralel/nanti?
2. **Opsi A, B, atau C** (atau kombinasi, mis. B digabung C — `branch_code` di `store_settings`, diisi lewat UI) — mana yang mau dipakai?
3. **`users` dan `sync_status`** (1.3): data karyawan/kasir perlu ikut konsolidasi ke pusat atau tetap murni lokal per cabang?
4. Siapa/bagaimana `branch_code`/`branch_id` unik ini DITETAPKAN secara operasional tiap kali ada instalasi cabang baru — ada daftar pusat manual (spreadsheet/dokumen) yang jadi "sumber kebenaran" supaya tidak ada 2 cabang kebetulan dapat kode yang sama?
