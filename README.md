# CN Adjustment Monitor

Detects Credit Notes stuck with `IsAdjusted = false` that are already linked to an invoice via `SecondarySalesInvoice.CreditNoteIds`, calls the correction API per invoice, and posts a daily summary comment to a pinned Asana tracking task.

---

## How it works

1. **Detect** — queries `tran.CreditNote` joined to `tran.SecondarySalesInvoice` to find CNs where `IsAdjusted = false` but the CN ID is present in `CreditNoteIds`
2. **Correct** — calls `POST /api/temp/invoice/adjust-credit-note` with `{ invoiceId }` once per unique invoice
3. **Report** — posts a formatted HTML comment to the Asana tracking task with daily counts, breakdown by company, and any failures

---

## Setup

### Local
```bash
npm install
cp .env.example .env
# fill in .env values
node index.js

# safe dry-run (no API calls)
npm run dry-run
```

### Railway (cron)
1. Create a new Railway service from this repo
2. Set env vars in Railway dashboard (from `.env.example`)
3. `railway.toml` schedules the run at **09:00 UTC daily** — adjust `schedule` as needed

---

## Env vars

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ASANA_TOKEN` | Asana personal access token |
| `ASANA_TRACKING_TASK` | GID of the pinned tracking task (`1215141632074719`) |
| `CORRECTION_API_URL` | `https://dms-beta.fieldassist.io/api/temp/invoice/adjust-credit-note` |
| `DRY_RUN` | `true` = log only, no API calls, no DB writes |

---

## Detection query

```sql
SELECT
  ssi."Id"              AS invoice_id,
  ssi."CompanyId"       AS company_id,
  ssi."InvoiceNumber"   AS invoice_number,
  cn."Id"               AS cn_id,
  cn."CreditNoteNumber" AS cn_number,
  cn."CreatedOn"        AS cn_created_at
FROM tran."SecondarySalesInvoice" ssi
JOIN tran."CreditNote" cn
  ON cn."Id" = ANY(ssi."CreditNoteIds")
WHERE cn."IsAdjusted" = false
  AND ssi."CreditNoteIds" IS NOT NULL
  AND array_length(ssi."CreditNoteIds", 1) > 0
ORDER BY cn."CreatedOn" DESC;
```

---

## Asana output (sample)

Each daily run appends a comment like:

```
📊 CN Adjustment Monitor — 2026-06-08

Summary
- Stuck CNs detected: 3
- Unique invoices affected: 2
- Correction API calls succeeded: 2
- Correction API calls failed: 0

Breakdown by Company
- CompanyId 11464: 3 stuck CN(s) across 2 invoice(s)

✅ All corrections applied successfully
```

---

## Exit codes

- `0` — all corrections succeeded (or no stuck CNs found)
- `1` — one or more correction API calls failed (Railway will mark run as failed)
