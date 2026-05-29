import { redirect } from "react-router";
import phpApiClient from "../lib/php-api.server";
import { getMerchantApiKey } from "../lib/merchant.server";
import { PHP_API_URL, SHOPIFY_API_KEY } from "../lib/env.server";

const PLAN_KEY_MAP = {
  growth: "FitSnap Growth",
  pro:    "FitSnap Pro",
};

export async function loader({ request }) {
  const url      = new URL(request.url);
  const shop     = url.searchParams.get("shop");
  const planName = url.searchParams.get("plan");
  const chargeId = url.searchParams.get("charge_id");

  console.log("[billing-callback] shop:", shop, "plan:", planName, "chargeId:", chargeId);

  if (!shop) return redirect("/auth/login");

  // Shopify only appends charge_id when the merchant actually approved billing
  if (chargeId && planName && PLAN_KEY_MAP[planName]) {
    try {
      const apiKey = await getMerchantApiKey(shop);
      const result = await phpApiClient(apiKey, PHP_API_URL, shop).updatePlan(planName);
      console.log("[billing-callback] updatePlan result:", JSON.stringify(result));
    } catch (err) {
      console.error("[billing-callback] plan update error:", err?.message ?? err);
    }

    // Redirect back into the embedded Shopify admin app with a success flag
    const adminAppUrl = SHOPIFY_API_KEY
      ? `https://${shop}/admin/apps/${SHOPIFY_API_KEY}/app/plans?plan_upgraded=1`
      : `https://${shop}/admin`;

    console.log("[billing-callback] redirecting to:", adminAppUrl);
    return redirect(adminAppUrl);
  }

  // No charge_id means billing was cancelled
  const adminAppUrl = SHOPIFY_API_KEY
    ? `https://${shop}/admin/apps/${SHOPIFY_API_KEY}/app/plans?billing_declined=1`
    : `https://${shop}/admin`;

  return redirect(adminAppUrl);
}

export default function BillingCallback() {
  return null;
}
