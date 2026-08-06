const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

async function listPriceLevels() {
  const [rows] = await pool.query(`SELECT id, name, markup_percent FROM price_levels ORDER BY name`);
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

// markupPercent: number|null. null = "belum diatur", PricingEngineService
// akan melewati level ini sepenuhnya sampai diisi angka.
async function updatePriceLevel(id, { markupPercent }) {
  const [[existing]] = await pool.query(`SELECT id FROM price_levels WHERE id = ?`, [id]);
  if (!existing) {
    throw new HttpError(404, 'price_level_not_found', 'Level harga tidak ditemukan');
  }
  if (markupPercent !== null && markupPercent !== undefined && Number(markupPercent) < 0) {
    throw new HttpError(400, 'bad_request', 'Markup% tidak boleh negatif');
  }
  await pool.query(
    `UPDATE price_levels SET markup_percent = ? WHERE id = ?`,
    [markupPercent === null || markupPercent === undefined ? null : markupPercent, id]
  );
  const [[updated]] = await pool.query(`SELECT id, name, markup_percent FROM price_levels WHERE id = ?`, [id]);
  return updated;
}

module.exports = { listPriceLevels, createPriceLevel, updatePriceLevel };
