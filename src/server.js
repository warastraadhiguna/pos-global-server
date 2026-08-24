require('dotenv').config();
const app = require('./app');
const pool = require('./config/db');
const BackupScheduler = require('./services/BackupScheduler');

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0'; // dikonfigurasi via env, bukan hardcode (Bagian 8)

async function start() {
  // Pastikan koneksi DB hidup sebelum server menerima request
  await pool.query('SELECT 1');
  app.listen(PORT, HOST, () => {
    console.log(`POS branch server berjalan di http://${HOST}:${PORT}`);
  });
  BackupScheduler.start();
}

start().catch((err) => {
  console.error('Gagal start server (cek koneksi database):', err.message);
  process.exit(1);
});
