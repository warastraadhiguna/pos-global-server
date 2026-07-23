const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

// Dipakai kasir — cuma yang aktif, urut sort_order lalu amount.
async function listActiveDenominations() {
  const [rows] = await pool.query(
    `SELECT id, amount, sort_order FROM cash_denominations WHERE is_active = 1 ORDER BY sort_order ASC, amount ASC`
  );
  return rows;
}

// Dipakai admin — semua, termasuk yang nonaktif.
async function listAllDenominations() {
  const [rows] = await pool.query(
    `SELECT id, amount, is_active, sort_order FROM cash_denominations ORDER BY sort_order ASC, amount ASC`
  );
  return rows;
}

async function createDenomination({ amount, sortOrder }) {
  if (!amount || Number(amount) <= 0) {
    throw new HttpError(400, 'bad_request', 'amount harus > 0');
  }
  const id = uuidv4();
  await pool.query(
    `INSERT INTO cash_denominations (id, amount, sort_order) VALUES (?, ?, ?)`,
    [id, amount, sortOrder || 0]
  );
  return { id, amount, is_active: 1, sort_order: sortOrder || 0 };
}

async function updateDenomination(id, { amount, isActive, sortOrder }) {
  const [[existing]] = await pool.query(`SELECT * FROM cash_denominations WHERE id = ?`, [id]);
  if (!existing) {
    throw new HttpError(404, 'denomination_not_found', 'Pecahan uang tidak ditemukan');
  }
  const newAmount = amount !== undefined && amount !== null ? amount : existing.amount;
  const newIsActive = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;
  const newSortOrder = sortOrder !== undefined ? sortOrder : existing.sort_order;
  if (Number(newAmount) <= 0) {
    throw new HttpError(400, 'bad_request', 'amount harus > 0');
  }
  await pool.query(
    `UPDATE cash_denominations SET amount = ?, is_active = ?, sort_order = ? WHERE id = ?`,
    [newAmount, newIsActive, newSortOrder, id]
  );
  return { id, amount: newAmount, is_active: newIsActive, sort_order: newSortOrder };
}

module.exports = { listActiveDenominations, listAllDenominations, createDenomination, updateDenomination };
