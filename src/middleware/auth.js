const jwt = require('jsonwebtoken');
const HttpError = require('../utils/HttpError');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'unauthorized', 'Token tidak ditemukan'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, role, branchId, ... }
    next();
  } catch (err) {
    next(new HttpError(401, 'unauthorized', 'Token tidak valid atau kedaluwarsa'));
  }
}

// Batasi route hanya untuk role tertentu, mis. requireRole('admin')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(new HttpError(403, 'forbidden', 'Tidak punya akses untuk aksi ini'));
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
