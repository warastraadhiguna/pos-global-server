const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const pool = require("../config/db");
const HttpError = require("../utils/HttpError");

const TOKEN_TTL_MINUTES = 3;
// Toleransi 1 langkah di kedua sisi (default otplib) — total ~90 detik
// jendela terima, supaya keterlambatan Owner baca angka & kasir mengetik
// tidak bikin kode "basi" secara tidak wajar sebelum sempat dipakai.
authenticator.options = { window: 1 };

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// role_permissions 'sales.sell_below_cost' = SATU-SATUNYA penanda "role
// Owner" yang dipakai fitur ini (bukan nama role literal) — supaya toko
// bebas menamai role-nya apa saja lewat Kelola Role, tidak harus persis
// "Owner". Dipakai dua tempat: (1) siapa boleh setup TOTP / dianggap
// "Owner" saat verifikasi kode, (2) siapa yang login kasir boleh jual di
// bawah HPP LANGSUNG tanpa perlu kode (lihat SalesService.createSale).
async function roleHasSellBelowCostPermission(roleName) {
  const [[role]] = await pool.query(
    `SELECT r.is_superadmin,
            EXISTS (
              SELECT 1 FROM role_permissions rp
              JOIN permissions p ON p.id = rp.permission_id
              WHERE rp.role_id = r.id AND p.module = 'sales' AND p.action = 'sell_below_cost'
            ) AS has_permission
     FROM roles r WHERE r.name = ?`,
    [roleName],
  );
  return !!(role && (role.is_superadmin || role.has_permission));
}

// Setup/reset kode otorisasi Owner. Generate secret BARU (menggantikan yang
// lama kalau sudah ada — mis. HP Owner ganti) — QR/secret cuma dikembalikan
// SEKALI di response ini, tidak pernah ditampilkan ulang setelahnya (lihat
// route: endpoint "lihat status" cuma bilang aktif/tidak, bukan tampilkan
// secretnya lagi).
async function setupTotp(userId) {
  const [[user]] = await pool.query(
    `SELECT u.id, u.full_name, r.name AS role_name
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`,
    [userId],
  );
  if (!user) {
    throw new HttpError(404, "user_not_found", "User tidak ditemukan");
  }
  const allowed = await roleHasSellBelowCostPermission(user.role_name);
  if (!allowed) {
    throw new HttpError(
      400,
      "role_not_eligible",
      `Role "${user.role_name}" belum punya izin 'sales.sell_below_cost' — beri izin itu dulu lewat menu Kelola Role sebelum setup kode otorisasi.`,
    );
  }

  const secret = authenticator.generateSecret();
  await pool.query(
    `UPDATE users SET totp_secret = ?, totp_enabled_at = NOW() WHERE id = ?`,
    [secret, userId],
  );

  const uri = authenticator.keyuri(user.full_name, "POS Toko", secret);
  const qrDataUrl = await QRCode.toDataURL(uri);
  return { qrDataUrl, secret, otpauthUri: uri };
}

async function getTotpStatus(userId) {
  const [[user]] = await pool.query(
    `SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?`,
    [userId],
  );
  if (!user) {
    throw new HttpError(404, "user_not_found", "User tidak ditemukan");
  }
  return {
    enabled: !!user.totp_secret,
    enabledAt: user.totp_enabled_at,
  };
}

async function disableTotp(userId) {
  await pool.query(
    `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL WHERE id = ?`,
    [userId],
  );
}

// Dipanggil kasir (via layar checkout) setelah Owner menyebutkan kode 6
// digit dari app authenticator-nya lewat telepon. Cocokkan ke SEMUA user
// yang berhak jadi "Owner" (role-nya punya izin sell_below_cost) & sudah
// setup TOTP — bukan cuma satu akun — supaya toko dgn >1 pemilik tetap
// jalan. Berhasil -> terbitkan token sekali-pakai (below_cost_authorizations),
// BUKAN otorisasi permanen — token ini yang nanti dilampirkan ke POST
// /api/sales, bukan kodenya langsung (kode TOTP tidak pernah dikirim lagi
// setelah titik ini).
async function verifyAndIssueToken({ requestedByUserId, code }) {
  const trimmed = String(code || "").trim();
  if (!/^\d{6}$/.test(trimmed)) {
    throw new HttpError(400, "bad_request", "Kode otorisasi harus 6 digit angka");
  }

  const [candidates] = await pool.query(
    `SELECT u.id, u.totp_secret
     FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE p.module = 'sales' AND p.action = 'sell_below_cost'
       AND u.totp_secret IS NOT NULL AND u.is_active = 1`,
  );

  let authorizedByUserId = null;
  for (const candidate of candidates) {
    if (authenticator.verify({ token: trimmed, secret: candidate.totp_secret })) {
      authorizedByUserId = candidate.id;
      break;
    }
  }
  if (!authorizedByUserId) {
    throw new HttpError(
      401,
      "invalid_code",
      "Kode otorisasi salah atau kedaluwarsa — minta Owner baca ulang kode terbaru dari app-nya.",
    );
  }

  const codeHash = sha256(trimmed);
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

  try {
    await pool.query(
      `INSERT INTO below_cost_authorizations
        (id, token, code_hash, authorized_by_user_id, requested_by_user_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), token, codeHash, authorizedByUserId, requestedByUserId, expiresAt],
    );
  } catch (err) {
    // uq_bca_owner_code — kode yang SAMA dari Owner yang SAMA sudah pernah
    // dipakai (proteksi replay, lihat catatan di migrasi). Owner tinggal
    // tunggu app-nya ganti kode (maks 30 detik) lalu coba lagi.
    if (err.code === "ER_DUP_ENTRY") {
      throw new HttpError(
        409,
        "code_already_used",
        "Kode ini sudah pernah dipakai — tunggu kode berganti di app Owner (maks 30 detik) lalu coba lagi.",
      );
    }
    throw err;
  }

  return { token, expiresAt: expiresAt.toISOString() };
}

// Dipanggil DI DALAM transaksi checkout (SalesService.createSale), sekali
// nota itu benar-benar akan disimpan — token baru dianggap "terpakai" di
// sini (bukan saat verifyAndIssueToken), supaya checkout yang gagal karena
// alasan LAIN (mis. stok kurang) tidak ikut membakar otorisasi yang sudah
// susah payah diminta dari Owner.
async function consumeToken(conn, { token, requestedByUserId, saleId }) {
  const [[row]] = await conn.query(
    `SELECT * FROM below_cost_authorizations WHERE token = ? FOR UPDATE`,
    [token],
  );
  if (
    !row ||
    row.requested_by_user_id !== requestedByUserId ||
    row.consumed_at !== null ||
    new Date(row.expires_at).getTime() <= Date.now()
  ) {
    throw new HttpError(
      403,
      "authorization_invalid",
      "Kode otorisasi tidak valid, sudah dipakai, atau kedaluwarsa — minta otorisasi ulang ke Owner.",
    );
  }
  await conn.query(
    `UPDATE below_cost_authorizations SET consumed_at = NOW(), consumed_sale_id = ? WHERE id = ?`,
    [saleId, row.id],
  );
  return { authorizedByUserId: row.authorized_by_user_id };
}

module.exports = {
  roleHasSellBelowCostPermission,
  setupTotp,
  getTotpStatus,
  disableTotp,
  verifyAndIssueToken,
  consumeToken,
};
