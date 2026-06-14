# billy-mcp

**An MCP server for [billy.dk](https://www.billy.dk) — Danish accounting, controllable from Claude (or any MCP-compatible AI client) over the official Billy v2 REST API.**

Read your invoices, categorise bank lines, draft new invoices from notes, upload receipt PDFs and attach them to bills, run a P&L on demand, prep MOMS reports, browse the audit log. 65 tools covering the full Billy v2 surface. Write operations are gated behind an explicit `confirm: true` so the AI cannot post to your books without per-call acknowledgement.

- **Language:** TypeScript, Node 20+
- **Auth:** personal access token (`X-Access-Token` header, no OAuth dance)
- **Transport:** stdio MCP, install once in your client's config
- **License:** MIT — use freely, including commercially
- **Status:** v0.3.0, in production use on a real Danish ApS

---

## Why this exists

[Dinero](https://dinero.dk) (one of the two major Danish accounting platforms) gates developer API access behind a partner approval process that's effectively closed to solo founders and small studios. Billy's API is open: a personal access token, well-documented endpoints, no gatekeeping. This MCP wraps it.

If you run a Danish ApS or sole proprietorship on Billy and you're tired of clicking through the UI for routine bookkeeping, this gives you natural-language control over the entire account, with a built-in safety pattern so the AI can't quietly mess up your books.

---

## Install in 30 seconds (non-technical path)

If you're using **Claude Code** (or any AI client with shell + filesystem access), copy this prompt into your client and let the agent install everything for you:

> Install the billy-mcp from https://github.com/cimalys/billy-mcp into my Claude config so I can manage my billy.dk accounting through chat.
>
> Steps:
> 1. Clone https://github.com/cimalys/billy-mcp to ~/billy-mcp
> 2. Run `cd ~/billy-mcp && npm install && npm run build`
> 3. Ask me for my Billy API token (I'll get it from billy.dk → Settings → Access tokens → Create new). Save it to ~/billy-mcp/.env as `BILLY_API_TOKEN=...`
> 4. Add the MCP to my user-scope Claude config: `claude mcp add --scope user --transport stdio billy --env BILLY_API_TOKEN=<token> -- node ~/billy-mcp/dist/index.js`
> 5. Confirm with `claude mcp list` — billy should show as Connected.
>
> When done, run `billy_whoami` to verify everything works.

The AI handles the cloning, building, token prompting, config edit, and verification. You just paste your token when asked. Total time: under 2 minutes.

---

## Install (technical path)

```bash
# 1. Clone
git clone https://github.com/cimalys/billy-mcp.git ~/billy-mcp
cd ~/billy-mcp

# 2. Build
npm install
npm run build

# 3. Get your Billy access token
#    billy.dk → Settings → Access tokens → Create new
#    Tokens do not expire.
echo "BILLY_API_TOKEN=your_token_here" > .env

# 4. Smoke-test the token against the live Billy API
npm run smoke
# Expected: prints your org, three unmatched bank lines, three draft invoices.

# 5. Wire into Claude Code
TOKEN=$(awk -F= '/^BILLY_API_TOKEN=/{sub(/^BILLY_API_TOKEN=/,"",$0); print}' .env | tr -d '\r\n "')
claude mcp add --scope user --transport stdio billy \
  --env "BILLY_API_TOKEN=$TOKEN" \
  -- node "$PWD/dist/index.js"

# 6. Verify
claude mcp list | grep billy   # → "billy: node ... ✔ Connected"
```

Restart your Claude session. The billy tools become available immediately.

---

## How it's safe — the write-guard

**Every mutating tool refuses to execute without `confirm: true`.** Without confirm, the tool returns a dry-run preview of the API call it would have made.

### Example — without confirm

```json
{
  "tool": "billy_create_invoice",
  "input": { "invoice": { "contactId": "abc", "entryDate": "2026-06-14", ... } }
}
```

Returns:

```
[DRY RUN — write blocked]

Action: create invoice

Payload that would be sent to Billy:
{
  "invoice": { "contactId": "abc", "entryDate": "2026-06-14", ... }
}

To execute, re-issue the same tool call with the additional field: "confirm": true
(This is a hard guardrail in the MCP — no Billy write happens until you explicitly confirm.)
```

### Example — with confirm

```json
{
  "tool": "billy_create_invoice",
  "input": { "invoice": { ... }, "confirm": true }
}
```

Now the call hits Billy, returns the created invoice, and logs to stderr:

```
[billy-mcp 2026-06-14T09:25:00Z] WRITE confirmed → create invoice
```

This means an AI client can never autonomously write to your books in a single turn. It can suggest, preview, and explain — but the actual mutation requires you (or the LLM, with your visible agreement) to issue a second call with confirm.

**Read tools are not gated.** Listing, getting, reports, audit log, reference data — all fire immediately. The guardrail protects only state changes.

---

## Tool catalog (65 tools)

### Organisation
- `billy_whoami` — current org details (read-only)
- `billy_update_organization` — update fields like VAT no, payment terms, address (write-guarded)

### Invoices
- `billy_list_invoices`, `billy_get_invoice` — read
- `billy_create_invoice`, `billy_update_invoice`, `billy_delete_invoice` — write-guarded
- `billy_approve_invoice` — draft → approved (write-guarded)
- `billy_send_invoice` — send by email via Billy (write-guarded)

### Bills (expenses / supplier invoices)
- `billy_list_bills`, `billy_get_bill` — read
- `billy_create_bill`, `billy_update_bill`, `billy_delete_bill`, `billy_approve_bill` — write-guarded

### Contacts & contact persons
- `billy_list_contacts`, `billy_get_contact`, `billy_list_contact_persons` — read
- `billy_create_contact`, `billy_update_contact`, `billy_delete_contact`, `billy_create_contact_person` — write-guarded

### Products
- `billy_list_products`, `billy_get_product` — read
- `billy_create_product`, `billy_update_product`, `billy_delete_product` — write-guarded

### Chart of accounts
- `billy_list_accounts`, `billy_get_account`, `billy_list_account_groups` — read
- `billy_create_account`, `billy_update_account` — write-guarded

### Bank accounts, payments, lines (reconciliation)
- `billy_get_bank_account`, `billy_list_bank_payments`, `billy_list_bank_lines`, `billy_get_bank_line` — read
- `billy_create_bank_account`, `billy_create_bank_payment`, `billy_match_bank_line`, `billy_unmatch_bank_line` — write-guarded

### Daybook (manual journal entries)
- `billy_list_daybooks`, `billy_list_daybook_transactions` — read
- `billy_create_daybook_transaction` — write-guarded

### Tax (MOMS / VAT)
- `billy_list_tax_rates`, `billy_list_tax_rulesets`, `billy_list_sales_tax_returns`, `billy_get_sales_tax_return` — read

### Reports
- `billy_report_profit_loss` — P&L for a date range
- `billy_report_balance` — balance sheet at a point in time
- `billy_report_sales_tax` — MOMS report
- `billy_report_invoiced_sales` — invoiced sales by contact/product

### Postings & audit
- `billy_list_postings` — underlying ledger entries
- `billy_list_action_stream` — recent activity log

### Webhooks
- `billy_list_webhooks` — read
- `billy_create_webhook`, `billy_delete_webhook` — write-guarded

### Reference data (all read-only)
- `billy_list_currencies`, `billy_list_countries`, `billy_list_payment_terms_modes`, `billy_list_units`

### Files / attachments
- `billy_list_files`, `billy_get_file` — read
- `billy_upload_file` — upload a local PDF/JPG/PNG/GIF to Billy; returns id (write-guarded; other extensions rejected — Billy v2 limitation)
- `billy_attach_file_to_bill`, `billy_attach_file_to_invoice` — write-guarded

---

## Example prompts after install

```
"Run billy_whoami and tell me my org details."

"Show me my outstanding invoices and total revenue."

"List unmatched bank lines from the last 30 days and propose a category for each."

"Draft an invoice to Acme ApS for 45,000 DKK for the AI Readiness Audit,
payment terms net 14. Show me the dry run first."

"Generate a P&L for 2026-06-01 to 2026-06-13."

"What was my biggest expense category this month?"

"Set my organisation's payment terms to net 14 days. Preview first."

"Upload /Users/me/Downloads/aws-jun.pdf to Billy, create a bill for AWS
240 EUR for cloud infrastructure, and attach the file. Preview each
step before confirming."
```

---

## Billy v2 API quirks this MCP works around

Three behaviours that aren't obvious from Billy's docs, patched in this MCP so you don't have to learn them the hard way:

1. **`PUT /v2/organization` returns 405** — the singular endpoint is GET-only. Org updates have to go to the plural endpoint with the org id: `PUT /v2/organizations/<id>`. `billy_update_organization` resolves the id from whoami first, then hits the right endpoint.

2. **`GET /v2/bankAccounts` returns 405** — Billy v2 doesn't let you list bank accounts. Single lookup by id works (`billy_get_bank_account`). For the default invoice bank account id, read it from `billy_whoami → organization.defaultInvoiceBankAccountId`.

3. **`GET /v2/bankLines` requires `accountId`** — the API rejects unfiltered list calls. The MCP marks `accountId` as required and points you at whoami for the default.

4. **`GET /v2/paymentMethods` returns 404** — the resource doesn't actually exist on Billy v2, despite appearing in some references. Tool removed in 0.3.0.

---

## Limitations & non-goals

- **Not a substitute for a Danish *revisor*.** Bogføringsloven 2022 puts the responsibility for accurate bookkeeping on company management. This MCP makes the AI a useful assistant; it does not replace professional accounting signoff.
- **No autonomous loop.** This is deliberately a single-tool-call MCP. If you want an agent that polls bank lines nightly and auto-categorises them, that's a separate layer you'd build on top.
- **Personal-token auth only.** OAuth flow not implemented (no need for a single-user setup; would be needed for SaaS multi-tenant).
- **File upload requires a local path.** `billy_upload_file` reads from a path on the same machine the MCP runs on. To ingest a receipt that lives only in your email, either save it to disk first or forward it to your Billy bill-capture address (`organization.billEmailAddress` from whoami) — Billy auto-creates a draft bill.

---

## Contributing

Issues and PRs welcome. Particular interest in:

- File upload tool (multipart `POST /v2/files`)
- Webhook receiver pattern for real-time reconciliation
- Coverage of the `umbrellaUsers` and `apps` endpoints (multi-org)
- Equivalent MCPs for [Dinero](https://dinero.dk) once their API opens up

---

## Author

Maintained by [Cimalys ApS](https://cimalys.com) — Copenhagen.

If you'd like a Billy MCP deployed for your firm, a custom integration with other Danish business systems, or general AI implementation work, get in touch at [nlej@cimalys.com](mailto:nlej@cimalys.com).
