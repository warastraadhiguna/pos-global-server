const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

async function listPriceLevels() {
  const [rows] = await pool.query(`SELECT id, name FROM price_levels ORDER BY name`);
  return rows;
}

async function createPriceLevel({ name }) {
  if (!name || !name.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama level harga wajib diisi');
  }
  const id = uuidv4();
  try {
    await pool.query(`INSERT INTO price_levels (id, name) VALUES (?, ?)`, [id, name.trim()]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'duplicate_price_level', `Level harga "${name.trim()}" sudah ada`);
    }
    throw err;
  }
  return { id, name: name.trim() };
}

module.exports = { listPriceLevels, createPriceLevel };
