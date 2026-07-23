const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { logActivity } = require('./AuthService');

const BRANCH_ID = 1;

// Cash in/out di luar penjualan (mis. setor ke brankas, ambil kembalian dari
// kasir lain, dsb). Wajib alasan supaya bisa direkonsiliasi saat tutup shift.
async function recordCashMovement({ shiftId, userId, movementType, amount, reason }) {
  if (!['cash_in', 'cash_out'].includes(movementType)) {
    throw new HttpError(400, 'bad_request', "movementType harus 'cash_in' atau 'cash_out'");
  }
  if (!amount || amount <= 0) {
    throw new HttpError(400, 'bad_request', 'amount harus > 0');
  }
  if (!reason || !reason.trim()) {
    throw new HttpError(400, 'bad_request', 'Alasan wajib diisi');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[shift]] = await conn.query(`SELECT * FROM cashier_shifts WHERE id = ? FOR UPDATE`, [shiftId]);
    if (!shift || shift.user_id !== userId || shift.status !== 'open') {
      throw new HttpError(409, 'shift_not_open', 'Shift kasir tidak aktif untuk user ini');
    }

    const movementId = uuidv4();
    await conn.query(
      `INSERT INTO cash_movements (id, branch_id, cashier_shift_id, movement_type, amount, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [movementId, BRANCH_ID, shiftId, movementType, amount, reason.trim(), userId]
    );

    await logActivity(conn, {
      userId,
      action: movementType === 'cash_in' ? 'cash_in' : 'cash_out',
      entityType: 'cash_movement',
      entityUuid: movementId,
      description: `${movementType === 'cash_in' ? 'Kas masuk' : 'Kas keluar'} Rp${amount}: ${reason.trim()}`,
    });

    await conn.commit();
    return { id: movementId, shiftId, movementType, amount, reason: reason.trim() };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function listCashMovements(shiftId) {
  const [rows] = await pool.query(
    `SELECT id, movement_type, amount, reason, created_at FROM cash_movements
     WHERE cashier_shift_id = ? ORDER BY created_at ASC`,
    [shiftId]
  );
  return rows;
}

module.exports = { recordCashMovement, listCashMovements };
