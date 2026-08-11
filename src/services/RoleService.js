// RBAC — layanan role/izin. Part A: guard "superadmin tidak boleh mengunci
// diri sendiri". Part B: CRUD role & assign izin lengkap (dipakai UI
// superadmin kelola role). Lanjutan: flag can_login_pos (role kustom
// bertipe kasir bisa login PIN di mesin kasir).
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { logActivity } = require('./AuthService');

// Cakupan MAKSIMAL izin yang boleh dipegang role dgn can_login_pos=1 —
// persis wewenang role 'kasir' bawaan (lihat seed.js KASIR_GRANTS, yang
// diturunkan dari daftar ini supaya satu sumber kebenaran). Role senior/
// junior boleh beda-beda DI DALAM cakupan ini (mis. junior tanpa
// sales.void), tapi tidak boleh punya izin di luar cakupan ini (mis.
// users.*, roles.*, accounting.*, purchases.*) — itulah yang mencegah
// role dgn wewenang back-office dipakai login PIN kasir, walau sengaja
// dicentang.
const POS_ALLOWED_PERMISSIONS = [
  ['products', 'view'],
  ['categories', 'view'],
  ['units', 'view'],
  ['price_levels', 'view'],
  ['payment_methods', 'view'],
  ['cash_denominations', 'view'],
  ['store_settings', 'view'],
  ['sales', 'view'],
  ['sales', 'create'],
  ['sales', 'void'],
  ['sale_drafts', 'view'],
  ['sale_drafts', 'create'],
  ['sale_drafts', 'delete'],
  ['shifts', 'view'],
  ['shifts', 'manage'],
];

function isWithinPosEnvelope(module, action) {
  return POS_ALLOWED_PERMISSIONS.some(([m, a]) => m === module && a === action);
}

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

// Daftar role + ringkasan (dipakai layar kelola role & dropdown assign role
// di layar user).
async function listRoles() {
  const [rows] = await pool.query(
    `SELECT r.id, r.name, r.is_superadmin,
            (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
     FROM roles r
     ORDER BY r.is_superadmin DESC, r.name ASC`
  );
  return rows;
}

// Katalog lengkap modul+aksi yang BISA diberikan — dipakai render matriks
// centang (kolom aksi, dikelompokkan per modul di frontend).
async function getPermissionsCatalog() {
  const [rows] = await pool.query(
    `SELECT id, module, action, description, is_sensitive FROM permissions ORDER BY module ASC, action ASC`
  );
  return rows;
}

// permission_id yang SEDANG diberikan ke suatu role (kosong utk superadmin
// — lihat catatan schema.sql, aksesnya lewat bypass bukan daftar izin).
async function getRolePermissionIds(roleId) {
  const [rows] = await pool.query(`SELECT permission_id FROM role_permissions WHERE role_id = ?`, [roleId]);
  return rows.map((r) => r.permission_id);
}

async function getRoleOrThrow(roleId) {
  const [[role]] = await pool.query(`SELECT * FROM roles WHERE id = ?`, [roleId]);
  if (!role) throw new HttpError(404, 'role_not_found', 'Role tidak ditemukan');
  return role;
}

// Role BARU dibuat SUPERADMIN — is_superadmin SELALU 0, tidak pernah bisa
// diset lewat sini (lihat catatan schema.sql: cuma 1 role is_superadmin=1,
// dari seed, tidak pernah dari endpoint).
async function createRole({ name }, actorUserId) {
  if (!name || !name.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama role wajib diisi');
  }
  const trimmed = name.trim();
  if (['superadmin', 'admin', 'kasir'].includes(trimmed.toLowerCase())) {
    throw new HttpError(400, 'bad_request', `Nama "${trimmed}" dipakai role bawaan, pakai nama lain`);
  }

  const id = uuidv4();
  try {
    await pool.query(`INSERT INTO roles (id, name, is_superadmin) VALUES (?, ?, 0)`, [id, trimmed]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'duplicate_role', `Role "${trimmed}" sudah ada`);
    }
    throw err;
  }

  await logActivity(pool, {
    userId: actorUserId,
    action: 'role_created',
    entityType: 'role',
    entityUuid: id,
    description: `Buat role baru: ${trimmed}`,
  });

  return getRoleOrThrow(id);
}

