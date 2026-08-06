const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { getDefaultWarehouseId } = require('./WarehouseService');

// Ambil detail produk siap pakai POS: produk, satuan yang "kepilih" (dari
// barcode yang di-scan, atau base unit kalau tidak ada preferensi), semua
// satuan yang tersedia (utk switch satuan di kasir), dan semua tier harga.
// Dipakai bareng oleh findByBarcode (scan) dan getForPos (hasil cari nama).
async function getProductPosDetail(productId, preferredUnitId = null) {
  const [productRows] = await pool.query(
    `SELECT id, name, sku, category_id, base_unit_id FROM products WHERE id = ? AND is_active = 1 LIMIT 1`,
    [productId]
  );
  const product = productRows[0];
  if (!product) {
    throw new HttpError(404, 'product_not_found', 'Produk tidak aktif atau tidak ditemukan');
  }

  const [unitRows] = await pool.query(
    `SELECT pu.unit_id, u.name AS unit_name, pu.conversion_factor, pu.is_base_unit
     FROM product_units pu JOIN units u ON u.id = pu.unit_id
     WHERE pu.product_id = ?
     ORDER BY pu.conversion_factor ASC`,
    [product.id]
  );

  const matchedUnit = (preferredUnitId && unitRows.find((u) => u.unit_id === preferredUnitId))
    || unitRows.find((u) => u.is_base_unit)
    || unitRows[0];
  if (!matchedUnit) {
    throw new HttpError(500, 'unit_config_error', 'Produk belum punya satuan yang valid');
  }

  const [priceRows] = await pool.query(
    `SELECT pp.unit_id, pp.price_level_id, pl.name AS price_level_name, pp.min_qty_base, pp.price
     FROM product_prices pp JOIN price_levels pl ON pl.id = pp.price_level_id
     WHERE pp.product_id = ?
     ORDER BY pp.unit_id, pl.name, pp.min_qty_base`,
    [product.id]
  );

  return {
    product,
    matchedUnit,
    units: unitRows,
    prices: priceRows,
  };
}

// Cari produk by barcode (scan).
async function findByBarcode(barcode) {
  const [barcodeRows] = await pool.query(
    `SELECT b.product_id, b.unit_id FROM barcodes b WHERE b.barcode = ? LIMIT 1`,
    [barcode]
  );
  const match = barcodeRows[0];
  if (!match) {
    throw new HttpError(404, 'product_not_found', `Barcode ${barcode} tidak ditemukan`);
  }
  return getProductPosDetail(match.product_id, match.unit_id);
}

// Cari produk by nama (utk popup cari di kasir kalau tidak ada scanner/barcode).
// Hasil ringkas dulu (list), detail lengkap diambil lewat getForPos setelah dipilih.
async function searchByName(query) {
  const trimmed = (query || '').trim();
  if (trimmed.length < 2) {
    return [];
  }
  const [rows] = await pool.query(
    `SELECT p.id, p.name, p.sku, u.name AS base_unit_name
     FROM products p JOIN units u ON u.id = p.base_unit_id
     WHERE p.is_active = 1 AND p.name LIKE ?
     ORDER BY p.name
     LIMIT 20`,
    [`%${trimmed}%`]
  );
  return rows;
}

// Detail lengkap produk (siap ditambah ke keranjang) setelah kasir pilih
// dari hasil cari nama — default ke base unit-nya.
async function getForPos(productId) {
  return getProductPosDetail(productId);
}

// Panel "Lihat Stok" di kasir — read-only, tampil dalam base unit produk
// (satuan stok disimpan/dihitung), tidak perlu breakdown per satuan lain.
async function listProductsWithStock() {
  const warehouseId = await getDefaultWarehouseId();
  const [rows] = await pool.query(
    `SELECT p.id, p.name, p.sku, u.name AS base_unit_name, COALESCE(sb.qty_base, 0) AS qty_base
     FROM products p
     JOIN units u ON u.id = p.base_unit_id
     LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = ?
     WHERE p.is_active = 1
     ORDER BY p.name`,
    [warehouseId]
  );
  return rows;
}

// ============================================================================
// Admin CRUD — dipakai admin panel. findByBarcode di atas tetap dipakai POS.
// ============================================================================

async function listProducts() {
  const [rows] = await pool.query(
    `SELECT p.id, p.sku, p.name, p.is_active, p.category_id, p.base_unit_id,
            c.name AS category_name, u.name AS base_unit_name
     FROM products p
     LEFT JOIN product_categories c ON c.id = p.category_id
     JOIN units u ON u.id = p.base_unit_id
     ORDER BY p.name`
  );
  return rows;
}

