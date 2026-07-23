const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

// Ambil tier harga yang berlaku: unit + level harga sama, min_qty_base
// tertinggi yang masih <= quantityBase (mis. harga grosir per dos berlaku
// mulai qty tertentu).
async function resolvePrice({ productId, unitId, priceLevelId, quantityBase }, conn = pool) {
  const [rows] = await conn.query(
    `SELECT price FROM product_prices
     WHERE product_id = ? AND unit_id = ? AND price_level_id = ? AND min_qty_base <= ?
     ORDER BY min_qty_base DESC LIMIT 1`,
    [productId, unitId, priceLevelId, quantityBase]
  );
  if (!rows[0]) {
    throw new HttpError(404, 'price_not_found', 'Harga untuk kombinasi produk/satuan/level ini belum diatur');
  }
  return rows[0].price;
}

module.exports = { resolvePrice };
