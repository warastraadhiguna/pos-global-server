const express = require('express');
const StoreSettingsService = require('../services/StoreSettingsService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/store-settings — identitas toko (nama/alamat/no HP, dipakai
// struk) + visibilitas selector level harga. Semua user login (termasuk
// kasir) boleh baca — dibutuhkan saat cetak struk & render layar kasir.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const settings = await StoreSettingsService.getSettings();
    res.json({ settings });
  })
);

// PUT /api/store-settings — admin only, partial update:
// { storeName?, storeAddress?, storePhone?, priceLevelSelectorVisible? }
router.put(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { storeName, storeAddress, storePhone, priceLevelSelectorVisible } = req.body;
    const settings = await StoreSettingsService.updateSettings({
      storeName,
      storeAddress,
      storePhone,
      priceLevelSelectorVisible: priceLevelSelectorVisible !== undefined ? !!priceLevelSelectorVisible : undefined,
      userId: req.user.id,
    });
    res.json({ settings });
  })
);

module.exports = router;
