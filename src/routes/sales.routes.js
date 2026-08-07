const express = require('express');
const SalesService = require('../services/SalesService');
const ShiftService = require('../services/ShiftService');
const VoidService = require('../services/VoidService');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// POST /api/sales/quote — preview harga keranjang, TIDAK menyimpan apa pun.
// Ini satu-satunya sumber harga yang boleh ditampilkan client — client tidak
// pernah menghitung harga/subtotal sendiri.
router.post(
  '/quote',
  asyncHandler(async (req, res) => {
    const { items, totalDiscountType, totalDiscountValue } = req.body;
    const quote = await SalesService.previewSale({ items, totalDiscountType, totalDiscountValue });
    res.json({ quote });
  })
);

// POST /api/sales — checkout. Shift diambil dari shift terbuka milik kasir
// yang sedang login, bukan dari body (mencegah client menyuntik shift orang lain).
// Body: { items, paymentMethodId, cashTendered, totalDiscountType?, totalDiscountValue?, customerName? } —
// items[].discountType/discountValue = diskon per item (Batch 3B). TIDAK ada
// field harga/subtotal/total dari client, server yang menghitung ulang semua.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { items, paymentMethodId, cashTendered, totalDiscountType, totalDiscountValue, customerName } = req.body;

    const shift = await ShiftService.getOpenShiftForUser(req.user.id);
    if (!shift) {
      throw new HttpError(409, 'no_open_shift', 'Buka shift terlebih dahulu sebelum melakukan penjualan');
    }

    const sale = await SalesService.createSale({
      userId: req.user.id,
      shiftId: shift.id,
      items,
      paymentMethodId,
      cashTendered,
      totalDiscountType,
      totalDiscountValue,
      customerName,
    });

    res.status(201).json({ sale });
  })
);

// GET /api/sales/:id — detail lengkap transaksi lama (item + nama produk,
// pembayaran, PPN), dipakai popup "Lihat Detail"/cetak ulang struk di panel
// Laporan Shift. Otorisasi (pemilik transaksi/admin) diperiksa di service.
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const sale = await SalesService.getSaleDetail(req.params.id, req.user.id, req.user.role);
    res.json({ sale });
  })
);

// POST /api/sales/:id/void — body: { reason }. Alasan wajib (Bagian 4).
router.post(
  '/:id/void',
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
