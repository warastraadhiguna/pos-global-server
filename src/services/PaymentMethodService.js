const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

// Dipakai kasir — cuma yang aktif, urut sort_order.
async function listActiveMethods() {
  const [rows] = await pool.query(
    `SELECT id, name, is_cash, sort_order FROM payment_methods WHERE is_active = 1 ORDER BY sort_order ASC, name ASC`
  );
  return rows;
}

// Dipakai admin — semua, termasuk yang nonaktif.
async function listAllMethods() {
  const [rows] = await pool.query(
    `SELECT id, name, is_cash, is_active, sort_order FROM payment_methods ORDER BY sort_order ASC, name ASC`
  );
  return rows;
}

async function getActiveMethodById(id) {
  const [[row]] = await pool.query(
    `SELECT id, name, is_cash, is_active FROM payment_methods WHERE id = ?`,
    [id]
  );
  if (!row || !row.is_active) {
    throw new HttpError(400, 'invalid_payment_method', 'Metode pembayaran tidak valid atau sudah nonaktif');
  }
  return row;
}

async function createMethod({ name, isCash, sortOrder }) {
  if (!name || !name.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama metode pembayaran wajib diisi');
  }
  const id = uuidv4();
  await pool.query(
    `INSERT INTO payment_methods (id, name, is_cash, sort_order) VALUES (?, ?, ?, ?)`,
    [id, name.trim(), isCash ? 1 : 0, sortOrder || 0]
  );
  return { id, name: name.trim(), is_cash: isCash ? 1 : 0, is_active: 1, sort_order: sortOrder || 0 };
}

async function updateMethod(id, { name, isCash, isActive, sortOrder }) {
  const [[existing]] = await pool.query(`SELECT * FROM payment_methods WHERE id = ?`, [id]);
  if (!existing) {
    throw new HttpError(404, 'payment_method_not_found', 'Metode pembayaran tidak ditemukan');
  }
  const newName = name !== undefined && name.trim() ? name.trim() : existing.name;
  const newIsCash = isCash !== undefined ? (isCash ? 1 : 0) : existing.is_cash;
  const newIsActive = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;
  const newSortOrder = sortOrder !== undefined ? sortOrder : existing.sort_order;
  await pool.query(
    `UPDATE payment_methods SET name = ?, is_cash = ?, is_active = ?, sort_order = ? WHERE id = ?`,
    [newName, newIsCash, newIsActive, newSortOrder, id]
  );
  return { id, name: newName, is_cash: newIsCash, is_active: newIsActive, sort_order: newSortOrder };
}

module.exports = { listActiveMethods, listAllMethods, getActiveMethodById, createMethod, updateMethod };