async function getProductDetail(productId) {
  const [[product]] = await pool.query(
    `SELECT p.id, p.sku, p.name, p.is_active, p.category_id, p.base_unit_id,
            c.name AS category_name, u.name AS base_unit_name
     FROM products p
     LEFT JOIN product_categories c ON c.id = p.category_id
     JOIN units u ON u.id = p.base_unit_id
     WHERE p.id = ?`,
    [productId]
  );
  if (!product) {
    throw new HttpError(404, 'product_not_found', 'Produk tidak ditemukan');
  }

  const [units] = await pool.query(
    `SELECT pu.unit_id, un.name AS unit_name, pu.conversion_factor, pu.is_base_unit
     FROM product_units pu JOIN units un ON un.id = pu.unit_id
     WHERE pu.product_id = ? ORDER BY pu.conversion_factor ASC`,
    [productId]
  );
  const [barcodes] = await pool.query(
    `SELECT b.id, b.unit_id, un.name AS unit_name, b.barcode
     FROM barcodes b JOIN units un ON un.id = b.unit_id
     WHERE b.product_id = ? ORDER BY b.barcode`,
    [productId]
  );
  const [prices] = await pool.query(
    `SELECT pp.id, pp.unit_id, un.name AS unit_name, pp.price_level_id, pl.name AS price_level_name,
            pp.min_qty_base, pp.price
     FROM product_prices pp
     JOIN units un ON un.id = pp.unit_id
     JOIN price_levels pl ON pl.id = pp.price_level_id
     WHERE pp.product_id = ? ORDER BY un.name, pl.name, pp.min_qty_base`,
    [productId]
  );

  return { product, units, barcodes, prices };
}

// Produk baru otomatis dapat 1 baris product_units utk base unit-nya sendiri
// (conversion_factor=1, is_base_unit=1) — wajib ada supaya bisa langsung
// dipakai transaksi (Bagian 5 poin 8: base unit + konversi).
async function createProduct({ name, sku, categoryId, baseUnitId }) {
  if (!name || !name.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama produk wajib diisi');
  }
  if (!baseUnitId) {
    throw new HttpError(400, 'bad_request', 'Satuan dasar wajib dipilih');
  }

  const productId = uuidv4();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO products (id, category_id, base_unit_id, sku, name, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [productId, categoryId || null, baseUnitId, sku || null, name.trim()]
    );
    await conn.query(
      `INSERT INTO product_units (id, product_id, unit_id, conversion_factor, is_base_unit)
       VALUES (?, ?, ?, 1, 1)`,
      [uuidv4(), productId, baseUnitId]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'duplicate_sku', `SKU "${sku}" sudah dipakai produk lain`);
    }
    throw err;
  } finally {
    conn.release();
  }

  return getProductDetail(productId);
}

// base_unit_id SENGAJA tidak bisa diubah lewat endpoint ini — mengganti base
// unit produk yang sudah punya histori stok/transaksi akan merusak semantik
// stock_balances & HPP (semua dihitung dalam base unit). Kalau salah pilih
// base unit, buat produk baru.
async function updateProduct(productId, { name, sku, categoryId, isActive }) {
  const [[existing]] = await pool.query(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!existing) {
    throw new HttpError(404, 'product_not_found', 'Produk tidak ditemukan');
  }
  const newName = name !== undefined && name.trim() ? name.trim() : existing.name;
  const newSku = sku !== undefined ? (sku || null) : existing.sku;
  const newCategoryId = categoryId !== undefined ? (categoryId || null) : existing.category_id;
  const newIsActive = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;

  try {
    await pool.query(
      `UPDATE products SET name = ?, sku = ?, category_id = ?, is_active = ? WHERE id = ?`,
      [newName, newSku, newCategoryId, newIsActive, productId]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'duplicate_sku', `SKU "${newSku}" sudah dipakai produk lain`);
    }
    throw err;
  }

  return getProductDetail(productId);
}

async function addProductUnit(productId, { unitId, conversionFactor }) {
  if (!unitId || !conversionFactor || Number(conversionFactor) <= 0) {
    throw new HttpError(400, 'bad_request', 'unitId dan conversionFactor (> 0) wajib diisi');
  }
  try {
    await pool.query(
      `INSERT INTO product_units (id, product_id, unit_id, conversion_factor, is_base_unit)
       VALUES (?, ?, ?, ?, 0)`,
      [uuidv4(), productId, unitId, conversionFactor]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'duplicate_unit', 'Produk ini sudah punya satuan tersebut');
    }
    throw err;
  }
  return getProductDetail(productId);
}

async function updateProductUnit(productId, unitId, { conversionFactor }) {
  const [[row]] = await pool.query(
    `SELECT * FROM product_units WHERE product_id = ? AND unit_id = ?`,
    [productId, unitId]
  );
  if (!row) {
    throw new HttpError(404, 'product_unit_not_found', 'Satuan ini belum terdaftar utk produk ini');
  }
  if (row.is_base_unit) {
    throw new HttpError(400, 'bad_request', 'Konversi satuan dasar selalu 1, tidak bisa diubah');
  }
  if (!conversionFactor || Number(conversionFactor) <= 0) {
    throw new HttpError(400, 'bad_request', 'conversionFactor harus > 0');
  }
  await pool.query(
    `UPDATE product_units SET conversion_factor = ? WHERE product_id = ? AND unit_id = ?`,
    [conversionFactor, productId, unitId]
  );
  return getProductDetail(productId);
}

