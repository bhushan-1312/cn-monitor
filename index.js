/**
 * CN Adjustment Monitor
 *
 * Detects Credit Notes that are stuck (IsAdjusted=false) but whose ID
 * appears in a SecondarySalesInvoice.CreditNoteIds array, then calls
 * the correction API per invoiceId and posts a daily summary comment
 * to a pinned Asana tracking task.
 *
 * Env vars required:
 *   DATABASE_URL          - PostgreSQL connection string
 *   ASANA_TOKEN           - Asana personal access token
 *   ASANA_TRACKING_TASK   - GID of the master tracking task (1215141632074719)
 *   CORRECTION_API_URL    - https://dms-beta.fieldassist.io/api/temp/invoice/adjust-credit-note
 *   DRY_RUN               - (optional) set to "true" to skip API calls and DB reads
 */
require("dotenv").config();
const { Client } = require("pg");

// ─── Config ──────────────────────────────────────────────────────────────────

const CORRECTION_API_URL =
  process.env.CORRECTION_API_URL ||
  "https://dms-beta.fieldassist.io/api/temp/invoice/adjust-credit-note";

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const ASANA_TRACKING_TASK = process.env.ASANA_TRACKING_TASK || "1215141632074719";
const DRY_RUN = process.env.DRY_RUN === "true";

// ─── DB ──────────────────────────────────────────────────────────────────────

  async function getStuckCases(client) {
    const companyIds = process.env.COMPANY_IDS.split(',').map(Number);
    console.log(`[INFO] Monitoring companies: ${companyIds.join(', ')}`);
        console.log(`[INFO] DRY_RUN: ${DRY_RUN}`);

  // Step 1: invoices created in last 24h with CreditNoteIds
  const since =  new Date(Date.now() - 24*60*60*1000).toISOString();
  const invoiceResult = await client.query(`
    SELECT
      "Id"            AS invoice_id,
      "CompanyId"     AS company_id,
      "InvoiceNo"     AS invoice_number,
      "CreditNoteIds" AS cn_ids
    FROM tran."SecondarySalesInvoice"
    WHERE "CompanyId" = ANY($2::bigint[]) AND "CreditNoteIds" IS NOT NULL
      AND "CreditNoteIds" != ''
      AND "CreatedAt" > $1 
  `, [since,companyIds]);
  if (invoiceResult.rows.length === 0) return [];

  // Step 2: split comma-separated CN IDs, map back to invoice
  const cnIdMap = {};
  for (const row of invoiceResult.rows) {
   // console.table(row);
   // console.table(invoiceResult.rows);
   // console.log(row.cn_ids.split(','))
    const ids = row.cn_ids.split(',').map(id => parseInt(id.trim(), 10)).filter(Boolean);
   // console.log(ids);
    for (const cnId of ids) {
      console.log(`[DEBUG] Invoice ${row.invoice_id} has CN IDs:`, ids);
      cnIdMap[cnId] = {
        invoice_id: row.invoice_id,
        company_id: row.company_id,
        invoice_number: row.invoice_number,
      };
    }
  }
 //console.table(cnIdMap);

  const allCnIds = Object.keys(cnIdMap).map(Number);
  if (allCnIds.length === 0) return [];

  // Step 3: check which CNs have IsAdjusted = false
  const cnIdList = allCnIds.join(',');
const companyIdList = companyIds.join(',');

const cnResult = await client.query(`
    SELECT
      "Id"        AS cn_id,
      "CNCode"    AS cn_number,
      "CreatedAt" AS cn_created_at
    FROM tran."CreditNote"
    WHERE  "Id" = ANY(ARRAY[${cnIdList}]::bigint[])
      AND "CompanyId" = ANY(ARRAY[${companyIdList}]::bigint[])
      AND "IsAdjusted" = false
      AND "CreationContext"='hsn_bulk_upload_notes'
`);
//console.table(cnResult.rows);

  // Step 4: merge
  return cnResult.rows.map(cn => ({
    ...cnIdMap[cn.cn_id],
    cn_id: cn.cn_id,
    cn_number: cn.cn_number,
    cn_created_at: cn.cn_created_at,
  }));
}


// ─── Correction API ───────────────────────────────────────────────────────────

