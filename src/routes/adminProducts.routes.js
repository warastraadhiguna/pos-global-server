const express = require('express');
const ProductService = require('../services/ProductService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Katalog manajemen (daftar lengkap semua produk + detail penuh, dipakai
// halaman admin Produk) — SENGAJA digerbang 'edit' (bukan 'view') supaya
// TIDAK ikut kebuka ke kasir, yang cuma dikasih izin products.view utk
// endpoint terbatasnya sendiri (products.routes.js: barcode/search/
// for-pos/stock). Sebelum RBAC, seluruh file ini requireRole('admin') —
// kasir tidak pernah bisa mengakses ini sama sekali, jadi 'edit' di sini
// menjaga perilaku itu (kasir tidak punya products.edit).
router.get('/', requirePermission('products', 'edit'), asyncHandler(async (req, res) => {
  const products = await ProductService.listProducts();
  res.json({ products });
}));

router.get('/:id', requirePermission('products', 'edit'), asyncHandler(async (req, res) => {
  const product = await ProductService.getProductDetail(req.params.id);
  res.json(product);
}));

router.post('/', requirePermission('products', 'create'), asyncHandler(async (req, res) => {
  const product = await ProductService.createProduct(req.body);
  res.status(201).json(product);
}));

router.put('/:id', requirePermission('products', 'edit'), asyncHandler(async (req, res) => {
  const product = await ProductService.updateProduct(req.params.id, req.body);
  res.json(product);
}));

// --- Satuan produk (product_units) ---
router.post('/:id/units', requirePermission('products', 'edit'), asyncHandler(async (req, res) => {
  const product = await ProductService.addProductUnit(req.params.id, req.body);
  res.status(201).json(product);
}));

router.put('/:id/units/:unitId', requirePermission('products', 'edit'), asyncHandler(async (req, res) => {
  const product = await ProductService.updateProductUnit(req.params.id, req.params.unitId, req.body);
  res.json(product);
}));

router.delete('/:id/units/:unitId', requirePermission('products', 'edit'), asyncHandler(async (req, res) => {
  const product = await ProductService.deleteProductUnit(req.params.id, req.params.unitId);
  res.json(product);
}));

// --- Barcode ---
router.post('/:id/barcodes', requirePermission('products', 'edit'), asyncHandler(async (req, res) => {
  const product = await ProductService.addBarcode(req.params.id, req.body);
  res.status(201).json(product);
}));

router.delete('/:id/barcodes/:barcodeId', requirePermission('products', 'edit'), asyncHandler(async (req, res) => {
  const product = await ProductService.deleteBarcode(req.params.id, req.params.barcodeId);
  res.json(product);
}));

// --- Harga (product_prices) — "harga baku", izin SENDIRI & KETAT
// (edit_base_price), TERPISAH dari products.edit biasa.
router.post('/:id/prices', requirePermission('products', 'edit_base_price'), asyncHandler(async (req, res) => {
  const product = await ProductService.addPrice(req.params.id, req.body);
  res.status(201).json(product);
}));

router.put('/:id/prices/:priceId', requirePermission('products', 'edit_base_price'), asyncHandler(async (req, res) => {
  const product = await ProductService.updatePrice(req.params.id, req.params.priceId, req.body);
  res.json(product);
}));

router.delete('/:id/prices/:priceId', requirePermission('products', 'edit_base_price'), asyncHandler(async (req, res) => {
  const product = await ProductService.deletePrice(req.params.id, req.params.priceId);
  res.json(product);
}));

module.exports = router;
