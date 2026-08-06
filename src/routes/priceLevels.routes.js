const express = require('express');
const PriceLevelService = require('../services/PriceLevelService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/price-levels — daftar level harga (ecer, grosir, ...) utk toggle di kasir
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const priceLevels = await PriceLevelService.listPriceLevels();
    res.json({ priceLevels });
  })
);

// POST /api/price-levels — admin only, tambah level harga baru
router.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const priceLevel = await PriceLevelService.createPriceLevel(req.body);
    res.status(201).json({ priceLevel });
  })
);

// PUT /api/price-levels/:id — admin only, atur markup% markup-otomatis (Batch 3A)
router.put(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const priceLevel = await PriceLevelService.updatePriceLevel(req.params.id, req.body);
    res.json({ priceLevel });
  })
);

module.exports = router;
