const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

// 1 gudang dulu utk MVP (Bagian 4), tapi jangan hardcode UUID-nya —
// query gudang aktif yang ada supaya struktur tetap siap utk multi gudang nanti.
async function getDefaultWarehouseId(conn = pool) {
  const [rows] = await conn.query(
    `SELECT id FROM warehouses WHERE branch_id = 1 AND is_active = 1 ORDER BY created_at ASC LIMIT 1`
  );
  if (!rows[0]) {
    throw new HttpError(500, 'no_warehouse', 'Belum ada gudang aktif terdaftar');
  }
  return rows[0].id;
}

module.exports = { getDefaultWarehouseId };
