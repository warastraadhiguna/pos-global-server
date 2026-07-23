const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { logActivity } = require('./AuthService');

const BRANCH_ID = 1;

async function getOpenShiftForUser(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM cashier_shifts WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function openShift(userId, openingCash) {
  const existing = await getOpenShiftForUser(userId);
  if (existing) {
    throw new HttpError(409, 'shift_already_open', 'Kasir ini sudah punya shift yang terbuka');
  }

  const shiftId = uuidv4();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO cashier_shifts (id, branch_id, user_id, opening_cash, opened_at, status)
       VALUES (?, ?, ?, ?, NOW(), 'open')`,
      [shiftId, BRANCH_ID, userId, openingCash]
    );
    await logActivity(conn, {
      userId,
      action: 'shift_open',
      entityType: 'cashier_shift',
      entityUuid: shiftId,
      description: `Buka shift dengan kas awal Rp${openingCash}`,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return getOpenShiftForUser(userId);
}

// Kas seharusnya di laci = kas awal + tunai masuk dari penjualan + cash_in - cash_out
async function calculateExpectedCash(shiftId) {
  const [[salesRow]] = await pool.query(
    `SELECT COALESCE(SUM(sp.amount), 0) AS cash_from_sales
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     JOIN payment_methods pm ON pm.id = sp.payment_method_id
     WHERE s.cashier_shift_id = ? AND s.status = 'completed' AND pm.is_cash = 1`,
    [shiftId]
  );
  const [[movementRow]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN movement_type = 'cash_in' THEN amount ELSE 0 END), 0) AS cash_in,
       COALESCE(SUM(CASE WHEN movement_type = 'cash_out' THEN amount ELSE 0 END), 0) AS cash_out
     FROM cash_movements WHERE cashier_shift_id = ?`,
    [shiftId]
  );
  const [[shift]] = await pool.query(`SELECT opening_cash FROM cashier_shifts WHERE id = ?`, [shiftId]);
  if (!shift) {
    throw new HttpError(404, 'shift_not_found', 'Shift tidak ditemukan');
  }

  // SUM() di MySQL mengembalikan BIGINT, yang driver mysql2 kirim sebagai
  // string ke JS (menghindari precision loss). Kalau langsung dijumlah pakai
  // `+` tanpa konversi, itu jadi string concatenation, bukan penjumlahan —
  // makanya wajib lewat Decimal (Bagian 8).
  const expected = new Decimal(shift.opening_cash)
    .plus(salesRow.cash_from_sales)
    .plus(movementRow.cash_in)
    .minus(movementRow.cash_out);

  return Number(expected.toFixed(0));
}

async function closeShift(shiftId, userId, closingCashActual) {
  const [[shift]] = await pool.query(`SELECT * FROM cashier_shifts WHERE id = ?`, [shiftId]);
  if (!shift) {
    throw new HttpError(404, 'shift_not_found', 'Shift tidak ditemukan');
  }
  if (shift.status !== 'open') {
    throw new HttpError(409, 'shift_already_closed', 'Shift ini sudah ditutup');
  }
  if (shift.user_id !== userId) {
    throw new HttpError(403, 'forbidden', 'Bukan shift milik kasir ini');
  }

  const expectedCash = await calculateExpectedCash(shiftId);
  const difference = closingCashActual - expectedCash;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE cashier_shifts
       SET closing_cash_expected = ?, closing_cash_actual = ?, cash_difference = ?, closed_at = NOW(), status = 'closed'
       WHERE id = ?`,
      [expectedCash, closingCashActual, difference, shiftId]
    );
    await logActivity(conn, {
      userId,
      action: 'shift_close',
      entityType: 'cashier_shift',
      entityUuid: shiftId,
      description: `Tutup shift. Kas sistem Rp${expectedCash}, kas fisik Rp${closingCashActual}, selisih Rp${difference}`,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const [[updated]] = await pool.query(`SELECT * FROM cashier_shifts WHERE id = ?`, [shiftId]);
  return updated;
}

module.exports = { getOpenShiftForUser, openShift, closeShift, calculateExpectedCash };
