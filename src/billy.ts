// Comprehensive client over the Billy v2 REST API.
// Auth via X-Access-Token (no OAuth flow needed for personal token).
// Docs: https://www.billy.dk/api (resolves to billysbilling.com/v2).
//
// Conventions:
//   - Billy wraps create/update bodies in the singular resource name:
//     POST /invoices  body: { "invoice": {...} }
//   - GET responses are wrapped too: { "invoices": [...] } or { "invoice": {...} }
//   - We pass payloads straight through. Callers can use raw Billy shapes.

const BASE = "https://api.billysbilling.com/v2";

// Billy v2 only accepts these file extensions on /v2/files (verified
// empirically — 422 OTHER otherwise with errorMessage:
// "File must have one of the following extensions: pdf, jpg, png, gif.").
const BILLY_ACCEPTED_EXTS = new Set(["pdf", "jpg", "jpeg", "png", "gif"]);

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

function extOf(filename: string): string | undefined {
  return filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
}

function guessMime(filename: string): string {
  const ext = extOf(filename);
  return (ext && MIME_BY_EXT[ext]) ?? "application/octet-stream";
}

export interface BillyClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

export class BillyError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
    this.name = "BillyError";
  }
}

type QueryValue = string | number | boolean | undefined | null;

export class BillyClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BillyClientOptions) {
    if (!opts.token) throw new Error("BILLY_API_TOKEN is required");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, QueryValue>,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(BASE + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        "X-Access-Token": this.token,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(extraHeaders ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    if (!res.ok) {
      throw new BillyError(
        `Billy ${method} ${path} → ${res.status}`,
        res.status,
        parsed,
      );
    }
    return parsed as T;
  }

  /**
   * Read a local file and upload it. Convenience over uploadFile().
   * Detects MIME from the file extension if contentType is not given.
   */
  async uploadLocalFile(opts: {
    path: string;
    filename?: string;
    contentType?: string;
  }): Promise<unknown> {
    const fs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const filename = opts.filename ?? nodePath.basename(opts.path);
    const ext = extOf(filename);
    if (!ext || !BILLY_ACCEPTED_EXTS.has(ext)) {
      throw new BillyError(
        `Billy only accepts pdf, jpg, jpeg, png, gif files. Got: ${filename}`,
        422,
        {
          errorCode: "UNSUPPORTED_FILE_TYPE",
          errorMessage:
            "Convert the file to PDF before uploading (recommended for receipts). For images, jpg/png/gif are accepted.",
        },
      );
    }
    const data = await fs.readFile(opts.path);
    const contentType = opts.contentType ?? guessMime(filename);
    return this.uploadFile({ filename, contentType, data });
  }

  // Multipart for /files (Billy expects multipart/form-data with one file field).
  async uploadFile(opts: {
    filename: string;
    contentType: string;
    data: Buffer | Uint8Array;
  }): Promise<unknown> {
    const url = `${BASE}/files`;
    const blob = new Blob([opts.data as BlobPart], { type: opts.contentType });
    const form = new FormData();
    form.append("file", blob, opts.filename);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "X-Access-Token": this.token, Accept: "application/json" },
      body: form,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    if (!res.ok) {
      throw new BillyError(
        `Billy POST /files → ${res.status}`,
        res.status,
        parsed,
      );
    }
    return parsed;
  }

  // ─── Organization ───────────────────────────────────────────────────────

  async whoami(): Promise<unknown> {
    return this.request("GET", "/organization");
  }

  async updateOrganization(patch: Record<string, unknown>): Promise<unknown> {
    // Billy quirk: /v2/organization is GET-only. Updates go to the plural
    // /v2/organizations/:id. We resolve the id from /organization first.
    const who = (await this.whoami()) as { organization?: { id?: string } };
    const id = who?.organization?.id;
    if (!id) throw new Error("Could not resolve organization id from whoami");
    return this.request("PUT", `/organizations/${id}`, { organization: patch });
  }

  // ─── Invoices ───────────────────────────────────────────────────────────

