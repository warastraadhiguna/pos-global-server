const fs = require('fs');
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
// sebelum ini bisa dipakai.
//
// Path-nya BOLEH di-override lewat ADMIN_DIST_PATH di .env — defaultnya
// mengasumsikan server/ dan pos-admin/ bertetangga (folder sama), tapi kalau
// salah satu folder dipindah sendiri-sendiri (mis. server/ dipindah ke drive
// lain tanpa pos-admin/ ikut), asumsi itu tidak berlaku lagi. Ketahuan lewat
// warning di log saat start, bukan diam-diam 404 tanpa penjelasan.
const adminDistPath = process.env.ADMIN_DIST_PATH
  ? path.resolve(process.env.ADMIN_DIST_PATH)
  : path.join(__dirname, '../../pos-admin/dist');

if (!fs.existsSync(path.join(adminDistPath, 'index.html'))) {
  console.warn(`[app] PERINGATAN: admin panel tidak ditemukan di ${adminDistPath} — pastikan sudah "npm run build" di pos-admin, atau set ADMIN_DIST_PATH di .env kalau lokasi foldernya beda dari asumsi default (bertetangga dgn server/).`);
}

app.use(express.static(adminDistPath));
app.get(/^(?!\/api).*/, (req, res, next) => {
  res.sendFile(path.join(adminDistPath, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
