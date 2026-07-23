const express = require('express');
const PaymentMethodService = require('../services/PaymentMethodService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/payment-methods — dipakai kasir di layar checkout (cuma aktif)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const methods = await PaymentMethodService.listActiveMethods();
    res.json({ methods });
  })
);

router.use(requireRole('admin'));

// GET /api/payment-methods/all — dipakai admin panel (termasuk nonaktif)
router.get(
  '/all',
  asyncHandler(async (req, res) => {
    const methods = await PaymentMethodService.listAllMethods();
    res.json({ methods });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const method = await PaymentMethodService.createMethod(req.body);
    res.status(201).json({ method });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const method = await PaymentMethodService.updateMethod(req.params.id, req.body);
    res.json({ method });
  })
);

module.exports = router;
