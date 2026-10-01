/**
 * CN Adjustment Monitor — historical backfill
 *
 * Covers a gap where the daily Railway job wasn't running. Finds invoices
 * created within [BACKFILL_START, BACKFILL_END] whose linked Credit Notes
 * are still stuck (IsAdjusted=false) *as of now* — there's no way to know
 * historical IsAdjusted state, only what's still unresolved today. Runs one
 * query per day (for visible progress) and reports/corrects everything
 * found as a single consolidated run at the end.
 *
 * Env vars: same as index.js, plus
 *   BACKFILL_START  - YYYY-MM-DD, inclusive (default 2026-07-11)
 *   BACKFILL_END    - YYYY-MM-DD, inclusive (default today)
 */
require("dotenv").config();
const { Client } = require("pg");
const { ASANA_TRACKING_TASK, DRY_RUN, callCorrectionAPI, postAsanaComment, labelInvoice } = require("./lib");

const START_DATE = process.env.BACKFILL_START || "2026-07-11";
const END_DATE = process.env.BACKFILL_END || new Date().toISOString().slice(0, 10);

// ─── DB ──────────────────────────────────────────────────────────────────────

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
    SELECT
      "Id"            AS invoice_id,
      "CompanyId"     AS company_id,
      "InvoiceNo"     AS invoice_number,
      "CreditNoteIds" AS cn_ids,
      "CreatedAt"     AS created_at
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

function groupByDay(stuckCases) {
  const byDay = {};
  for (const row of stuckCases) {
    const day = row.invoice_created_at.toISOString().slice(0, 10);
    (byDay[day] ||= []).push(row);
  }
  return byDay;
}

// ─── Asana ───────────────────────────────────────────────────────────────────

function buildBackfillComment(startDate, endDate, stuckCases, results, byDay) {
  const total = stuckCases.length;
  const uniqueInvoices = [...new Set(stuckCases.map((r) => r.invoice_id))];
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  const invoiceNumberById = {};
  for (const row of stuckCases) invoiceNumberById[row.invoice_id] = row.invoice_number;

  const dayRows = Object.keys(byDay)
    .sort()
    .map((day) => `<li>${day}: ${byDay[day].length} stuck CN(s)</li>`)
    .join("");

  const failedRows = results
    .filter((r) => !r.success)
    .map((r) => `<li>Invoice <strong>${labelInvoice(invoiceNumberById, r.invoiceId)}</strong>: ${r.error || JSON.stringify(r.body)}</li>`)
    .join("");

  return `
<strong>📊 CN Adjustment Monitor — BACKFILL ${startDate} to ${endDate}</strong>
<hr/>
<em>Covers the window the Railway job was down. Historical daily status can't be reconstructed — this reflects what is still stuck as of now.</em>
<strong>Summary</strong>
<ul>
  <li>Stuck CNs detected: <strong>${total}</strong></li>
  <li>Unique invoices affected: <strong>${uniqueInvoices.length}</strong></li>
  <li>Correction API calls succeeded: <strong>${successCount}</strong></li>
  <li>Correction API calls failed: <strong>${failCount}</strong></li>
</ul>
<strong>Breakdown by invoice creation day</strong>
<ul>${dayRows || "<li>None</li>"}</ul>
${
  failCount > 0
    ? `<strong>⚠️ Failed Corrections</strong><ul>${failedRows}</ul>`
    : `<strong>✅ All corrections applied successfully</strong>`
}
<hr/>
<em>Run time: ${new Date().toISOString()} | Script: cn-monitor backfill</em>
`.trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== CN Monitor BACKFILL: ${START_DATE} to ${END_DATE} ===`);

  const companyIds = process.env.COMPANY_IDS.split(',').map(Number);
  console.log(`[INFO] Monitoring companies: ${companyIds.join(', ')}`);
  console.log(`[INFO] DRY_RUN: ${DRY_RUN}`);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  console.log("[OK] DB connected");

  const days = dateRange(START_DATE, END_DATE);
  console.log(`[INFO] Checking ${days.length} day(s), one query per day`);

  let stuckCases = [];
  try {
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const dayCases = await getStuckCasesForDay(client, companyIds, day);
      console.log(`[INFO] (${i + 1}/${days.length}) ${day}: ${dayCases.length} stuck CN(s)`);
      stuckCases = stuckCases.concat(dayCases);
    }
  } finally {
    await client.end();
  }

  const byDay = groupByDay(stuckCases);
  console.log(`[OK] Stuck CNs found across range: ${stuckCases.length} across ${Object.keys(byDay).length} day(s)`);
  for (const day of Object.keys(byDay).sort()) {
    console.log(`  ${day}: ${byDay[day].length} stuck CN(s)`);
  }

  if (stuckCases.length === 0) {
    console.log("[OK] No stuck CNs in range — posting clean backfill report to Asana");
    const html = `
<strong>✅ CN Adjustment Monitor — BACKFILL ${START_DATE} to ${END_DATE}</strong>
<hr/>
No stuck Credit Notes detected for invoices created in this range.
<em>Run time: ${new Date().toISOString()}</em>
    `.trim();
    await postAsanaComment(ASANA_TRACKING_TASK, html);
    return;
  }

  const uniqueInvoiceIds = [...new Set(stuckCases.map((r) => r.invoice_id))];
  console.log(`[INFO] Unique invoices to correct: ${uniqueInvoiceIds.length}`);

  const results = [];
  for (const invoiceId of uniqueInvoiceIds) {
    console.log(`[INFO] Calling correction API for invoiceId=${invoiceId}`);
    const result = await callCorrectionAPI(invoiceId);
    results.push({ invoiceId, ...result });

    if (!result.success) {
      console.error(`[FAIL] invoiceId=${invoiceId}:`, result.error || result.body);
    } else {
      console.log(`[OK] invoiceId=${invoiceId} corrected`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  const html = buildBackfillComment(START_DATE, END_DATE, stuckCases, results, byDay);
  await postAsanaComment(ASANA_TRACKING_TASK, html);

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log(`\n=== Backfill done: ${succeeded} corrected, ${failed} failed ===\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
