const express = require('express');
const StoreSettingsService = require('../services/StoreSettingsService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/store-settings — identitas toko (nama/alamat/no HP, dipakai
// struk), visibilitas selector level harga, & mode pajak (pkp/non_pkp).
// Semua user login (termasuk kasir) boleh baca — dibutuhkan saat cetak
// struk, render layar kasir, & hitung PPN saat checkout (SalesService).
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const settings = await StoreSettingsService.getSettings();
    res.json({ settings });
  })
);

// PUT /api/store-settings — admin only, partial update:
// { storeName?, storeAddress?, storePhone?, priceLevelSelectorVisible?, taxMode? }
// taxMode ('pkp'|'non_pkp') ditolak (409) kalau periode akuntansi berjalan
// sudah ada transaksi — lihat StoreSettingsService.assertTaxModeChangeAllowed.
router.put(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { storeName, storeAddress, storePhone, priceLevelSelectorVisible, taxMode } = req.body;
    const settings = await StoreSettingsService.updateSettings({
      storeName,
      storeAddress,
      storePhone,
      priceLevelSelectorVisible: priceLevelSelectorVisible !== undefined ? !!priceLevelSelectorVisible : undefined,
      taxMode,
      userId: req.user.id,
    });
    res.json({ settings });
  })
);

module.exports = router;
