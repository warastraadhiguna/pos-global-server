const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

async function listCategories() {
  const [rows] = await pool.query(
    `SELECT id, name, is_active FROM product_categories ORDER BY name`
  );
  return rows;
}

async function createCategory({ name }) {
  if (!name || !name.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama kategori wajib diisi');
  }
  const id = uuidv4();
  await pool.query(`INSERT INTO product_categories (id, name) VALUES (?, ?)`, [id, name.trim()]);
  return { id, name: name.trim(), is_active: 1 };
}

async function updateCategory(id, { name, isActive }) {
  const [[existing]] = await pool.query(`SELECT * FROM product_categories WHERE id = ?`, [id]);
  if (!existing) {
    throw new HttpError(404, 'category_not_found', 'Kategori tidak ditemukan');
  }
  const newName = name !== undefined && name.trim() ? name.trim() : existing.name;
  const newIsActive = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;
  await pool.query(`UPDATE product_categories SET name = ?, is_active = ? WHERE id = ?`, [newName, newIsActive, id]);
  return { id, name: newName, is_active: newIsActive };
}

module.exports = { listCategories, createCategory, updateCategory };
