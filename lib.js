/**
 * Shared helpers used by both the daily monitor (index.js) and the
 * historical backfill (backfill.js).
 */
require("dotenv").config();

const CORRECTION_API_URL =
  process.env.CORRECTION_API_URL ||
  "https://dms-beta.fieldassist.io/api/temp/invoice/adjust-credit-note";

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const ASANA_TRACKING_TASK = process.env.ASANA_TRACKING_TASK || "1215141632074719";
const DRY_RUN = process.env.DRY_RUN === "true";

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

function labelInvoice(invoiceNumberById, id) {
  return invoiceNumberById[id] ? `${id} (${invoiceNumberById[id]})` : `${id}`;
}

module.exports = {
  CORRECTION_API_URL,
  ASANA_TOKEN,
  ASANA_TRACKING_TASK,
  DRY_RUN,
  callCorrectionAPI,
  postAsanaComment,
  labelInvoice,
};
