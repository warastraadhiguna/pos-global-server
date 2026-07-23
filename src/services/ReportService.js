// Laporan read-only — TIDAK PERNAH menulis apa pun, cuma agregasi SUM() dari
// data yang sudah ada. Transaksi voided (status != 'completed') selalu
// dikecualikan di WHERE clause, bukan difilter belakangan.
//
// Setiap SUM()/COUNT() dari MySQL WAJIB dibungkus decimal.js sebelum dipakai
// operasi apa pun (termasuk .toFixed() format) — driver mysql2 mengembalikan
// DECIMAL dan BIGINT hasil agregat sebagai string, dan pernah ada bug nyata
// (ShiftService.calculateExpectedCash) gara-gara ini dijumlah pakai `+` JS
// biasa tanpa dibungkus dulu, jadi string concatenation. Lihat catatan
// Bagian 5 di MVP_Blueprint_POS_1_Cabang.md.
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

async function getDailySalesReport(date) {
  if (!date || !DATE_REGEX.test(date)) {
    throw new HttpError(400, 'bad_request', 'Parameter date wajib diisi, format YYYY-MM-DD');
  }

  const [[summaryRow]] = await pool.query(
    `SELECT
       COUNT(*) AS transaction_count,
       COALESCE(SUM(grand_total), 0) AS total_omzet,
       COALESCE(SUM(total_cost), 0) AS total_hpp,
       COALESCE(SUM(gross_profit), 0) AS total_gross_profit
     FROM sales
     WHERE DATE(created_at) = ? AND status = 'completed'`,
    [date]
  );

  const [productRows] = await pool.query(
    `SELECT
       si.product_id,
       p.name AS product_name,
       u.name AS base_unit_name,
       COALESCE(SUM(si.quantity_base), 0) AS qty_sold_base,
       COALESCE(SUM(si.subtotal), 0) AS subtotal,
       COALESCE(SUM(si.total_cost), 0) AS total_cost,
       COALESCE(SUM(si.gross_profit), 0) AS gross_profit
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     JOIN units u ON u.id = p.base_unit_id
     WHERE DATE(s.created_at) = ? AND s.status = 'completed'
     GROUP BY si.product_id, p.name, u.name
     ORDER BY p.name`,
    [date]
  );

  return {
    date,
    transactionCount: Number(summaryRow.transaction_count),
    totalOmzet: new Decimal(summaryRow.total_omzet).toFixed(0),
    totalHpp: new Decimal(summaryRow.total_hpp).toFixed(4),
    totalGrossProfit: new Decimal(summaryRow.total_gross_profit).toFixed(4),
    products: productRows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      baseUnitName: row.base_unit_name,
      qtySoldBase: new Decimal(row.qty_sold_base).toFixed(4),
      subtotal: new Decimal(row.subtotal).toFixed(0),
      totalCost: new Decimal(row.total_cost).toFixed(4),
      grossProfit: new Decimal(row.gross_profit).toFixed(4),
    })),
  };
}

module.exports = { getDailySalesReport };
