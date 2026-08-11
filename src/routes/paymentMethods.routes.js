const express = require('express');
const PaymentMethodService = require('../services/PaymentMethodService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/payment-methods — dipakai kasir di layar checkout (cuma aktif)
router.get(
  '/',
  requirePermission('payment_methods', 'view'),
  asyncHandler(async (req, res) => {
    const methods = await PaymentMethodService.listActiveMethods();
    res.json({ methods });
  })
);

// GET /api/payment-methods/all — dipakai admin panel (termasuk nonaktif).
// Sengaja digerbang 'edit' (bukan 'view') — daftar lengkap termasuk yang
// nonaktif itu bagian dari alur kelola, kasir cuma perlu daftar aktif
// (route GET / di atas), sama seperti perilaku SEBELUM RBAC (requireRole
// admin di seluruh route ini kecuali GET /).
router.get(
  '/all',
  requirePermission('payment_methods', 'edit'),
  asyncHandler(async (req, res) => {
    const methods = await PaymentMethodService.listAllMethods();
    res.json({ methods });
  })
);

router.post(
  '/',
  requirePermission('payment_methods', 'create'),
  asyncHandler(async (req, res) => {
    const method = await PaymentMethodService.createMethod(req.body);
    res.status(201).json({ method });
  })
);

router.put(
  '/:id',
  requirePermission('payment_methods', 'edit'),
  asyncHandler(async (req, res) => {
    const method = await PaymentMethodService.updateMethod(req.params.id, req.body);
    res.json({ method });
  })
);

module.exports = router;
