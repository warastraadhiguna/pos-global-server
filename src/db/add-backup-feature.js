// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma CREATE TABLE IF NOT EXISTS / INSERT IGNORE, tidak ada
// DROP/TRUNCATE/DELETE apa pun. Idempotent — aman dijalankan berkali-kali.
//
// Fitur: Backup Database (manual + terjadwal otomatis), admin panel ->
// Administrasi -> Backup. Lihat catatan panjang di schema.sql soal
// backup_settings (singleton) & backup_history (retensi).
//
// Usage: node src/db/add-backup-feature.js
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

const NEW_PERMISSIONS = [
  ['backups', 'view', 'Lihat riwayat & jadwal backup database', 0],
  ['backups', 'manage', 'Jalankan backup manual, atur jadwal otomatis, download/hapus file backup — sensitif', 1],
];

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log('Membuat tabel backup_settings (kalau belum ada)...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS backup_settings (
        branch_id         INT         NOT NULL PRIMARY KEY DEFAULT 1,
        auto_enabled      TINYINT(1)  NOT NULL DEFAULT 0,
        schedule_time     VARCHAR(5)  NOT NULL DEFAULT '02:00',
        retention_count   INT         NOT NULL DEFAULT 7,
        last_run_at       DATETIME    NULL,
        last_run_status   VARCHAR(20) NULL,
        last_run_error    TEXT        NULL,
        updated_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by        CHAR(36)    NULL,
        CONSTRAINT fk_backup_settings_user FOREIGN KEY (updated_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    console.log('Membuat tabel backup_history (kalau belum ada)...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS backup_history (
        id                  CHAR(36)     NOT NULL PRIMARY KEY,
        branch_id           INT          NOT NULL DEFAULT 1,
        filename            VARCHAR(255) NOT NULL,
        file_size           BIGINT       NULL,
        status              VARCHAR(20)  NOT NULL,
        error_message       TEXT         NULL,
        triggered_by        VARCHAR(20)  NOT NULL,
        triggered_by_user   CHAR(36)     NULL,
        created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_backup_history_user FOREIGN KEY (triggered_by_user) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);
    await conn.query(`CREATE INDEX idx_backup_history_created ON backup_history(created_at)`).catch((err) => {
      if (err.code !== 'ER_DUP_KEYNAME') throw err;
    });

    console.log('Menambah 2 izin baru (backups.view/manage)...');
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
      WHERE r.name = 'admin' AND p.module = 'backups'
    `);
    console.log(`  ${result.affectedRows} baris role_permissions ditambahkan (0 kalau sudah pernah jalan sebelumnya).`);

    await conn.commit();
    console.log('\nSelesai — tidak ada data lain yang tersentuh/terhapus.');
    console.log('\nCATATAN: pastikan MYSQLDUMP_PATH di .env menunjuk ke mysqldump yang benar kalau tidak ada di PATH sistem.');
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
