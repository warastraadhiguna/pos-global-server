const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

// Verifikasi tanda tangan JWT SAJA tidak cukup — token yang sudah ditandatangani
// sah tapi user_id-nya sudah tidak ada lagi di DB (mis. akun dihapus permanen
// lewat fitur Hapus, atau — di lingkungan dev — DB di-reset/reseed sehingga
// semua UUID berganti) tetap lolos verifikasi tanda tangan. Tanpa cek ini,
// request lanjut sampai ke logic yang pakai req.user.id sebagai FK (mis.
// logActivity) dan baru gagal di situ dgn error MySQL mentah yang
// membingungkan. Query ini menolaknya lebih awal dgn pesan yang jelas —
// sekalian menutup akun yang dinonaktifkan supaya sesi lamanya juga langsung
// tidak berlaku, bukan cuma mencegah login baru.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'unauthorized', 'Token tidak ditemukan'));
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return next(new HttpError(401, 'unauthorized', 'Token tidak valid atau kedaluwarsa'));
  }

  try {
    const [[user]] = await pool.query(`SELECT id FROM users WHERE id = ? AND is_active = 1`, [payload.id]);
    if (!user) {
      return next(new HttpError(401, 'session_invalid', 'Sesi tidak valid — akun tidak ditemukan atau sudah dinonaktifkan, silakan login ulang'));
    }
  } catch (err) {
    return next(err);
  }

  req.user = payload; // { id, role, branchId, ... }
  next();
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
