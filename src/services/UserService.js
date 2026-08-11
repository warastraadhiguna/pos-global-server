// CRUD user (admin & kasir) — dipakai admin panel. Endpoint login (AuthService)
// tetap terpisah. Password/PIN hash TIDAK PERNAH dikembalikan ke client,
// cuma boolean has_password/has_pin.
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { logActivity } = require('./AuthService');
const { assertNotLastSuperadmin } = require('./RoleService');

const BRANCH_ID = 1;
const PIN_REGEX = /^\d{4,6}$/;

async function listUsers() {
  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.is_active, u.role_id, r.name AS role, r.is_superadmin,
            (u.password_hash IS NOT NULL) AS has_password,
            (u.pin_hash IS NOT NULL) AS has_pin
     FROM users u JOIN roles r ON r.id = u.role_id
     ORDER BY r.name, u.full_name`
  );
  return rows;
}

async function getRoleId(roleName) {
  const [[role]] = await pool.query(`SELECT id FROM roles WHERE name = ?`, [roleName]);
  if (!role) {
    throw new HttpError(500, 'role_not_found', `Role "${roleName}" tidak ditemukan`);
  }
  return role.id;
}

async function createUser({ role, fullName, username, password, pin }, actorUserId) {
  if (!fullName || !fullName.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama lengkap wajib diisi');
  }
  if (!['admin', 'kasir'].includes(role)) {
    throw new HttpError(400, 'bad_request', "role harus 'admin' atau 'kasir'");
  }

  const roleId = await getRoleId(role);
  const id = uuidv4();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    if (role === 'admin') {
      if (!username || !username.trim()) {
        throw new HttpError(400, 'bad_request', 'Username wajib diisi untuk role admin');
      }
      if (!password || password.length < 6) {
        throw new HttpError(400, 'bad_request', 'Password minimal 6 karakter');
      }
      const passwordHash = await bcrypt.hash(password, 10);
      try {
        await conn.query(
          `INSERT INTO users (id, branch_id, role_id, username, full_name, password_hash, is_active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [id, BRANCH_ID, roleId, username.trim(), fullName.trim(), passwordHash]
        );
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          throw new HttpError(409, 'duplicate_username', `Username "${username.trim()}" sudah dipakai`);
        }
        throw err;
      }
    } else {
      if (!pin || !PIN_REGEX.test(pin)) {
        throw new HttpError(400, 'bad_request', 'PIN harus 4-6 digit angka');
      }
      const pinHash = await bcrypt.hash(pin, 10);
      await conn.query(
        `INSERT INTO users (id, branch_id, role_id, username, full_name, pin_hash, is_active)
         VALUES (?, ?, ?, NULL, ?, ?, 1)`,
        [id, BRANCH_ID, roleId, fullName.trim(), pinHash]
      );
    }

    await logActivity(conn, {
      userId: actorUserId,
      action: 'user_created',
      entityType: 'user',
      entityUuid: id,
      description: `Buat user baru: ${fullName.trim()} (${role})`,
    });

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return { id, fullName: fullName.trim(), role };
}

async function updateUser(id, { fullName, isActive, password, pin }, actorUserId) {
  const [[existing]] = await pool.query(
    `SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [id]
  );
  if (!existing) {
    throw new HttpError(404, 'user_not_found', 'User tidak ditemukan');
  }

  const newFullName = fullName !== undefined && fullName.trim() ? fullName.trim() : existing.full_name;
  const newIsActive = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Superadmin terakhir tidak boleh dinonaktifkan — cegah sistem terkunci
    // total (tidak ada satu pun akun yang bisa kelola role/izin lagi).
    if (newIsActive === 0 && existing.is_active === 1) {
      await assertNotLastSuperadmin(conn, id);
    }

    await conn.query(`UPDATE users SET full_name = ?, is_active = ? WHERE id = ?`, [newFullName, newIsActive, id]);

    if (password) {
      if (existing.role_name !== 'admin') {
        throw new HttpError(400, 'bad_request', 'Password cuma berlaku untuk role admin');
      }
      if (password.length < 6) {
        throw new HttpError(400, 'bad_request', 'Password minimal 6 karakter');
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await conn.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, id]);
      await logActivity(conn, {
        userId: actorUserId,
        action: 'reset_password',
        entityType: 'user',
        entityUuid: id,
        description: `Reset password untuk ${newFullName}`,
      });
    }

    if (pin) {
      if (existing.role_name !== 'kasir') {
        throw new HttpError(400, 'bad_request', 'PIN cuma berlaku untuk role kasir');
      }
      if (!PIN_REGEX.test(pin)) {
        throw new HttpError(400, 'bad_request', 'PIN harus 4-6 digit angka');
      }
      const pinHash = await bcrypt.hash(pin, 10);
      await conn.query(`UPDATE users SET pin_hash = ? WHERE id = ?`, [pinHash, id]);
      await logActivity(conn, {
        userId: actorUserId,
        action: 'reset_pin',
        entityType: 'user',
        entityUuid: id,
        description: `Reset PIN untuk ${newFullName}`,
      });
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return { id, fullName: newFullName, isActive: newIsActive };
}

// Pindahkan user ke role LAIN (RBAC Part B) — endpoint TERPISAH dari
// updateUser di atas, sengaja digerbang izin 'roles.manage' (bukan
// 'users.edit') karena mengubah SIAPA PUNYA WEWENANG APA lebih sensitif
// daripada sekadar ubah nama/nonaktifkan/reset kredensial. Kredensial
// (password/PIN) yang SUDAH ADA di user TIDAK ikut diubah/dihapus otomatis
// saat pindah role — kalau role baru butuh jenis kredensial beda dan belum
// ada, admin harus set eksplisit lewat "Reset Password"/"Reset PIN" (bukan
// digenerate diam-diam, supaya tidak ada password/PIN yang tidak diketahui
// siapa pun).
async function updateUserRole(id, { roleId }, actorUserId) {
  if (!roleId) {
    throw new HttpError(400, 'bad_request', 'roleId wajib diisi');
  }

  const [[existing]] = await pool.query(
    `SELECT u.*, r.name AS role_name, r.is_superadmin FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [id]
  );
  if (!existing) {
    throw new HttpError(404, 'user_not_found', 'User tidak ditemukan');
  }

  const [[newRole]] = await pool.query(`SELECT * FROM roles WHERE id = ?`, [roleId]);
  if (!newRole) {
    throw new HttpError(400, 'bad_request', 'Role tujuan tidak ditemukan');
  }

  if (existing.role_id === roleId) {
    return { id, role: newRole.name }; // tidak ada perubahan
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Superadmin terakhir tidak boleh dipindah ke role lain — guard sama
    // persis dgn nonaktifkan (assertNotLastSuperadmin), supaya sistem
    // tidak pernah terkunci total dari kelola role/izin.
    if (existing.is_superadmin) {
      await assertNotLastSuperadmin(conn, id);
    }

    await conn.query(`UPDATE users SET role_id = ? WHERE id = ?`, [roleId, id]);

    await logActivity(conn, {
      userId: actorUserId,
      action: 'user_role_changed',
      entityType: 'user',
      entityUuid: id,
      description: `Ubah role ${existing.full_name}: "${existing.role_name}" -> "${newRole.name}"`,
    });

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return { id, role: newRole.name };
}

module.exports = { listUsers, createUser, updateUser, updateUserRole };
