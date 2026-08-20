const express = require('express');
const StockMovementService = require('../services/StockMovementService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// products.view sudah mencakup "Lihat produk & stok" (lihat deskripsinya di
// seed.js) — dipakai juga oleh GET /api/products/stock (panel stok kasir),
// jadi riwayat stok di admin panel reuse permission yang sama, tidak perlu
// permission baru.
router.use(requireAuth, requirePermission('products', 'view'));

// GET /api/admin/stock/movements?productId=&dateFrom=&dateTo=&movementType=
router.get(
  '/movements',
  asyncHandler(async (req, res) => {
    const { productId, dateFrom, dateTo, movementType } = req.query;
    const movements = await StockMovementService.listMovements({ productId, dateFrom, dateTo, movementType });
    res.json({ movements });
  })
);

module.exports = router;
