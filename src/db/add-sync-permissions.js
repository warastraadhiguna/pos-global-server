// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma INSERT IGNORE, tidak ada DROP/TRUNCATE/DELETE apa pun.
// Idempotent — aman dijalankan berkali-kali.
//
// Fitur: UI admin utk atur sync.sync_settings (enabled/interval/batch_size)
// + trigger manual, pengganti Node one-liner manual yg dipakai sebelumnya
// (lihat server/docs/SYNC_BATCHING.md, SYNC_DESIGN_TAHAP1.md). Tabel
// sync_settings sendiri sudah ada dari add-sync-settings.js — migrasi ini
// cuma menambah izin RBAC-nya.
//
// Usage: node src/db/add-sync-permissions.js
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

const NEW_PERMISSIONS = [
  ['sync', 'view', 'Lihat status & pengaturan sinkronisasi ke pusat', 0],
  ['sync', 'manage', 'Ubah pengaturan sinkronisasi (aktif/nonaktif, interval, ukuran batch), jalankan manual', 1],
];

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log('Menambah 2 izin baru (sync.view/manage)...');
    for (const [module, action, description, isSensitive] of NEW_PERMISSIONS) {
      await conn.query(
        `INSERT IGNORE INTO permissions (id, module, action, description, is_sensitive) VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), module, action, description, isSensitive]
      );
    }

    console.log('Memberi izin baru ke role "admin" (default tertutup utk role lain)...');
    const [result] = await conn.query(`
      INSERT IGNORE INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
      WHERE r.name = 'admin' AND p.module = 'sync'
    `);
    console.log(`  ${result.affectedRows} baris role_permissions ditambahkan (0 kalau sudah pernah jalan sebelumnya).`);

    await conn.commit();
    console.log('\nSelesai — tidak ada data lain yang tersentuh/terhapus.');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Migrasi gagal:', err);
  process.exit(1);
});
