require('dotenv').config();
const mysql = require('mysql2/promise');

// IP/host & port dibaca dari env, bukan hardcode (Bagian 8: IP server harus
// bisa dikonfigurasi karena beda-beda tergantung jaringan toko).
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pos_branch',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: false, // DECIMAL tetap string dari driver, dikonversi via decimal.js — jangan lewat Number JS biasa
});

module.exports = pool;
