// Bungkus route handler async supaya reject-nya otomatis diteruskan ke
// error handler Express, tanpa perlu try/catch berulang di tiap route.
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
