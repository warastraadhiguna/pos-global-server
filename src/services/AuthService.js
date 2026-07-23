const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1; // hardcode MVP 1 cabang (Bagian 5 poin 3) — jangan diasumsikan single-tenant di logic lain

// Lockout percobaan gagal — dapat disesuaikan lewat .env tanpa ubah kode.
const MAX_FAILED_ATTEMPTS = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS) || 5;
const LOCKOUT_MINUTES = Number(process.env.AUTH_LOCKOUT_MINUTES) || 15;

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, branchId: BRANCH_ID, fullName: user.full_name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
}

async function logActivity(conn, { userId, action, entityType = null, entityUuid = null, description = null }) {
  await conn.query(
    `INSERT INTO activity_logs (id, branch_id, user_id, action, entity_type, entity_uuid, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), BRANCH_ID, userId, action, entityType, entityUuid, description]
  );
}

function assertNotLocked(user) {
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    throw new HttpError(
      423,
      'account_locked',
      `Akun terkunci sementara karena terlalu banyak percobaan gagal. Coba lagi dalam ${minutesLeft} menit.`
    );
  }
}

// Dipanggil setelah verifikasi credential gagal. Menambah counter, mengunci
// akun kalau sudah mencapai batas, dan mencatat ke activity_logs.
async function registerFailedAttempt(user, loginType) {
  const conn = await pool.getConnection();
  try {
    const attempts = user.failed_login_attempts + 1;
    const willLock = attempts >= MAX_FAILED_ATTEMPTS;
    const lockedUntil = willLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null;

    await conn.query(
      `UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?`,
      [willLock ? 0 : attempts, lockedUntil, user.id]
    );

    if (willLock) {
      await logActivity(conn, {
        userId: user.id,
        action: 'login_locked',
        description: `Akun dikunci ${LOCKOUT_MINUTES} menit setelah ${MAX_FAILED_ATTEMPTS} percobaan ${loginType} gagal beruntun`,
      });
    }
  } finally {
    conn.release();
  }
}

async function resetFailedAttempts(conn, userId) {
  await conn.query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?`, [userId]);
}

// Login admin: username + password
async function loginAdmin(username, password) {
  const [rows] = await pool.query(
    `SELECT u.*, r.name AS role_name FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.username = ? AND u.is_active = 1 LIMIT 1`,
    [username]
  );
  const user = rows[0];
  if (!user || !user.password_hash) {
    throw new HttpError(401, 'invalid_credentials', 'Username atau password salah');
  }

  assertNotLocked(user);

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    await registerFailedAttempt(user, 'password');
    throw new HttpError(401, 'invalid_credentials', 'Username atau password salah');
  }

  const authUser = { id: user.id, role: user.role_name, full_name: user.full_name };
  const conn = await pool.getConnection();
  try {
    await resetFailedAttempts(conn, user.id);
    await logActivity(conn, { userId: user.id, action: 'login', description: `Login admin: ${user.username}` });
  } finally {
    conn.release();
  }

  return { token: signToken(authUser), user: authUser };
}

// Daftar kasir aktif untuk ditampilkan di layar pilih-kasir sebelum input PIN
async function listActiveCashiers() {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'kasir' AND u.is_active = 1
     ORDER BY u.full_name`
  );
  return rows;
}

// Login kasir: pilih user dari daftar kasir, lalu input PIN
async function loginCashierWithPin(userId, pin) {
  const [rows] = await pool.query(
    `SELECT u.*, r.name AS role_name FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND r.name = 'kasir' AND u.is_active = 1 LIMIT 1`,
    [userId]
  );
  const user = rows[0];
  if (!user || !user.pin_hash) {
    throw new HttpError(401, 'invalid_credentials', 'PIN salah');
  }

  assertNotLocked(user);

  const valid = await bcrypt.compare(pin, user.pin_hash);
  if (!valid) {
    await registerFailedAttempt(user, 'PIN');
    throw new HttpError(401, 'invalid_credentials', 'PIN salah');
  }

  const authUser = { id: user.id, role: user.role_name, full_name: user.full_name };
  const conn = await pool.getConnection();
  try {
    await resetFailedAttempts(conn, user.id);
    await logActivity(conn, { userId: user.id, action: 'login', description: `Login kasir: ${user.full_name}` });
  } finally {
    conn.release();
  }

  return { token: signToken(authUser), user: authUser };
}

module.exports = { loginAdmin, listActiveCashiers, loginCashierWithPin, logActivity, BRANCH_ID };
