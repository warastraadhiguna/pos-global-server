// Jaring pengaman (bukan bagian dari runtime aplikasi) — mendeteksi baris
// yang jelas SUDAH berubah sejak dibuat (void/tutup/edit) tapi sync_status-
// nya masih 'synced', yang berarti perubahan itu TIDAK akan pernah
// terkirim ke pusat. Ini menangkap kalau ada jalur UPDATE baru ke tabel
// SYNCABLE_TABLES yang lupa memanggil markDirtyForSync (src/utils/
// syncStatus.js) — baik karena developer lupa, atau karena ada migrasi/
// query manual langsung ke database yang melewati application layer.
//
// Aturan per tabel SENGAJA spesifik (bukan satu aturan generik) — kolom
// yang menandakan "baris ini pasti sudah berubah" beda-beda bentuknya:
// sales/purchases/internal_stock_usages/cashier_shifts punya kolom status
// bertingkat (voided/closed), suppliers tidak — makanya pakai
// updated_at > created_at sbg sinyal "pasti pernah di-UPDATE".
//
// Usage: node src/db/audit-sync-status.js
require('dotenv').config();
const pool = require('../config/db');
const { SYNCABLE_TABLES } = require('../utils/syncStatus');

const RULES = {
  sales: {
    where: `status = 'voided' AND sync_status = 'synced'`,
    describe: (r) => `sale_number=${r.sale_number} status=voided tapi sync_status=synced (voided_at=${r.voided_at})`,
  },
  purchases: {
    where: `status = 'voided' AND sync_status = 'synced'`,
    describe: (r) => `purchase_number=${r.purchase_number} status=voided tapi sync_status=synced (voided_at=${r.voided_at})`,
  },
  internal_stock_usages: {
    where: `status = 'voided' AND sync_status = 'synced'`,
    describe: (r) => `usage_number=${r.usage_number} status=voided tapi sync_status=synced (voided_at=${r.voided_at})`,
  },
  cashier_shifts: {
    where: `status = 'closed' AND sync_status = 'synced'`,
    describe: (r) => `shift id=${r.id} status=closed tapi sync_status=synced (closed_at=${r.closed_at})`,
  },
  suppliers: {
    where: `updated_at > created_at AND sync_status = 'synced'`,
    describe: (r) => `supplier name=${r.name} updated_at (${r.updated_at}) > created_at (${r.created_at}) tapi sync_status=synced`,
  },
};

async function run() {
  // Konsistensi SYNCABLE_TABLES <-> RULES — kalau ada tabel baru ditambah
  // ke satu sisi tanpa sisi lain, gagal keras di sini, bukan diam-diam
  // melewatkan tabel itu dari audit.
  const syncableList = [...SYNCABLE_TABLES].sort();
  const ruleList = Object.keys(RULES).sort();
  const missingRules = syncableList.filter((t) => !ruleList.includes(t));
  const extraRules = ruleList.filter((t) => !syncableList.includes(t));
  if (missingRules.length || extraRules.length) {
    console.error('audit-sync-status: SYNCABLE_TABLES dan RULES tidak sinkron.');
    if (missingRules.length) console.error(`  Tabel di SYNCABLE_TABLES tapi belum ada RULES: ${missingRules.join(', ')}`);
    if (extraRules.length) console.error(`  Tabel di RULES tapi tidak ada di SYNCABLE_TABLES: ${extraRules.join(', ')}`);
    process.exit(1);
  }

  let totalInconsistent = 0;
  for (const table of syncableList) {
    const { where, describe } = RULES[table];
    const [rows] = await pool.query(`SELECT * FROM ${table} WHERE ${where}`);
    if (rows.length === 0) {
      console.log(`[OK]   ${table}: tidak ada inkonsistensi (0 baris)`);
    } else {
      totalInconsistent += rows.length;
      console.log(`[GAGAL] ${table}: ${rows.length} baris inkonsisten ditemukan`);
      for (const r of rows) {
        console.log(`         - id=${r.id} :: ${describe(r)}`);
      }
    }
  }

  await pool.end();

  if (totalInconsistent > 0) {
    console.log(`\nTotal ${totalInconsistent} baris inkonsisten di seluruh tabel syncable.`);
    console.log('Artinya: baris ini sudah berubah tapi TIDAK akan terkirim ulang ke pusat saat sync nanti aktif.');
    console.log('Cek jalur UPDATE ke tabel terkait — pastikan memanggil markDirtyForSync (src/utils/syncStatus.js).');
    process.exit(1);
  }
  console.log('\nBersih — tidak ada inkonsistensi sync_status ditemukan.');
}

run().catch((err) => {
  console.error('Audit gagal dijalankan:', err);
  process.exit(1);
});
