const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1;

async function listActiveSuppliers() {
  const [rows] = await pool.query(
    `SELECT id, name, contact_person, phone, address FROM suppliers WHERE is_active = 1 ORDER BY name ASC`
  );
  return rows;
}

async function listAllSuppliers() {
  const [rows] = await pool.query(
    `SELECT id, name, contact_person, phone, address, is_active FROM suppliers ORDER BY name ASC`
  );
  return rows;
}

async function createSupplier({ name, contactPerson, phone, address }) {
  if (!name || !name.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama supplier wajib diisi');
  }
  const id = uuidv4();
  await pool.query(
    `INSERT INTO suppliers (id, branch_id, name, contact_person, phone, address) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, BRANCH_ID, name.trim(), contactPerson || null, phone || null, address || null]
  );
  return { id, name: name.trim(), contact_person: contactPerson || null, phone: phone || null, address: address || null, is_active: 1 };
}

async function updateSupplier(id, { name, contactPerson, phone, address, isActive }) {
  const [[existing]] = await pool.query(`SELECT * FROM suppliers WHERE id = ?`, [id]);
  if (!existing) {
    throw new HttpError(404, 'supplier_not_found', 'Supplier tidak ditemukan');
  }
  const newName = name !== undefined && name.trim() ? name.trim() : existing.name;
  const newContactPerson = contactPerson !== undefined ? contactPerson : existing.contact_person;
  const newPhone = phone !== undefined ? phone : existing.phone;
  const newAddress = address !== undefined ? address : existing.address;
  const newIsActive = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;

  await pool.query(
    `UPDATE suppliers SET name = ?, contact_person = ?, phone = ?, address = ?, is_active = ? WHERE id = ?`,
    [newName, newContactPerson, newPhone, newAddress, newIsActive, id]
  );
  return { id, name: newName, contact_person: newContactPerson, phone: newPhone, address: newAddress, is_active: newIsActive };
}

module.exports = { listActiveSuppliers, listAllSuppliers, createSupplier, updateSupplier };
