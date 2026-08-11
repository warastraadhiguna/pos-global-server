const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'unauthorized', 'Token tidak ditemukan'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, role, branchId, ... }
    next();
  } catch (err) {
    next(new HttpError(401, 'unauthorized', 'Token tidak valid atau kedaluwarsa'));
  }
}

// Batasi route hanya untuk role tertentu, mis. requireRole('admin'). Dipakai
// buat gate yang genuinely role-literal (bukan berbasis izin per modul) —
// sebagian besar route SEKARANG pakai requirePermission di bawah,
// requireRole tetap diekspor kalau ada kebutuhan gate role-spesifik murni.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(new HttpError(403, 'forbidden', 'Tidak punya akses untuk aksi ini'));
    }
    next();
  };
}

// RBAC — satu-satunya jalur pengecekan izin per modul+aksi (mis.
// requirePermission('accounting', 'view')). Dicek LANGSUNG ke database tiap
// request (bukan dari snapshot izin di JWT) — supaya pencabutan izin lewat
// halaman kelola-role (Part B) langsung berlaku, tidak perlu tunggu token
// lama expire/re-login. role_id dicari ulang dari nama role di token (bukan
// dipercaya dari token), row role selalu ada (FK terjamin) tapi kalau nama
// role di token sudah tidak ada lagi (mis. role dihapus setelah token
// terbit), `role` jadi null -> ditolak, bukan dianggap error server.
//
// Superadmin BYPASS total (roles.is_superadmin=1) — lihat catatan schema.sql
// soal kenapa ini flag terpisah, bukan baris role_permissions.
//
// Default TERTUTUP: kalau kombinasi module+action yang diminta tidak
// terdaftar sama sekali di tabel permissions (mis. fitur baru yang lupa
// didaftarkan), EXISTS di bawah otomatis false utk SEMUA role non-
// superadmin — sama seperti role yang memang tidak diberi izin itu. Tidak
// ada jalur "izinkan kalau tidak dikenali".
function requirePermission(module, action) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next(new HttpError(401, 'unauthorized', 'Token tidak ditemukan'));
      }

      const [[role]] = await pool.query(
        `SELECT r.is_superadmin,
                EXISTS (
                  SELECT 1 FROM role_permissions rp
                  JOIN permissions p ON p.id = rp.permission_id
                  WHERE rp.role_id = r.id AND p.module = ? AND p.action = ?
                ) AS has_permission
         FROM roles r
         WHERE r.name = ?`,
        [module, action, req.user.role]
      );

      if (!role || (!role.is_superadmin && !role.has_permission)) {
        return next(new HttpError(403, 'forbidden', `Tidak punya izin '${action}' untuk modul '${module}'`));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requireRole, requirePermission };
