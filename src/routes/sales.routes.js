const express = require('express');
const SalesService = require('../services/SalesService');
const ShiftService = require('../services/ShiftService');
const VoidService = require('../services/VoidService');
const BelowCostAuthorizationService = require('../services/BelowCostAuthorizationService');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// POST /api/sales/quote — preview harga keranjang, TIDAK menyimpan apa pun.
// Ini satu-satunya sumber harga yang boleh ditampilkan client — client tidak
// pernah menghitung harga/subtotal sendiri.
router.post(
  '/quote',
  requirePermission('sales', 'view'),
  asyncHandler(async (req, res) => {
    const { items, totalDiscountType, totalDiscountValue, allowBelowCost } = req.body;
    const quote = await SalesService.previewSale({ items, totalDiscountType, totalDiscountValue, allowBelowCost: !!allowBelowCost });
    res.json({ quote });
  })
);

// POST /api/sales/below-cost-authorization — kasir kirim kode 6 digit yang
// disebutkan Owner lewat telepon (dibaca dari app authenticator Owner
// sendiri). Berhasil -> token sekali-pakai (kedaluwarsa singkat), dilampirkan
// ke POST /api/sales berikutnya sebagai belowCostAuthToken. Cukup requireAuth
// (kasir mana pun yang sedang login boleh mencoba) — TIDAK digerbang izin
// modul apa pun, karena justru dipakai OLEH kasir yang TIDAK punya izin
// sales.sell_below_cost sendiri.
router.post(
  '/below-cost-authorization',
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    const result = await BelowCostAuthorizationService.verifyAndIssueToken({
      requestedByUserId: req.user.id,
      code,
    });
    res.json(result);
  })
);

// POST /api/sales — checkout. Shift diambil dari shift terbuka milik kasir
// yang sedang login, bukan dari body (mencegah client menyuntik shift orang lain).
// Body: { items, paymentMethodId, cashTendered, totalDiscountType?, totalDiscountValue?, customerName? } —
// items[].discountType/discountValue = diskon per item (Batch 3B). TIDAK ada
// field harga/subtotal/total dari client, server yang menghitung ulang semua.
router.post(
  '/',
  requirePermission('sales', 'create'),
  asyncHandler(async (req, res) => {
    const { items, paymentMethodId, cashTendered, totalDiscountType, totalDiscountValue, customerName, belowCostReason, belowCostAuthToken } = req.body;

    const shift = await ShiftService.getOpenShiftForUser(req.user.id);
    if (!shift) {
      throw new HttpError(409, 'no_open_shift', 'Buka shift terlebih dahulu sebelum melakukan penjualan');
    }

    const sale = await SalesService.createSale({
      userId: req.user.id,
      userRole: req.user.role,
      shiftId: shift.id,
      items,
      paymentMethodId,
      cashTendered,
      totalDiscountType,
      totalDiscountValue,
      customerName,
      belowCostReason,
      belowCostAuthToken,
    });

    res.status(201).json({ sale });
  })
);

// GET /api/sales/:id — detail lengkap transaksi lama (item + nama produk,
// pembayaran, PPN), dipakai popup "Lihat Detail"/cetak ulang struk di panel
// Laporan Shift. Otorisasi (pemilik transaksi/admin) diperiksa di service.
router.get(
  '/:id',
  requirePermission('sales', 'view'),
  asyncHandler(async (req, res) => {
    const sale = await SalesService.getSaleDetail(req.params.id, req.user.id, req.user.role);
    res.json({ sale });
  })
);

// POST /api/sales/:id/void — body: { reason }. Alasan wajib (Bagian 4).
// Izin RBAC 'sales.void' cuma menentukan siapa BOLEH mencoba void sama
// sekali — pengecekan kepemilikan nota (kasir cuma boleh void notanya
// sendiri, admin/superadmin boleh nota siapa saja) TETAP dijalankan di
// VoidService.voidSale seperti sebelumnya, TIDAK digantikan oleh RBAC.
router.post(
  '/:id/void',
  requirePermission('sales', 'void'),
  asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const result = await VoidService.voidSale({
      saleId: req.params.id,
      userId: req.user.id,
      userRole: req.user.role,
      reason,
    });
    res.json({ sale: result });
  })
);

module.exports = router;
