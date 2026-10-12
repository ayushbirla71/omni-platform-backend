import { backfillCampaignDelivery } from "../modules/campaigns/campaign-delivery-sync";
import { pool } from "../db/pool";

/**
 * One-off repair for campaigns sent before delivery tracking existed (migration 015):
 * links each stuck "sent" recipient to its WhatsApp message and applies the delivered / read /
 * failed status the provider already reported.
 *
 *   npm run backfill:campaign-delivery                       # dry run, changes nothing
 *   npm run backfill:campaign-delivery -- --apply            # write the changes
 *   npm run backfill:campaign-delivery -- --apply --campaign <campaignId>
 *   npm run backfill:campaign-delivery -- --apply --tenant <tenantId>
 *
 * In production use the compiled script: node dist/scripts/backfill-campaign-delivery.js --apply
 */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const summary = await backfillCampaignDelivery({
    apply,
    campaignId: argValue("--campaign"),
    tenantId: argValue("--tenant"),
  });

  console.log(apply ? "Backfill applied:" : "Dry run (no changes written, pass --apply to write):");
  console.log(`  recipients stuck at "sent" with no message id: ${summary.candidates}`);
  console.log(`  matched to a sent message:                    ${summary.matched}`);
  console.log(`  no matching message found:                    ${summary.unmatched}`);
  console.log(
    `  provider-reported status of matched messages: sent=${summary.resolved.sent} delivered=${summary.resolved.delivered} read=${summary.resolved.read} failed=${summary.resolved.failed}`
  );
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode ?? 0);
  });