async function callCorrectionAPI(invoiceId) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would call correction API for invoiceId=${invoiceId}`);
    return { success: true, dry: true };
  }

  try {
    const res = await fetch(CORRECTION_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceId }),
    });

    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    if (!res.ok) {
      return { success: false, status: res.status, body };
    }
    return { success: true, status: res.status, body };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Asana ───────────────────────────────────────────────────────────────────

async function postAsanaComment(taskGid, htmlText) {
  if (!ASANA_TOKEN) {
    console.warn("[WARN] ASANA_TOKEN not set — skipping Asana comment");
    return;
  }
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would post Asana comment to task ${taskGid}`);
    console.log(htmlText);
    return;
  }

  const res = await fetch(`https://app.asana.com/api/1.0/tasks/${taskGid}/stories`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ASANA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: { html_text: `<body>${htmlText}</body>`, is_pinned: false } }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[ERROR] Asana comment failed: ${res.status} — ${err}`);
  } else {
    console.log("[OK] Asana comment posted");
  }
}

function buildAsanaComment(date, stuckCases, results) {
  const total = stuckCases.length;
  const uniqueInvoices = [...new Set(stuckCases.map((r) => r.invoice_id))];
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  // Group by company for summary table
  const byCompany = {};
  for (const row of stuckCases) {
    const key = row.company_id;
    if (!byCompany[key]) byCompany[key] = { company_id: row.company_id, count: 0, invoices: new Set() };
    byCompany[key].count++;
    byCompany[key].invoices.add(row.invoice_id);
  }

  const companyRows = Object.values(byCompany)
    .sort((a, b) => b.count - a.count)
    .map(
      (c) =>
        `<li>CompanyId <strong>${c.company_id}</strong>: ${c.count} stuck CN(s) across ${c.invoices.size} invoice(s) — Invoice IDs: <strong>${[...c.invoices].join(', ')}</strong></li>`
    )
    .join("");

  const failedRows = results
    .filter((r) => !r.success)
    .map(
      (r) =>
        `<li>InvoiceId <strong>${r.invoiceId}</strong>: ${r.error || JSON.stringify(r.body)}</li>`
    )
    .join("");

  return `
<strong>📊 CN Adjustment Monitor — ${date}</strong>
<hr/>
<strong>Summary</strong>
<ul>
  <li>Stuck CNs detected: <strong>${total}</strong></li>
  <li>Unique invoices affected: <strong>${uniqueInvoices.length}</strong></li>
  <li>Correction API calls succeeded: <strong>${successCount}</strong></li>
  <li>Correction API calls failed: <strong>${failCount}</strong></li>
</ul>
<strong>Breakdown by Company</strong>
<ul>${companyRows || "<li>None</li>"}</ul>
${
  failCount > 0
    ? `<strong>⚠️ Failed Corrections</strong><ul>${failedRows}</ul>`
    : `<strong>✅ All corrections applied successfully</strong>`
}
<hr/>
<em>Run time: ${new Date().toISOString()} | Script: cn-monitor</em>
`.trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n=== CN Monitor run: ${today} ===`);

  // 1. Connect to DB
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("[OK] DB connected");

  // 2. Detect stuck CNs
  let stuckCases;
  try {
    stuckCases = await getStuckCases(client);
    console.log(`[OK] Stuck CNs found: ${stuckCases.length}`);
  } finally {
    await client.end();
  }

  if (stuckCases.length === 0) {
    console.log("[OK] No stuck CNs — posting clean report to Asana");
    const html = `
<strong>✅ CN Adjustment Monitor — ${today}</strong>
<hr/>
No stuck Credit Notes detected today. All CNs in <code>tran.CreditNote</code> linked via <code>SecondarySalesInvoice.CreditNoteIds</code> have <code>IsAdjusted = true</code>.
<em>Run time: ${new Date().toISOString()}</em>
    `.trim();
    await postAsanaComment(ASANA_TRACKING_TASK, html);
    return;
  }

  // 3. Deduplicate by invoiceId — one API call per invoice
  const uniqueInvoiceIds = [...new Set(stuckCases.map((r) => r.invoice_id))];
  console.log(`[INFO] Unique invoices to correct: ${uniqueInvoiceIds.length}`);

  // 4. Call correction API for each invoice
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

    // Small delay to avoid hammering the API
    await new Promise((r) => setTimeout(r, 300));
  }

  // 5. Post to Asana
  const html = buildAsanaComment(today, stuckCases, results);
  await postAsanaComment(ASANA_TRACKING_TASK, html);

  // 6. Print final summary
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log(`\n=== Done: ${succeeded} corrected, ${failed} failed ===\n`);

  // Exit non-zero if any corrections failed so Railway/cron can alert
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
