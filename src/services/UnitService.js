const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

async function listUnits() {
  const [rows] = await pool.query(`SELECT id, name FROM units ORDER BY name`);
  return rows;
}

async function createUnit({ name }) {
  if (!name || !name.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama satuan wajib diisi');
  }
  const id = uuidv4();
  try {
    await pool.query(`INSERT INTO units (id, name) VALUES (?, ?)`, [id, name.trim()]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'duplicate_unit', `Satuan "${name.trim()}" sudah ada`);
    }
    throw err;
  }
  return { id, name: name.trim() };
}

async function updateUnit(id, { name }) {
  const [[existing]] = await pool.query(`SELECT * FROM units WHERE id = ?`, [id]);
  if (!existing) {
    throw new HttpError(404, 'unit_not_found', 'Satuan tidak ditemukan');
  }
  if (!name || !name.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama satuan wajib diisi');
  }
  await pool.query(`UPDATE units SET name = ? WHERE id = ?`, [name.trim(), id]);
  return { id, name: name.trim() };
}

module.exports = { listUnits, createUnit, updateUnit };