  async listInvoices(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/invoices", undefined, {
      pageSize: 50,
      page: 1,
      ...opts,
    });
  }

  async getInvoice(id: string): Promise<unknown> {
    return this.request("GET", `/invoices/${id}`);
  }

  async createInvoice(invoice: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/invoices", { invoice });
  }

  async updateInvoice(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/invoices/${id}`, { invoice: patch });
  }

  async deleteInvoice(id: string): Promise<unknown> {
    return this.request("DELETE", `/invoices/${id}`);
  }

  // Approves a draft invoice (state: draft → approved).
  async approveInvoice(id: string): Promise<unknown> {
    return this.request("PUT", `/invoices/${id}`, {
      invoice: { state: "approved" },
    });
  }

  // Sends an invoice by email via Billy.
  async sendInvoice(
    id: string,
    payload: {
      to?: string[];
      cc?: string[];
      bcc?: string[];
      replyTo?: string;
      subject?: string;
      message?: string;
      attachPdf?: boolean;
      country?: string;
    } = {},
  ): Promise<unknown> {
    return this.request("POST", `/invoices/${id}/emails`, { email: payload });
  }

  // ─── Bills (expenses / supplier invoices) ───────────────────────────────

  async listBills(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/bills", undefined, {
      pageSize: 50,
      page: 1,
      ...opts,
    });
  }

  async getBill(id: string): Promise<unknown> {
    return this.request("GET", `/bills/${id}`);
  }

  async createBill(bill: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/bills", { bill });
  }

  async updateBill(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/bills/${id}`, { bill: patch });
  }

  async deleteBill(id: string): Promise<unknown> {
    return this.request("DELETE", `/bills/${id}`);
  }

  async approveBill(id: string): Promise<unknown> {
    return this.request("PUT", `/bills/${id}`, {
      bill: { state: "approved" },
    });
  }

  // ─── Contacts + contact persons ─────────────────────────────────────────

  async listContacts(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/contacts", undefined, {
      pageSize: 50,
      page: 1,
      ...opts,
    });
  }

  async getContact(id: string): Promise<unknown> {
    return this.request("GET", `/contacts/${id}`);
  }

  async createContact(contact: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/contacts", { contact });
  }

  async updateContact(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/contacts/${id}`, { contact: patch });
  }

  async deleteContact(id: string): Promise<unknown> {
    return this.request("DELETE", `/contacts/${id}`);
  }

  async listContactPersons(contactId?: string): Promise<unknown> {
    return this.request("GET", "/contactPersons", undefined, { contactId });
  }

  async createContactPerson(person: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/contactPersons", { contactPerson: person });
  }

  // ─── Products ───────────────────────────────────────────────────────────

  async listProducts(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/products", undefined, {
      pageSize: 50,
      page: 1,
      ...opts,
    });
  }

  async getProduct(id: string): Promise<unknown> {
    return this.request("GET", `/products/${id}`);
  }

  async createProduct(product: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/products", { product });
  }

  async updateProduct(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/products/${id}`, { product: patch });
  }

  async deleteProduct(id: string): Promise<unknown> {
    return this.request("DELETE", `/products/${id}`);
  }

  // ─── Accounts (chart of accounts) ───────────────────────────────────────

  async listAccounts(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/accounts", undefined, {
      pageSize: 200,
      page: 1,
      ...opts,
    });
  }

  async getAccount(id: string): Promise<unknown> {
    return this.request("GET", `/accounts/${id}`);
  }

  async createAccount(account: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/accounts", { account });
  }

  async updateAccount(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/accounts/${id}`, { account: patch });
  }

  async listAccountGroups(): Promise<unknown> {
    return this.request("GET", "/accountGroups");
  }

  // ─── Bank accounts (your own bank accounts in Billy) ────────────────────

  async listBankAccounts(): Promise<unknown> {
    return this.request("GET", "/bankAccounts");
  }

  async getBankAccount(id: string): Promise<unknown> {
    return this.request("GET", `/bankAccounts/${id}`);
  }

  async createBankAccount(bankAccount: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/bankAccounts", { bankAccount });
  }

  // ─── Bank payments (records of money in/out) ────────────────────────────

  async listBankPayments(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/bankPayments", undefined, {
      pageSize: 50,
      page: 1,
      ...opts,
    });
  }

  async createBankPayment(bankPayment: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/bankPayments", { bankPayment });
  }

  // ─── Bank lines (bank statement entries — reconciliation surface) ───────

  async listBankLines(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/bankLines", undefined, {
      pageSize: 100,
      page: 1,
      ...opts,
    });
  }

  async getBankLine(id: string): Promise<unknown> {
    return this.request("GET", `/bankLines/${id}`);
  }

  // Associate a bank line with a subject (invoice/bill/payment) — this is
  // how reconciliation works. subjectAssociations is the v2 idiom.
  async matchBankLine(payload: {
    bankLineId: string;
    subjectType: "invoice" | "bill" | "bankPayment";
    subjectId: string;
  }): Promise<unknown> {
    return this.request("POST", "/bankLineSubjectAssociations", {
      bankLineSubjectAssociation: payload,
    });
  }

  async unmatchBankLine(associationId: string): Promise<unknown> {
    return this.request("DELETE", `/bankLineSubjectAssociations/${associationId}`);
  }

  // ─── Daybook (manual journal entries) ───────────────────────────────────

  async listDaybooks(): Promise<unknown> {
    return this.request("GET", "/daybooks");
  }

  async listDaybookTransactions(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/daybookTransactions", undefined, {
      pageSize: 50,
      page: 1,
      ...opts,
    });
  }

  async createDaybookTransaction(tx: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/daybookTransactions", { daybookTransaction: tx });
  }

  // ─── Tax (rates, rulesets, returns) ─────────────────────────────────────

  async listTaxRates(): Promise<unknown> {
    return this.request("GET", "/taxRates");
  }

  async listTaxRulesets(): Promise<unknown> {
    return this.request("GET", "/taxRulesets");
  }

  async listSalesTaxReturns(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/salesTaxReturns", undefined, opts);
  }

  async getSalesTaxReturn(id: string): Promise<unknown> {
    return this.request("GET", `/salesTaxReturns/${id}`);
  }

  // ─── Reports (P&L, balance, VAT, sales) ─────────────────────────────────
  // Billy report endpoints accept fromDate/toDate (YYYY-MM-DD) and return
  // JSON aggregations. Pass through filters as-is.

  async reportProfitLoss(opts: Record<string, QueryValue>): Promise<unknown> {
    return this.request("GET", "/reports/profitAndLoss", undefined, opts);
  }

  async reportBalance(opts: Record<string, QueryValue>): Promise<unknown> {
    return this.request("GET", "/reports/balance", undefined, opts);
  }

  async reportSalesTax(opts: Record<string, QueryValue>): Promise<unknown> {
    return this.request("GET", "/reports/salesTax", undefined, opts);
  }

  async reportInvoicedSales(opts: Record<string, QueryValue>): Promise<unknown> {
    return this.request("GET", "/reports/invoicedSales", undefined, opts);
  }

  // ─── Postings (the underlying ledger entries) ───────────────────────────

  async listPostings(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/postings", undefined, {
      pageSize: 100,
      page: 1,
      ...opts,
    });
  }

  // ─── Activity / audit log ───────────────────────────────────────────────

  async listActionStream(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/actionStream", undefined, {
      pageSize: 50,
      page: 1,
      ...opts,
    });
  }

  // ─── Webhooks (for automation) ──────────────────────────────────────────

  async listWebhooks(): Promise<unknown> {
    return this.request("GET", "/webhooks");
  }

  async createWebhook(webhook: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/webhooks", { webhook });
  }

  async deleteWebhook(id: string): Promise<unknown> {
    return this.request("DELETE", `/webhooks/${id}`);
  }

  // ─── Reference data (read-only, useful for lookups) ─────────────────────

  async listCurrencies(): Promise<unknown> {
    return this.request("GET", "/currencies");
  }

  async listCountries(): Promise<unknown> {
    return this.request("GET", "/countries");
  }

  async listPaymentTermsModes(): Promise<unknown> {
    return this.request("GET", "/paymentTermsModes");
  }

  async listPaymentMethods(): Promise<unknown> {
    return this.request("GET", "/paymentMethods");
  }

  async listUnits(): Promise<unknown> {
    return this.request("GET", "/units");
  }

  // ─── Files / attachments ────────────────────────────────────────────────

  async listFiles(opts: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request("GET", "/files", undefined, opts);
  }

  async getFile(id: string): Promise<unknown> {
    return this.request("GET", `/files/${id}`);
  }

  async attachFileToBill(billId: string, fileId: string): Promise<unknown> {
    return this.request("POST", "/attachments", {
      attachment: { ownerId: billId, ownerType: "bill", fileId },
    });
  }

  async attachFileToInvoice(invoiceId: string, fileId: string): Promise<unknown> {
    return this.request("POST", "/attachments", {
      attachment: { ownerId: invoiceId, ownerType: "invoice", fileId },
    });
  }
}
