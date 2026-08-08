const express = require('express');
const AccountingService = require('../services/AccountingService');
const ManualJournalService = require('../services/ManualJournalService');
const FixedAssetService = require('../services/FixedAssetService');
const DepreciationService = require('../services/DepreciationService');
const AccountingReportService = require('../services/AccountingReportService');
const OpeningBalanceService = require('../services/OpeningBalanceService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Seluruh modul akuntansi (Lapis 3) admin-only — belum ada kebutuhan kasir
// menyentuh ini sama sekali.
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/accounting/accounts — dipakai form beban/aset tetap utk
// dropdown pilih akun COA.
router.get(
  '/accounts',
  asyncHandler(async (req, res) => {
    const accounts = await AccountingService.listAccounts({ activeOnly: true });
    res.json({ accounts });
  })
);

// POST /api/admin/accounting/expenses — body: { entryDate, accountId, amount, description, paymentType }
router.post(
  '/expenses',
  asyncHandler(async (req, res) => {
    const journalEntry = await ManualJournalService.postExpense({ ...req.body, createdBy: req.user.id });
    res.status(201).json({ journalEntry });
  })
);

// POST /api/admin/accounting/owner-draws — body: { entryDate, amount, description }
router.post(
  '/owner-draws',
  asyncHandler(async (req, res) => {
    const journalEntry = await ManualJournalService.postOwnerDraw({ ...req.body, createdBy: req.user.id });
    res.status(201).json({ journalEntry });
  })
);

router.get(
  '/fixed-assets',
  asyncHandler(async (req, res) => {
    const fixedAssets = await FixedAssetService.listFixedAssets();
    res.json({ fixedAssets });
  })
);

// POST /api/admin/accounting/fixed-assets — body: { name, assetAccountId,
// accumulatedDepreciationAccountId, depreciationExpenseAccountId,
// acquisitionDate, acquisitionCost, residualValue, usefulLifeMonths, paymentType }
router.post(
  '/fixed-assets',
  asyncHandler(async (req, res) => {
    const result = await FixedAssetService.createFixedAsset({ ...req.body, createdBy: req.user.id });
    res.status(201).json(result);
  })
);

// POST /api/admin/accounting/fixed-assets/depreciation/run — body: { periodYear, periodMonth }
// Proses MANUAL, dipicu admin — bukan cron/scheduler. Aman diklik berkali-
// kali: aset yg periode-nya sudah pernah dijurnal otomatis dilewati (lihat
// DepreciationService), tidak pernah menghasilkan jurnal kedua.
router.post(
  '/fixed-assets/depreciation/run',
  asyncHandler(async (req, res) => {
    const { periodYear, periodMonth } = req.body;
    const result = await DepreciationService.runMonthlyDepreciation({ periodYear, periodMonth, createdBy: req.user.id });
    res.json(result);
  })
);

// ---------------------------------------------------------------------------
// Saldo awal (Lapis 4, tambahan) — proses manual sekali-jalan.
// ---------------------------------------------------------------------------

// GET /api/admin/accounting/opening-balances/inventory/preview
router.get(
  '/opening-balances/inventory/preview',
  asyncHandler(async (req, res) => {
    const result = await OpeningBalanceService.previewInventoryOpeningBalance();
    res.json(result);
  })
);

// POST /api/admin/accounting/opening-balances/inventory/run — body: { entryDate }
router.post(
  '/opening-balances/inventory/run',
  asyncHandler(async (req, res) => {
    const journalEntry = await OpeningBalanceService.postInventoryOpeningBalance({
      entryDate: req.body.entryDate,
      createdBy: req.user.id,
    });
    res.status(201).json({ journalEntry });
  })
);

// ---------------------------------------------------------------------------
// Laporan (Lapis 4) — semua read-only.
// ---------------------------------------------------------------------------

// GET /api/admin/accounting/reports/trial-balance?asOfDate=YYYY-MM-DD
router.get(
  '/reports/trial-balance',
  asyncHandler(async (req, res) => {
    const result = await AccountingReportService.getTrialBalance({ asOfDate: req.query.asOfDate });
    res.json(result);
  })
);

// GET /api/admin/accounting/reports/income-statement?startDate=&endDate=
router.get(
  '/reports/income-statement',
  asyncHandler(async (req, res) => {
    const result = await AccountingReportService.getIncomeStatement({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json(result);
  })
);

// GET /api/admin/accounting/reports/balance-sheet?asOfDate=YYYY-MM-DD
router.get(
  '/reports/balance-sheet',
  asyncHandler(async (req, res) => {
    const result = await AccountingReportService.getBalanceSheet({ asOfDate: req.query.asOfDate });
    res.json(result);
  })
);

// GET /api/admin/accounting/reports/cash-flow?startDate=&endDate=
router.get(
  '/reports/cash-flow',
  asyncHandler(async (req, res) => {
    const result = await AccountingReportService.getCashFlow({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json(result);
  })
);

// GET /api/admin/accounting/reports/general-ledger?accountId=&startDate=&endDate=
router.get(
  '/reports/general-ledger',
  asyncHandler(async (req, res) => {
    const result = await AccountingReportService.getGeneralLedger({
      accountId: req.query.accountId,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json(result);
  })
);

// GET /api/admin/accounting/reports/ppn-setoran?startDate=&endDate= — PPN
// Keluaran vs PPN Masukan (mode PKP). Read-only, relevansinya (tampil/
// disembunyikan) diputuskan di pos-admin berdasar tax_mode saat ini.
router.get(
  '/reports/ppn-setoran',
  asyncHandler(async (req, res) => {
    const result = await AccountingReportService.getPpnSetoranReport({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json(result);
  })
);

module.exports = router;
