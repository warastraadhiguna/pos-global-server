const express = require('express');
const PriceLevelService = require('../services/PriceLevelService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/price-levels — daftar level harga (ecer, grosir, ...) utk toggle di kasir
router.get(
  '/',
  requirePermission('price_levels', 'view'),
  asyncHandler(async (req, res) => {
    const priceLevels = await PriceLevelService.listPriceLevels();
    res.json({ priceLevels });
  })
);

// POST /api/price-levels — tambah level harga baru
router.post(
  '/',
  requirePermission('price_levels', 'create'),
  asyncHandler(async (req, res) => {
    const priceLevel = await PriceLevelService.createPriceLevel(req.body);
    res.status(201).json({ priceLevel });
  })
);

// PUT /api/price-levels/:id — atur markup% markup-otomatis (Batch 3A)
router.put(
  '/:id',
  requirePermission('price_levels', 'edit'),
  asyncHandler(async (req, res) => {
    const priceLevel = await PriceLevelService.updatePriceLevel(req.params.id, req.body);
    res.json({ priceLevel });
  })
);

module.exports = router;
