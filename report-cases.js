/**
 * One-off: build the detailed case list (CN id/number/created date, invoice
 * id/number) for the current backfill range and post it to a specific Asana
 * task (not the default tracking task).
 */
require("dotenv").config();
const { Client } = require("pg");
const { ASANA_TOKEN, postAsanaComment } = require("./lib");

const START_DATE = process.env.BACKFILL_START || "2026-07-11";
const END_DATE = process.env.BACKFILL_END || new Date().toISOString().slice(0, 10);
const TARGET_TASK_GID = process.argv[2];

if (!TARGET_TASK_GID) {
  console.error("Usage: node report-cases.js <asana_task_gid>");
  process.exit(1);
}

function dateRange(startDate, endDateInclusive) {
  const days = [];
  const cur = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDateInclusive}T00:00:00.000Z`);
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

async function getStuckCasesForDay(client, companyIds, day) {
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const invoiceResult = await client.query(`
    SELECT "Id" AS invoice_id, "CompanyId" AS company_id, "InvoiceNo" AS invoice_number,
           "CreditNoteIds" AS cn_ids, "CreatedAt" AS created_at
    FROM tran."SecondarySalesInvoice"
    WHERE "CompanyId" = ANY($3::bigint[]) AND "CreditNoteIds" IS NOT NULL
      AND "CreditNoteIds" != ''
      AND "CreatedAt" >= $1 AND "CreatedAt" < $2
  `, [dayStart, dayEnd.toISOString(), companyIds]);
  if (invoiceResult.rows.length === 0) return [];

  const cnIdMap = {};
  for (const row of invoiceResult.rows) {
    const ids = row.cn_ids.split(',').map(id => parseInt(id.trim(), 10)).filter(Boolean);
    for (const cnId of ids) {
      cnIdMap[cnId] = {
        invoice_id: row.invoice_id,
        company_id: row.company_id,
        invoice_number: row.invoice_number,
        invoice_created_at: row.created_at,
      };
    }
  }

  const allCnIds = Object.keys(cnIdMap).map(Number);
  if (allCnIds.length === 0) return [];

  const cnResult = await client.query(`
    SELECT "Id" AS cn_id, "CNCode" AS cn_number, "CreatedAt" AS cn_created_at
    FROM tran."CreditNote"
    WHERE "Id" = ANY($1::bigint[]) AND "CompanyId" = ANY($2::bigint[]) AND "IsAdjusted" = false
  `, [allCnIds, companyIds]);

  return cnResult.rows.map(cn => ({
    ...cnIdMap[cn.cn_id],
    cn_id: cn.cn_id,
    cn_number: cn.cn_number,
    cn_created_at: cn.cn_created_at,
  }));
}

(async () => {
  const companyIds = process.env.COMPANY_IDS.split(',').map(Number);
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  console.log("[OK] DB connected");

  const days = dateRange(START_DATE, END_DATE);
  let stuckCases = [];
  for (let i = 0; i < days.length; i++) {
    const dayCases = await getStuckCasesForDay(client, companyIds, days[i]);
    stuckCases = stuckCases.concat(dayCases);
  }
  await client.end();

  stuckCases.sort((a, b) => a.cn_created_at - b.cn_created_at);

  console.log(`[OK] Found ${stuckCases.length} stuck CN(s) for compan${companyIds.length > 1 ? "ies" : "y"} ${companyIds.join(', ')}`);

  const rows = stuckCases
    .map((c, i) => {
      const cnDate = c.cn_created_at.toISOString().slice(0, 10);
      return `<li>#${i + 1} — CN <strong>${c.cn_number}</strong> (id ${c.cn_id}, created ${cnDate}) — to be adjusted against Invoice <strong>${c.invoice_number}</strong> (id ${c.invoice_id})</li>`;
    })
    .join("");

  const html = `
<strong>📊 Stuck Credit Note Adjustments — ${START_DATE} to ${END_DATE}</strong>
<hr/>
<strong>Total cases found: ${stuckCases.length}</strong>
<ul>${rows || "<li>None</li>"}</ul>
<hr/>
<em>Run time: ${new Date().toISOString()} | Script: cn-monitor report-cases</em>
`.trim();

  console.log("\n--- Comment preview ---\n");
  console.log(html.replace(/<[^>]+>/g, (tag) => (tag === "<li>" ? "\n- " : "")));

  if (!ASANA_TOKEN) {
    console.error("[ERROR] ASANA_TOKEN not set — cannot post");
    process.exit(1);
  }

  await postAsanaComment(TARGET_TASK_GID, html);
})().catch((e) => {
  console.error("[FATAL]", e.message);
  process.exit(1);
});
