// Rekalkulasi ulang stock_balances dari stock_movements (sumber kebenaran).
// Jalankan kalau cache stock_balances dicurigai drift dari ledger.
// Usage: npm run stock:recalculate
require('dotenv').config();
const pool = require('../config/db');
const { recalculateAllBalances } = require('../services/StockMovementService');

async function main() {
  console.log('Merekalkulasi stock_balances dari stock_movements ...');
  const results = await recalculateAllBalances();
  console.table(results.map((r) => ({
    warehouse_id: r.warehouseId,
    product_id: r.productId,
    qty_base: r.qtyBase,
    avg_cost_per_base_unit: r.avgCostPerBaseUnit,
    movements: r.movementsReplayed,
  })));
  console.log(`Selesai. ${results.length} pasangan (warehouse, product) diperbarui.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Rekalkulasi gagal:', err);
  process.exit(1);
});