async function updateRoleName(roleId, { name }, actorUserId) {
  const role = await getRoleOrThrow(roleId);
  if (role.is_superadmin) {
    throw new HttpError(400, 'bad_request', 'Role superadmin tidak bisa diubah namanya');
  }
  if (!name || !name.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama role wajib diisi');
  }
  const trimmed = name.trim();
  if (['superadmin', 'admin', 'kasir'].includes(trimmed.toLowerCase()) && trimmed.toLowerCase() !== role.name.toLowerCase()) {
    throw new HttpError(400, 'bad_request', `Nama "${trimmed}" dipakai role bawaan, pakai nama lain`);
  }

  try {
    await pool.query(`UPDATE roles SET name = ? WHERE id = ?`, [trimmed, roleId]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'duplicate_role', `Role "${trimmed}" sudah ada`);
    }
    throw err;
  }

  await logActivity(pool, {
    userId: actorUserId,
    action: 'role_renamed',
    entityType: 'role',
    entityUuid: roleId,
    description: `Ganti nama role "${role.name}" -> "${trimmed}"`,
  });

  return getRoleOrThrow(roleId);
}

// Ganti SELURUH set izin suatu role (bukan partial-toggle satu-satu) —
// UI kirim daftar permissionId lengkap yang harus jadi status akhir,
// di sini dihitung selisihnya (ditambah/dicabut) cuma utk keperluan LOG,
// bukan utk logic (logic-nya selalu "hapus semua, insert ulang yang baru"
// dalam satu transaksi supaya tidak ada baris nyangkut kalau request
// terputus di tengah).
async function updateRolePermissions(roleId, permissionIds, actorUserId) {
  const role = await getRoleOrThrow(roleId);
  if (role.is_superadmin) {
    throw new HttpError(400, 'bad_request', 'Role superadmin sudah otomatis dapat semua akses, tidak perlu (dan tidak bisa) diatur manual');
  }
  if (!Array.isArray(permissionIds)) {
    throw new HttpError(400, 'bad_request', 'permissionIds wajib berupa array');
  }

  const [validRows] = await pool.query(`SELECT id, module, action FROM permissions WHERE id IN (?)`, [
    permissionIds.length > 0 ? permissionIds : [''],
  ]);
  const validIds = new Set(validRows.map((r) => r.id));
  const invalid = permissionIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new HttpError(400, 'bad_request', `permissionId tidak dikenal: ${invalid.join(', ')}`);
  }

  const currentIds = new Set(await getRolePermissionIds(roleId));
  const newIds = new Set(permissionIds);
  const added = validRows.filter((r) => newIds.has(r.id) && !currentIds.has(r.id));
  const removed = [];
  if (currentIds.size > 0) {
    const [currentRows] = await pool.query(`SELECT id, module, action FROM permissions WHERE id IN (?)`, [[...currentIds]]);
    removed.push(...currentRows.filter((r) => !newIds.has(r.id)));
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM role_permissions WHERE role_id = ?`, [roleId]);
    for (const permissionId of newIds) {
      await conn.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)`, [roleId, permissionId]);
    }

    const addedDesc = added.map((p) => `+${p.module}.${p.action}`).join(', ');
    const removedDesc = removed.map((p) => `-${p.module}.${p.action}`).join(', ');
    const changeDesc = [addedDesc, removedDesc].filter(Boolean).join('; ') || '(tidak ada perubahan)';
    await logActivity(conn, {
      userId: actorUserId,
      action: 'role_permissions_updated',
      entityType: 'role',
      entityUuid: roleId,
      description: `Ubah izin role "${role.name}": ${changeDesc}`,
    });

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return getRoleOrThrow(roleId);
}

async function deleteRole(roleId, actorUserId) {
  const role = await getRoleOrThrow(roleId);
  if (role.is_superadmin) {
    throw new HttpError(400, 'bad_request', 'Role superadmin tidak bisa dihapus');
  }

  const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE role_id = ?`, [roleId]);
  if (Number(cnt) > 0) {
    throw new HttpError(
      409,
      'role_in_use',
      `Role "${role.name}" masih dipakai ${cnt} user — pindahkan dulu user itu ke role lain sebelum menghapus role ini`
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM role_permissions WHERE role_id = ?`, [roleId]);
    await conn.query(`DELETE FROM roles WHERE id = ?`, [roleId]);
    await logActivity(conn, {
      userId: actorUserId,
      action: 'role_deleted',
      entityType: 'role',
      entityUuid: roleId,
      description: `Hapus role: ${role.name}`,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  POS_ALLOWED_PERMISSIONS,
  assertNotLastSuperadmin,
  listRoles,
  getPermissionsCatalog,
  getRolePermissionIds,
  createRole,
  updateRoleName,
  updateRolePermissions,
  deleteRole,
};
