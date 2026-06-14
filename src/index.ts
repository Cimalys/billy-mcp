#!/usr/bin/env node
// Cimalys Billy MCP server — comprehensive coverage of the Billy v2 REST API.
// Auth via BILLY_API_TOKEN env var.
//
// Write-guard pattern: every tool that mutates state (POST/PUT/DELETE +
// special actions like approve/send/match) refuses to execute unless the
// caller passes `confirm: true`. Without confirm, the tool returns a
// dry-run preview of the API call it would have made. This is a
// deliberate guardrail so AI clients cannot autonomously write to your
// books without explicit per-call acknowledgement.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BillyClient, BillyError } from "./billy.js";

const token = process.env.BILLY_API_TOKEN;
if (!token) {
  console.error(
    "BILLY_API_TOKEN missing. Create one at Billy → Settings → Access tokens, then set it in the MCP env block.",
  );
  process.exit(1);
}

const billy = new BillyClient({ token });

const server = new McpServer({
  name: "cimalys-billy",
  version: "0.3.0",
});

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(e: unknown) {
  if (e instanceof BillyError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Billy ${e.status}: ${JSON.stringify(e.body, null, 2)}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: (e as Error).message }],
    isError: true,
  };
}

async function safe<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e);
  }
}

// ─── Write guard ────────────────────────────────────────────────────────────
// Wraps a write handler so that it refuses to execute unless `confirm: true`
// is in the input. Without confirm, returns a preview describing the call.
// With confirm, strips the flag and runs the action.

const CONFIRM_FIELD = {
  confirm: z
    .boolean()
    .optional()
    .describe(
      "REQUIRED to execute. Pass true to actually run the mutation. Without it, this tool returns a dry-run preview of what would happen — explicit second call with confirm:true is needed to write.",
    ),
};

function preview(action: string, input: Record<string, unknown>) {
  const { confirm: _drop, ...payload } = input;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `[DRY RUN — write blocked]\n\n` +
          `Action: ${action}\n\n` +
          `Payload that would be sent to Billy:\n${JSON.stringify(payload, null, 2)}\n\n` +
          `To execute, re-issue the same tool call with the additional field: "confirm": true\n` +
          `(This is a hard guardrail in the MCP — no Billy write happens until you explicitly confirm.)`,
      },
    ],
  };
}

function guarded<T extends Record<string, unknown>>(
  action: string,
  run: (input: T) => Promise<unknown>,
) {
  return async (input: T & { confirm?: boolean }) => {
    if (!input.confirm) return preview(action, input);
    const { confirm: _drop, ...rest } = input as { confirm?: boolean } & T;
    return safe(() => run(rest as T));
  };
}

function logWrite(action: string) {
  const ts = new Date().toISOString();
  console.error(`[billy-mcp ${ts}] WRITE confirmed → ${action}`);
}

function loggedGuarded<T extends Record<string, unknown>>(
  action: string,
  run: (input: T) => Promise<unknown>,
) {
  return guarded<T>(action, async (input) => {
    logWrite(action);
    return run(input);
  });
}

// ─── Organization ──────────────────────────────────────────────────────────

server.tool(
  "billy_whoami",
  "Get the current Billy organization (sanity check the token, see org settings). READ-ONLY.",
  {},
  () => safe(() => billy.whoami()),
);

