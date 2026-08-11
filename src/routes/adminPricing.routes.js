const express = require('express');
const PricingSettingsService = require('../services/PricingSettingsService');
const PriceChangeNotificationService = require('../services/PriceChangeNotificationService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/admin/pricing/settings — status toggle markup otomatis global
router.get(
  '/settings',
  requirePermission('pricing_settings', 'view'),
  asyncHandler(async (req, res) => {
    const settings = await PricingSettingsService.getSettings();
    res.json({ settings });
  })
);

// PUT /api/admin/pricing/settings — body (semua opsional, partial update):
// { autoPricingEnabled?, ppnEnabled?, ppnRate?, ppnMode? }
router.put(
  '/settings',
  requirePermission('pricing_settings', 'edit'),
  asyncHandler(async (req, res) => {
    const { autoPricingEnabled, ppnEnabled, ppnRate, ppnMode } = req.body;
    const settings = await PricingSettingsService.updateSettings({
      autoPricingEnabled: autoPricingEnabled !== undefined ? !!autoPricingEnabled : undefined,
      ppnEnabled: ppnEnabled !== undefined ? !!ppnEnabled : undefined,
      ppnRate,
      ppnMode,
      userId: req.user.id,
    });
    res.json({ settings });
  })
);

// GET /api/admin/pricing/notifications — daftar notifikasi perubahan harga
router.get(
  '/notifications',
  requirePermission('pricing_settings', 'view'),
  asyncHandler(async (req, res) => {
    const events = await PriceChangeNotificationService.listEvents({});
    res.json({ events });
  })
);

// GET /api/admin/pricing/notifications/unread-count — badge di nav
router.get(
  '/notifications/unread-count',
  requirePermission('pricing_settings', 'view'),
  asyncHandler(async (req, res) => {
    const count = await PriceChangeNotificationService.countUnread();
    res.json({ count });
  })
);

// PUT /api/admin/pricing/notifications/:id/read
router.put(
  '/notifications/:id/read',
  requirePermission('pricing_settings', 'edit'),
  asyncHandler(async (req, res) => {
    await PriceChangeNotificationService.markRead(req.params.id);
    res.json({ success: true });
  })
);

// PUT /api/admin/pricing/notifications/read-all
router.put(
  '/notifications/read-all',
  requirePermission('pricing_settings', 'edit'),
  asyncHandler(async (req, res) => {
    await PriceChangeNotificationService.markAllRead();
    res.json({ success: true });
  })
);

module.exports = router;
