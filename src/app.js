const path = require('path');
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', routes);

// Admin panel (build statis pos-admin/dist) disajikan dari server yang sama
// — supaya cuma SATU proses yang perlu di-auto-start saat boot (bukan
// server + vite dev server terpisah). Jalankan `npm run build` di pos-admin
// sebelum ini bisa dipakai; kalau dist/ belum ada, sendFile gagal dan jatuh
// ke notFoundHandler (404 JSON biasa), bukan crash.
const adminDistPath = path.join(__dirname, '../../pos-admin/dist');
app.use(express.static(adminDistPath));
app.get(/^(?!\/api).*/, (req, res, next) => {
  res.sendFile(path.join(adminDistPath, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
