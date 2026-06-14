// Quick smoke test — confirms the token works against Billy's API.
// Run: BILLY_API_TOKEN=xxx npm run smoke

import { BillyClient } from "./billy.js";

async function main() {
  const token = process.env.BILLY_API_TOKEN;
  if (!token) {
    console.error("BILLY_API_TOKEN missing");
    process.exit(1);
  }
  const billy = new BillyClient({ token });

  console.log("→ whoami");
  const org = await billy.whoami();
  console.log(JSON.stringify(org, null, 2));

  console.log("\n→ first 3 unmatched bank lines");
  const lines = await billy.listBankLines({ isMatched: false, pageSize: 3 });
  console.log(JSON.stringify(lines, null, 2));

  console.log("\n→ first 3 draft invoices");
  const drafts = await billy.listInvoices({ state: "draft", pageSize: 3 });
  console.log(JSON.stringify(drafts, null, 2));

  console.log("\nsmoke test ok");
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
