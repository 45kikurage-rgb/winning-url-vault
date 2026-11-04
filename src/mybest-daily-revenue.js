import { REVENUE_START_MONTH } from "./ledger.js";

const dayMillis = 86400000;
const jstOffset = 9 * 3600000;
const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const yen = value => Number.isSafeInteger(value) && value >= 0;

// Monthly totals and live item counts must be read in the same database snapshot.
export async function readMyBestRevenue(db, month, at = Date.now()) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError("invalid month");
  const today = new Date(at + jstOffset).toISOString().slice(0, 10);
  if (month < REVENUE_START_MONTH || month > today.slice(0, 7)) return null;
  const [year, number] = month.split("-").map(Number);
  const start = Date.UTC(year, number - 1, 1);
  const end = Date.UTC(year, number, 1);
  const through = new Date(Math.min(end - dayMillis, Date.parse(today) - dayMillis)).toISOString().slice(0, 10);
  const { results } = await db.prepare(`
    WITH daily AS (
      SELECT date(datetime(i.received_at, '+9 hours')) AS day,
        a.product_id, a.campaign_id, p.unit_price, COUNT(*) AS winner_count
      FROM items i
      JOIN item_campaign_assignments a ON a.item_id = i.id
      JOIN ledger_products p ON p.product_id = a.product_id
      WHERE i.status = 'active'
        AND datetime(i.received_at) >= ? AND datetime(i.received_at) < ?
      GROUP BY day, a.product_id, a.campaign_id, p.unit_price
    )
    SELECT 'daily' AS kind, day, product_id, campaign_id, unit_price, winner_count,
      NULL AS amount, NULL AS source_revision, NULL AS finalized_at
    FROM daily
    UNION ALL
    SELECT 'monthly', NULL, product_id, campaign_id, unit_price, winner_count,
      amount, source_revision, finalized_at
    FROM product_monthly_revenue WHERE month = ?
  `).bind(sqlTime(start - jstOffset), sqlTime(end - jstOffset), month).all();

  const products = new Map();
  const computed = new Map();
  const days = Object.create(null);
  let verifiedTotal = 0;
  for (let day = start; day < end; day += dayMillis) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (date <= through) days[date] = 0;
  }
  for (const row of results) {
    if (!yen(row.winner_count) || !yen(row.unit_price)) return null;
    const amount = row.unit_price * row.winner_count;
    if (!yen(amount)) return null;
    if (row.kind === "monthly") {
      if (row.finalized_at !== null || !yen(row.source_revision) || row.amount !== amount) return null;
      products.set(row.product_id, {
        product_id: row.product_id, campaign_id: row.campaign_id, unit_price: row.unit_price,
        winner_count: row.winner_count, amount, source_revision: row.source_revision
      });
      verifiedTotal += amount;
      if (!yen(verifiedTotal)) return null;
      continue;
    }
    if (typeof row.day !== "string" || row.day > today) return null;
    const item = computed.get(row.product_id) ?? { campaign_id: row.campaign_id, unit_price: row.unit_price, count: 0 };
    if (item.campaign_id !== row.campaign_id || item.unit_price !== row.unit_price) return null;
    item.count += row.winner_count;
    if (!yen(item.count)) return null;
    computed.set(row.product_id, item);
    if (Object.hasOwn(days, row.day)) {
      days[row.day] += amount;
      if (!yen(days[row.day])) return null;
    }
  }
  for (const [id, product] of products) {
    const counts = computed.get(id);
    if (!counts ? product.winner_count !== 0 :
      counts.count !== product.winner_count || counts.campaign_id !== product.campaign_id ||
      counts.unit_price !== product.unit_price) return null;
    computed.delete(id);
  }
  if (computed.size) return null;
  return { month, through: through.startsWith(month) ? through : null, days, products: [...products.values()] };
}
