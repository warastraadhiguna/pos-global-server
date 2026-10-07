const express = require('express');
const StoreSettingsService = require('../services/StoreSettingsService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/store-settings — identitas toko (nama/alamat/no HP, dipakai
// struk), visibilitas selector level harga, & mode pajak (pkp/non_pkp).
// Semua user login (termasuk kasir) boleh baca — dibutuhkan saat cetak
// struk, render layar kasir, & hitung PPN saat checkout (SalesService).
router.get(
  '/',
  requirePermission('store_settings', 'view'),
  asyncHandler(async (req, res) => {
    const settings = await StoreSettingsService.getSettings();
    res.json({ settings });
  })
);

// PUT /api/store-settings — partial update:
// { storeName?, storeAddress?, storePhone?, priceLevelSelectorVisible?, taxMode?, branchCode? }
// taxMode ('pkp'|'non_pkp') ditolak (409) kalau periode akuntansi berjalan
// sudah ada transaksi — lihat StoreSettingsService.assertTaxModeChangeAllowed.
// branchCode divalidasi & di-uppercase di StoreSettingsService (format
// 2-10 huruf/angka) — ditolak (400) kalau tidak cocok, bukan cuma dicek UI.
router.put(
  '/',
  requirePermission('store_settings', 'edit'),
  asyncHandler(async (req, res) => {
    const { storeName, storeAddress, storePhone, priceLevelSelectorVisible, taxMode, branchCode } = req.body;
    const settings = await StoreSettingsService.updateSettings({
      storeName,
      storeAddress,
      storePhone,
      priceLevelSelectorVisible: priceLevelSelectorVisible !== undefined ? !!priceLevelSelectorVisible : undefined,
      taxMode,
      branchCode,
      userId: req.user.id,
    });
    res.json({ settings });
  })
);

module.exports = router;
