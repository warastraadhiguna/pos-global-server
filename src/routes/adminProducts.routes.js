const express = require('express');
const ProductService = require('../services/ProductService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/', asyncHandler(async (req, res) => {
  const products = await ProductService.listProducts();
  res.json({ products });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const product = await ProductService.getProductDetail(req.params.id);
  res.json(product);
}));

router.post('/', asyncHandler(async (req, res) => {
  const product = await ProductService.createProduct(req.body);
  res.status(201).json(product);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const product = await ProductService.updateProduct(req.params.id, req.body);
  res.json(product);
}));

// --- Satuan produk (product_units) ---
router.post('/:id/units', asyncHandler(async (req, res) => {
  const product = await ProductService.addProductUnit(req.params.id, req.body);
  res.status(201).json(product);
}));

router.put('/:id/units/:unitId', asyncHandler(async (req, res) => {
  const product = await ProductService.updateProductUnit(req.params.id, req.params.unitId, req.body);
  res.json(product);
}));

router.delete('/:id/units/:unitId', asyncHandler(async (req, res) => {
  const product = await ProductService.deleteProductUnit(req.params.id, req.params.unitId);
  res.json(product);
}));

// --- Barcode ---
router.post('/:id/barcodes', asyncHandler(async (req, res) => {
  const product = await ProductService.addBarcode(req.params.id, req.body);
  res.status(201).json(product);
}));

router.delete('/:id/barcodes/:barcodeId', asyncHandler(async (req, res) => {
  const product = await ProductService.deleteBarcode(req.params.id, req.params.barcodeId);
  res.json(product);
}));

// --- Harga (product_prices) ---
router.post('/:id/prices', asyncHandler(async (req, res) => {
  const product = await ProductService.addPrice(req.params.id, req.body);
  res.status(201).json(product);
}));

router.put('/:id/prices/:priceId', asyncHandler(async (req, res) => {
  const product = await ProductService.updatePrice(req.params.id, req.params.priceId, req.body);
  res.json(product);
}));

router.delete('/:id/prices/:priceId', asyncHandler(async (req, res) => {
  const product = await ProductService.deletePrice(req.params.id, req.params.priceId);
  res.json(product);
}));

module.exports = router;
