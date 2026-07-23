function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not_found', message: `Route ${req.method} ${req.path} tidak ditemukan` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.code || 'internal_error',
    message: err.message || 'Terjadi kesalahan pada server',
  });
}

module.exports = { notFoundHandler, errorHandler };