server.tool(
  "billy_update_organization",
  "Update fields on the organization. WRITE — requires confirm:true. Pass any subset of: { name, registrationNo, vatNo, street, zipcode, city, countryId, email, phone, paymentTermsDays, defaultTaxMode, salesTaxPeriod, isVatExempted, ... }",
  { patch: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("update organization", ({ patch }) => billy.updateOrganization(patch)),
);

// ─── Invoices ──────────────────────────────────────────────────────────────

server.tool(
  "billy_list_invoices",
  "List invoices. READ-ONLY. Filters: state (draft/approved/paid), contactId, sinceDate, untilDate.",
  {
    state: z.enum(["draft", "approved", "paid"]).optional(),
    contactId: z.string().optional(),
    sinceDate: z.string().optional(),
    untilDate: z.string().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listInvoices(input)),
);

server.tool(
  "billy_get_invoice",
  "Fetch one invoice including line items. READ-ONLY.",
  { id: z.string() },
  ({ id }) => safe(() => billy.getInvoice(id)),
);

server.tool(
  "billy_create_invoice",
  "Create a new invoice (default state: draft). WRITE — requires confirm:true. Shape: { contactId, entryDate, currencyId, lines: [{ productId, description, quantity, unitPrice, taxRateId? }], paymentTermsDays?, lineDescription? }",
  { invoice: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create invoice", ({ invoice }) => billy.createInvoice(invoice)),
);

server.tool(
  "billy_update_invoice",
  "Update an existing invoice. WRITE — requires confirm:true.",
  { id: z.string(), patch: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("update invoice", ({ id, patch }) => billy.updateInvoice(id, patch)),
);

server.tool(
  "billy_delete_invoice",
  "Delete a draft invoice. WRITE — requires confirm:true. Approved/paid invoices cannot be deleted.",
  { id: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("delete invoice", ({ id }) => billy.deleteInvoice(id)),
);

server.tool(
  "billy_approve_invoice",
  "Approve a draft invoice (draft → approved). WRITE — requires confirm:true. Required before sending or marking paid.",
  { id: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("approve invoice", ({ id }) => billy.approveInvoice(id)),
);

server.tool(
  "billy_send_invoice",
  "Send an invoice by email via Billy. WRITE — requires confirm:true. Email payload: { to: ['email'], cc?, bcc?, subject?, message?, attachPdf? }",
  {
    id: z.string(),
    email: z.object({
      to: z.array(z.string()).optional(),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      replyTo: z.string().optional(),
      subject: z.string().optional(),
      message: z.string().optional(),
      attachPdf: z.boolean().optional(),
      country: z.string().optional(),
    }),
    ...CONFIRM_FIELD,
  },
  loggedGuarded("send invoice email", ({ id, email }) => billy.sendInvoice(id, email)),
);

// ─── Bills (expenses / supplier invoices) ──────────────────────────────────

server.tool(
  "billy_list_bills",
  "List bills/expenses. READ-ONLY.",
  {
    state: z.enum(["draft", "approved", "paid"]).optional(),
    contactId: z.string().optional(),
    sinceDate: z.string().optional(),
    untilDate: z.string().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listBills(input)),
);

server.tool(
  "billy_get_bill",
  "Fetch one bill (expense). READ-ONLY.",
  { id: z.string() },
  ({ id }) => safe(() => billy.getBill(id)),
);

server.tool(
  "billy_create_bill",
  "Create a new bill. WRITE — requires confirm:true. Shape: { contactId, entryDate, currencyId, lines: [{ accountId, description, amount, taxRateId? }] }",
  { bill: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create bill", ({ bill }) => billy.createBill(bill)),
);

server.tool(
  "billy_update_bill",
  "Update an existing bill. WRITE — requires confirm:true.",
  { id: z.string(), patch: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("update bill", ({ id, patch }) => billy.updateBill(id, patch)),
);

server.tool(
  "billy_delete_bill",
  "Delete a draft bill. WRITE — requires confirm:true.",
  { id: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("delete bill", ({ id }) => billy.deleteBill(id)),
);

server.tool(
  "billy_approve_bill",
  "Approve a draft bill. WRITE — requires confirm:true.",
  { id: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("approve bill", ({ id }) => billy.approveBill(id)),
);

// ─── Contacts + contact persons ────────────────────────────────────────────

server.tool(
  "billy_list_contacts",
  "List contacts. READ-ONLY.",
  {
    isCustomer: z.boolean().optional(),
    isSupplier: z.boolean().optional(),
    q: z.string().optional(),
    countryId: z.string().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listContacts(input)),
);

server.tool(
  "billy_get_contact",
  "Fetch one contact. READ-ONLY.",
  { id: z.string() },
  ({ id }) => safe(() => billy.getContact(id)),
);

server.tool(
  "billy_create_contact",
  "Create a new contact. WRITE — requires confirm:true. Shape: { name, isCustomer, isSupplier, countryId, street?, city?, zipcode?, registrationNo?, email?, phone? }",
  { contact: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create contact", ({ contact }) => billy.createContact(contact)),
);

server.tool(
  "billy_update_contact",
  "Update an existing contact. WRITE — requires confirm:true.",
  { id: z.string(), patch: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("update contact", ({ id, patch }) => billy.updateContact(id, patch)),
);

server.tool(
  "billy_delete_contact",
  "Delete a contact. WRITE — requires confirm:true. Contacts with associated invoices/bills cannot be deleted.",
  { id: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("delete contact", ({ id }) => billy.deleteContact(id)),
);

server.tool(
  "billy_list_contact_persons",
  "List contact persons. READ-ONLY.",
  { contactId: z.string().optional() },
  ({ contactId }) => safe(() => billy.listContactPersons(contactId)),
);

server.tool(
  "billy_create_contact_person",
  "Create a contact person. WRITE — requires confirm:true. Shape: { contactId, name, email?, phone?, isPrimary? }",
  { person: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create contact person", ({ person }) => billy.createContactPerson(person)),
);

// ─── Products ──────────────────────────────────────────────────────────────

server.tool(
  "billy_list_products",
  "List products (your sellable items/services). READ-ONLY.",
  {
    q: z.string().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listProducts(input)),
);

server.tool(
  "billy_get_product",
  "Fetch one product. READ-ONLY.",
  { id: z.string() },
  ({ id }) => safe(() => billy.getProduct(id)),
);

server.tool(
  "billy_create_product",
  "Create a product/service. WRITE — requires confirm:true. Shape: { name, productNo?, description?, prices: [{ unitPrice, currencyId }], salesAccountId?, salesTaxRulesetId? }",
  { product: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create product", ({ product }) => billy.createProduct(product)),
);

server.tool(
  "billy_update_product",
  "Update an existing product. WRITE — requires confirm:true.",
  { id: z.string(), patch: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("update product", ({ id, patch }) => billy.updateProduct(id, patch)),
);

server.tool(
  "billy_delete_product",
  "Delete a product. WRITE — requires confirm:true.",
  { id: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("delete product", ({ id }) => billy.deleteProduct(id)),
);

// ─── Accounts (chart of accounts) ──────────────────────────────────────────

server.tool(
  "billy_list_accounts",
  "List the chart of accounts. READ-ONLY.",
  {
    isArchived: z.boolean().optional(),
    pageSize: z.number().int().positive().max(500).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listAccounts(input)),
);

server.tool(
  "billy_get_account",
  "Fetch one account. READ-ONLY.",
  { id: z.string() },
  ({ id }) => safe(() => billy.getAccount(id)),
);

server.tool(
  "billy_create_account",
  "Create a new account in the chart of accounts. WRITE — requires confirm:true.",
  { account: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create account", ({ account }) => billy.createAccount(account)),
);

server.tool(
  "billy_update_account",
  "Update an existing account. WRITE — requires confirm:true.",
  { id: z.string(), patch: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("update account", ({ id, patch }) => billy.updateAccount(id, patch)),
);

server.tool(
  "billy_list_account_groups",
  "List the account-group hierarchy. READ-ONLY.",
  {},
  () => safe(() => billy.listAccountGroups()),
);

// ─── Bank accounts ─────────────────────────────────────────────────────────
// NOTE: Billy v2 does not support GET /bankAccounts (only POST). The default
// invoice bank account id is exposed via billy_whoami → organization.defaultInvoiceBankAccountId.

server.tool(
  "billy_get_bank_account",
  "Fetch one bank account by id. READ-ONLY. (Billy v2 does not support listing all bank accounts — look up the default via billy_whoami.)",
  { id: z.string() },
  ({ id }) => safe(() => billy.getBankAccount(id)),
);

server.tool(
  "billy_create_bank_account",
  "Create a bank account in Billy. WRITE — requires confirm:true.",
  { bankAccount: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create bank account", ({ bankAccount }) => billy.createBankAccount(bankAccount)),
);

// ─── Bank payments ─────────────────────────────────────────────────────────

server.tool(
  "billy_list_bank_payments",
  "List bank payments (records of money in/out tied to invoices/bills). READ-ONLY.",
  {
    contactId: z.string().optional(),
    sinceDate: z.string().optional(),
    untilDate: z.string().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listBankPayments(input)),
);

server.tool(
  "billy_create_bank_payment",
  "Create a bank payment. WRITE — requires confirm:true. Used to mark invoices/bills as paid. Shape: { entryDate, cashSide: 'debit'|'credit', cashAmount, cashAccountId, contraAccountId, associations: [{ subjectType, subjectId, amount }] }",
  { bankPayment: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create bank payment", ({ bankPayment }) => billy.createBankPayment(bankPayment)),
);

// ─── Bank lines ────────────────────────────────────────────────────────────

server.tool(
  "billy_list_bank_lines",
  "List bank statement lines. READ-ONLY. REQUIRES accountId. Default returns UNMATCHED lines (the actionable state).",
  {
    accountId: z.string().describe("Required by Billy. Use billy_whoami → defaultInvoiceBankAccountId if unsure."),
    isMatched: z.boolean().optional().describe("Default false — unmatched lines"),
    sinceDate: z.string().optional(),
    untilDate: z.string().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => {
    const isMatched = input.isMatched ?? false;
    return safe(() => billy.listBankLines({ ...input, isMatched }));
  },
);

server.tool(
  "billy_get_bank_line",
  "Fetch one bank line. READ-ONLY.",
  { id: z.string() },
  ({ id }) => safe(() => billy.getBankLine(id)),
);

server.tool(
  "billy_match_bank_line",
  "Reconcile a bank line with an invoice/bill/bank payment. WRITE — requires confirm:true.",
  {
    bankLineId: z.string(),
    subjectType: z.enum(["invoice", "bill", "bankPayment"]),
    subjectId: z.string(),
    ...CONFIRM_FIELD,
  },
  loggedGuarded("match bank line", (input) => billy.matchBankLine(input)),
);

server.tool(
  "billy_unmatch_bank_line",
  "Remove a bank-line reconciliation. WRITE — requires confirm:true.",
  { associationId: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("unmatch bank line", ({ associationId }) => billy.unmatchBankLine(associationId)),
);

// ─── Daybook ───────────────────────────────────────────────────────────────

server.tool(
  "billy_list_daybooks",
  "List daybooks. READ-ONLY.",
  {},
  () => safe(() => billy.listDaybooks()),
);

server.tool(
  "billy_list_daybook_transactions",
  "List manual daybook transactions (journal entries). READ-ONLY.",
  {
    daybookId: z.string().optional(),
    state: z.enum(["draft", "approved"]).optional(),
    sinceDate: z.string().optional(),
    untilDate: z.string().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listDaybookTransactions(input)),
);

server.tool(
  "billy_create_daybook_transaction",
  "Create a manual journal entry. WRITE — requires confirm:true. Shape: { daybookId, entryDate, description, lines: [{ accountId, side: 'debit'|'credit', amount, taxRateId? }] }",
  { transaction: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create daybook transaction", ({ transaction }) => billy.createDaybookTransaction(transaction)),
);

// ─── Tax (rates, rulesets, returns) ────────────────────────────────────────

server.tool("billy_list_tax_rates", "List configured tax rates. READ-ONLY.", {}, () =>
  safe(() => billy.listTaxRates()),
);

server.tool("billy_list_tax_rulesets", "List tax rulesets. READ-ONLY.", {}, () =>
  safe(() => billy.listTaxRulesets()),
);

server.tool(
  "billy_list_sales_tax_returns",
  "List MOMS/VAT returns. READ-ONLY.",
  {
    state: z.string().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listSalesTaxReturns(input)),
);

server.tool(
  "billy_get_sales_tax_return",
  "Fetch one MOMS/VAT return. READ-ONLY.",
  { id: z.string() },
  ({ id }) => safe(() => billy.getSalesTaxReturn(id)),
);

// ─── Reports ───────────────────────────────────────────────────────────────

server.tool(
  "billy_report_profit_loss",
  "P&L report. READ-ONLY.",
  {
    fromDate: z.string(),
    toDate: z.string(),
    accountGroupId: z.string().optional(),
  },
  (input) => safe(() => billy.reportProfitLoss(input)),
);

server.tool(
  "billy_report_balance",
  "Balance sheet at a point in time. READ-ONLY.",
  { date: z.string() },
  (input) => safe(() => billy.reportBalance(input)),
);

server.tool(
  "billy_report_sales_tax",
  "MOMS/VAT report. READ-ONLY.",
  { fromDate: z.string(), toDate: z.string() },
  (input) => safe(() => billy.reportSalesTax(input)),
);

server.tool(
  "billy_report_invoiced_sales",
  "Invoiced sales by contact/product. READ-ONLY.",
  { fromDate: z.string(), toDate: z.string() },
  (input) => safe(() => billy.reportInvoicedSales(input)),
);

// ─── Postings (ledger) ─────────────────────────────────────────────────────

server.tool(
  "billy_list_postings",
  "List ledger postings. READ-ONLY.",
  {
    accountId: z.string().optional(),
    sinceDate: z.string().optional(),
    untilDate: z.string().optional(),
    pageSize: z.number().int().positive().max(500).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listPostings(input)),
);

// ─── Activity / audit log ──────────────────────────────────────────────────

server.tool(
  "billy_list_action_stream",
  "Recent activity log entries. READ-ONLY.",
  {
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listActionStream(input)),
);

// ─── Webhooks ──────────────────────────────────────────────────────────────

server.tool("billy_list_webhooks", "List webhooks. READ-ONLY.", {}, () => safe(() => billy.listWebhooks()));

server.tool(
  "billy_create_webhook",
  "Create a webhook. WRITE — requires confirm:true. Shape: { url, event, isActive? }",
  { webhook: z.record(z.unknown()), ...CONFIRM_FIELD },
  loggedGuarded("create webhook", ({ webhook }) => billy.createWebhook(webhook)),
);

server.tool(
  "billy_delete_webhook",
  "Remove a webhook. WRITE — requires confirm:true.",
  { id: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("delete webhook", ({ id }) => billy.deleteWebhook(id)),
);

// ─── Reference data (read-only) ────────────────────────────────────────────

server.tool("billy_list_currencies", "List currencies. READ-ONLY.", {}, () => safe(() => billy.listCurrencies()));
server.tool("billy_list_countries", "List countries. READ-ONLY.", {}, () => safe(() => billy.listCountries()));
server.tool("billy_list_payment_terms_modes", "List payment-terms modes. READ-ONLY.", {}, () =>
  safe(() => billy.listPaymentTermsModes()),
);
server.tool("billy_list_units", "List product units. READ-ONLY.", {}, () => safe(() => billy.listUnits()));

// ─── Files / attachments ───────────────────────────────────────────────────

server.tool(
  "billy_list_files",
  "List files uploaded to Billy. READ-ONLY.",
  {
    pageSize: z.number().int().positive().max(200).optional(),
    page: z.number().int().positive().optional(),
  },
  (input) => safe(() => billy.listFiles(input)),
);

server.tool(
  "billy_get_file",
  "Fetch metadata for one file (incl. downloadUrl). READ-ONLY.",
  { id: z.string() },
  ({ id }) => safe(() => billy.getFile(id)),
);

server.tool(
  "billy_attach_file_to_bill",
  "Attach an uploaded file (receipt PDF, etc.) to a bill. WRITE — requires confirm:true.",
  { billId: z.string(), fileId: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("attach file to bill", ({ billId, fileId }) =>
    billy.attachFileToBill(billId, fileId),
  ),
);

server.tool(
  "billy_attach_file_to_invoice",
  "Attach an uploaded file to an invoice. WRITE — requires confirm:true.",
  { invoiceId: z.string(), fileId: z.string(), ...CONFIRM_FIELD },
  loggedGuarded("attach file to invoice", ({ invoiceId, fileId }) =>
    billy.attachFileToInvoice(invoiceId, fileId),
  ),
);

// ─── Boot ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "cimalys-billy-mcp v0.3.0 ready (stdio) — write-guard active: writes require confirm:true",
  );
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
