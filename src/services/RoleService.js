// RBAC — layanan role/izin. Part A: guard "superadmin tidak boleh mengunci
// diri sendiri".
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

// Dipanggil SEBELUM user dinonaktifkan atau dipindah dari role superadmin —
// kalau target adalah superadmin SATU-SATUNYA yang masih aktif, tolak.
// Mencegah skenario sistem terkunci total (tidak ada satu pun akun yang
// bisa kelola role/izin lagi).
async function assertNotLastSuperadmin(conn, userId) {
  const [[target]] = await conn.query(
    `SELECT r.is_superadmin FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId]
  );
  if (!target || !target.is_superadmin) return; // bukan superadmin, tidak relevan

  const [[{ cnt }]] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.is_superadmin = 1 AND u.is_active = 1 AND u.id != ?`,
    [userId]
  );
  if (Number(cnt) === 0) {
    throw new HttpError(
      409,
      'last_superadmin',
      'Tidak bisa menonaktifkan superadmin terakhir — minimal harus ada 1 akun superadmin aktif di sistem.'
    );
  }
}

module.exports = { assertNotLastSuperadmin };
