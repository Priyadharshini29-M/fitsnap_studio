/**
 * Public storefront endpoint — returns saved widget settings for a shop.
 * Called by tryon-widget.js on every product page load.
 * No auth required: settings are already visible on the storefront.
 *
 * POST action — called by the admin settings page Save button.
 * Auth-guarded via Shopify session.
 */
import { authenticate } from "../shopify.server";
import { getMerchantByDomain, ensureMerchant } from "../lib/merchant.server";
import phpApiClient from "../lib/php-api.server";
import { PHP_API_URL, PHP_API_SECRET } from "../lib/env.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

// ── GET: storefront read (no auth needed) ─────────────────────────────────────
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return Response.json({}, { headers: CORS });
  }

  const phpBase = PHP_API_URL.replace(/\/$/, "");
  if (!phpBase) {
    return Response.json({}, { headers: CORS });
  }

  const merchant = await getMerchantByDomain(shop).catch(() => null);
  const apiKey = merchant?.api_key ?? PHP_API_SECRET;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(`${phpBase}/settings`, {
      headers: { "X-Api-Key": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = res.ok ? await res.json().catch(() => ({})) : {};
    return Response.json(data ?? {}, { headers: CORS });
  } catch {
    clearTimeout(timer);
    return Response.json({}, { headers: CORS });
  }
}

// ── POST: admin save (Shopify session auth) ───────────────────────────────────
export async function action({ request }) {
  try {
    const { session } = await authenticate.admin(request);
    const apiKey = await ensureMerchant(session);
    const body = await request.json();

    console.log("[SAVE] shop:", session.shop, "| apiKey:", apiKey?.slice(0, 8), "| PHP_API_URL:", PHP_API_URL);

    const api = phpApiClient(apiKey, PHP_API_URL);
    const res = await api.saveSettings(body);

    console.log("[SAVE] PHP ok:", res.ok, "| status:", res.status, "| error:", res.error);

    if (!res.ok) {
      return Response.json(
        { ok: false, error: res.error ?? "Save failed — check PHP logs" },
        { status: 500 }
      );
    }

    return Response.json({ ok: true, data: res.data ?? null, _t: Date.now() });
  } catch (err) {
    console.error("[SAVE] Unhandled error:", err);
    return Response.json(
      { ok: false, error: err?.message ?? "Unexpected error" },
      { status: 500 }
    );
  }
}
