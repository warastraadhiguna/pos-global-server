const express = require('express');
const rateLimit = require('express-rate-limit');
const AuthService = require('../services/AuthService');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Rate limit per-IP di level jaringan, terpisah dari lockout per-akun di
// AuthService (yang menghitung percobaan gagal per user). Ini menahan brute
// force yang mencoba banyak username/PIN berbeda dari satu sumber.
const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Terlalu banyak percobaan login, coba lagi sebentar lagi.' },
});

// POST /api/auth/login  — login admin (username + password)
router.post(
  '/login',
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      throw new HttpError(400, 'bad_request', 'username dan password wajib diisi');
    }
    const result = await AuthService.loginAdmin(username, password);
    res.json(result);
  })
);

// GET /api/auth/cashiers — daftar kasir aktif utk layar pilih-kasir
router.get(
  '/cashiers',
  asyncHandler(async (req, res) => {
    const cashiers = await AuthService.listActiveCashiers();
    res.json({ cashiers });
  })
);

// POST /api/auth/login-pin — login kasir (pilih user_id + PIN)
router.post(
  '/login-pin',
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId, pin } = req.body;
    if (!userId || !pin) {
      throw new HttpError(400, 'bad_request', 'userId dan pin wajib diisi');
    }
    const result = await AuthService.loginCashierWithPin(userId, pin);
    res.json(result);
  })
);

// GET /api/auth/me — cek token & ambil identitas user saat ini
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
