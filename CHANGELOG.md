# Changelog

## 0.3.2 — 2026-06-14

- `billy_upload_file` now validates the extension before hitting the API. Billy v2 only accepts pdf, jpg, jpeg, png, gif on /v2/files (verified empirically — anything else returns a generic 422). The MCP now rejects unsupported extensions up-front with a clear error message instead of forwarding the cryptic API error.
- MIME map trimmed to match the accepted set.

## 0.3.1 — 2026-06-14

- New tool: `billy_upload_file` — upload a local file (receipt PDF, supporting doc, etc.) to Billy via multipart. Returns the file metadata incl. id, which composes with `billy_attach_file_to_bill` / `billy_attach_file_to_invoice` for the full receipt → bill → attachment flow.
- MIME type auto-detected from the file extension (pdf, png, jpg, jpeg, gif, webp, heic, csv, txt, xml, json, xlsx, xls, docx, doc); `contentType` override available.
- Write-guarded like every other mutation.

## 0.3.0 — 2026-06-14

**Hard write-guard.** Every mutating tool now refuses to execute without an explicit `confirm: true` parameter. Without confirm, the tool returns a dry-run preview of the API call it would have made. This is a deliberate guardrail so AI clients cannot autonomously write to your books without per-call acknowledgement.

- 29 write tools gated behind `confirm: true`
- 35 read tools fire freely (list, get, reports, audit log, reference data)
- Confirmed writes are logged to stderr with timestamp + action

**API quirk fixes.**

- `billy_update_organization` now resolves the org id via whoami and uses `PUT /v2/organizations/<id>` (the singular endpoint is GET-only in Billy v2).
- `billy_list_bank_lines` now requires the `accountId` parameter, which Billy enforces.
- Removed `billy_list_bank_accounts` (Billy v2 does not support `GET /bankAccounts`). The default invoice/bill bank account id is exposed via `billy_whoami → organization.defaultInvoiceBankAccountId`.
- Removed `billy_list_payment_methods` (resource is 404 on Billy v2).

## 0.2.0 — 2026-06-14

- Expanded from 14 to 66 tools.
- Full Billy v2 surface: invoices (CRUD + approve + send), bills (CRUD + approve), contacts + persons, products, accounts + groups, bank accounts, bank payments, bank lines (match/unmatch), daybook, tax rates/rulesets/returns, reports (P&L, balance, VAT, sales), postings, audit log, webhooks, reference data, files + attachments.
- `billy_update_organization` added.
- `billy_send_invoice` added.

## 0.1.0 — 2026-06-14

- Initial release. 14 tools covering whoami, invoices, bills, contacts, bank lines, accounts, daybook.
