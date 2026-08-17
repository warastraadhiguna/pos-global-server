const express = require('express');
const ProductService = require('../services/ProductService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requirePermission('products', 'view'));

// GET /api/products/barcode/:barcode — scan barcode di kasir
router.get(
  '/barcode/:barcode',
  asyncHandler(async (req, res) => {
    const result = await ProductService.findByBarcode(req.params.barcode);
    res.json(result);
  })
);

// GET /api/products/search?q=... — cari produk by nama (popup cari di kasir)
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const results = await ProductService.searchByName(req.query.q);
    res.json({ results });
  })
);

// GET /api/products/:id/for-pos — detail lengkap produk siap ditambah ke
// keranjang, dipakai setelah kasir pilih dari hasil cari nama.
router.get(
  '/:id/for-pos',
  asyncHandler(async (req, res) => {
    const result = await ProductService.getForPos(req.params.id);
    res.json(result);
  })
);

// GET /api/products/stock — panel "Lihat Stok" read-only di kasir.
router.get(
  '/stock',
  asyncHandler(async (req, res) => {
    const products = await ProductService.listProductsWithStock();
    res.json({ products });
  })
);

module.exports = router;
