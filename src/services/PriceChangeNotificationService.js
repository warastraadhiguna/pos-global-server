const pool = require('../config/db');

// Daftar notifikasi WAJIB (bukan toast yang hilang) — dibaca admin di
// halaman tersendiri. Terbaru dulu, sekaligus rincian per level (lines).
async function listEvents({ limit = 100 } = {}) {
  const [events] = await pool.query(
    `SELECT e.id, e.product_id, p.name AS product_name, p.sku,
            e.old_avg_cost, e.new_avg_cost, e.trigger_source, e.reference_type, e.reference_uuid,
            e.is_read, e.created_at
     FROM price_change_events e
     JOIN products p ON p.id = e.product_id
     ORDER BY e.created_at DESC
     LIMIT ?`,
    [limit]
  );
  if (events.length === 0) return [];

  const eventIds = events.map((e) => e.id);
  const [lines] = await pool.query(
    `SELECT l.event_id, l.unit_id, un.name AS unit_name, l.price_level_id, pl.name AS price_level_name,
            l.markup_percent, l.old_price, l.new_price
     FROM price_change_event_lines l
     JOIN units un ON un.id = l.unit_id
     JOIN price_levels pl ON pl.id = l.price_level_id
     WHERE l.event_id IN (${eventIds.map(() => '?').join(',')})
     ORDER BY pl.name, un.name`,
    eventIds
  );

  const linesByEvent = new Map();
  for (const line of lines) {
    if (!linesByEvent.has(line.event_id)) linesByEvent.set(line.event_id, []);
    linesByEvent.get(line.event_id).push(line);
  }

  return events.map((e) => ({ ...e, lines: linesByEvent.get(e.id) || [] }));
}

async function countUnread() {
  const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM price_change_events WHERE is_read = 0`);
  return row.n;
}

async function markRead(eventId) {
  await pool.query(`UPDATE price_change_events SET is_read = 1 WHERE id = ?`, [eventId]);
}

async function markAllRead() {
  await pool.query(`UPDATE price_change_events SET is_read = 1 WHERE is_read = 0`);
}

module.exports = { listEvents, countUnread, markRead, markAllRead };