async function deleteProductUnit(productId, unitId) {
  const [[row]] = await pool.query(
    `SELECT * FROM product_units WHERE product_id = ? AND unit_id = ?`,
    [productId, unitId]
  );
  if (!row) {
    throw new HttpError(404, 'product_unit_not_found', 'Satuan ini belum terdaftar utk produk ini');
  }
  if (row.is_base_unit) {
    throw new HttpError(400, 'bad_request', 'Satuan dasar tidak bisa dihapus');
  }
  const [[barcodeUse]] = await pool.query(
    `SELECT COUNT(*) AS n FROM barcodes WHERE product_id = ? AND unit_id = ?`, [productId, unitId]
  );
  const [[priceUse]] = await pool.query(
    `SELECT COUNT(*) AS n FROM product_prices WHERE product_id = ? AND unit_id = ?`, [productId, unitId]
  );
  if (barcodeUse.n > 0 || priceUse.n > 0) {
    throw new HttpError(409, 'unit_in_use', 'Hapus dulu barcode/harga yang memakai satuan ini sebelum menghapus satuannya');
  }
  await pool.query(`DELETE FROM product_units WHERE product_id = ? AND unit_id = ?`, [productId, unitId]);
  return getProductDetail(productId);
}

async function addBarcode(productId, { unitId, barcode }) {
  if (!unitId || !barcode || !barcode.trim()) {
    throw new HttpError(400, 'bad_request', 'unitId dan barcode wajib diisi');
  }
  try {
    await pool.query(
      `INSERT INTO barcodes (id, product_id, unit_id, barcode) VALUES (?, ?, ?, ?)`,
      [uuidv4(), productId, unitId, barcode.trim()]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'duplicate_barcode', `Barcode "${barcode.trim()}" sudah dipakai`);
    }
    throw err;
  }
  return getProductDetail(productId);
}

async function deleteBarcode(productId, barcodeId) {
  const [result] = await pool.query(
    `DELETE FROM barcodes WHERE id = ? AND product_id = ?`, [barcodeId, productId]
  );
  if (result.affectedRows === 0) {
    throw new HttpError(404, 'barcode_not_found', 'Barcode tidak ditemukan');
  }
  return getProductDetail(productId);
}

async function addPrice(productId, { unitId, priceLevelId, minQtyBase, price }) {
  if (!unitId || !priceLevelId || price === undefined || price === null || Number(price) < 0) {
    throw new HttpError(400, 'bad_request', 'unitId, priceLevelId, dan price (>= 0) wajib diisi');
  }
  try {
    await pool.query(
      `INSERT INTO product_prices (id, product_id, unit_id, price_level_id, min_qty_base, price)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), productId, unitId, priceLevelId, minQtyBase || 0, price]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'duplicate_price_tier', 'Sudah ada harga utk kombinasi satuan/level/min qty yang sama');
    }
    throw err;
  }
  return getProductDetail(productId);
}

async function updatePrice(productId, priceId, { minQtyBase, price }) {
  const [[row]] = await pool.query(
    `SELECT * FROM product_prices WHERE id = ? AND product_id = ?`, [priceId, productId]
  );
  if (!row) {
    throw new HttpError(404, 'price_not_found', 'Harga tidak ditemukan');
  }
  const newMinQty = minQtyBase !== undefined ? minQtyBase : row.min_qty_base;
  const newPrice = price !== undefined ? price : row.price;
  if (Number(newPrice) < 0) {
    throw new HttpError(400, 'bad_request', 'price harus >= 0');
  }
  await pool.query(
    `UPDATE product_prices SET min_qty_base = ?, price = ? WHERE id = ?`,
    [newMinQty, newPrice, priceId]
  );
  return getProductDetail(productId);
}

async function deletePrice(productId, priceId) {
  const [result] = await pool.query(
    `DELETE FROM product_prices WHERE id = ? AND product_id = ?`, [priceId, productId]
  );
  if (result.affectedRows === 0) {
    throw new HttpError(404, 'price_not_found', 'Harga tidak ditemukan');
  }
  return getProductDetail(productId);
}

module.exports = {
  findByBarcode,
  searchByName,
  getForPos,
  listProductsWithStock,
  listProducts,
  getProductDetail,
  createProduct,
  updateProduct,
  addProductUnit,
  updateProductUnit,
  deleteProductUnit,
  addBarcode,
  deleteBarcode,
  addPrice,
  updatePrice,
  deletePrice,
};
