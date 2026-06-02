import { createHmac } from "node:crypto";
import { SHOPIFY_API_SECRET, PHP_API_URL, PHP_API_SECRET } from "../lib/env.server";

export const loader = () => new Response("Not Found", { status: 404 });

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  if (!verifyShopifyProxySignature(url.searchParams, SHOPIFY_API_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const phpBase = PHP_API_URL.replace(/\/$/, "");
  if (!phpBase) {
    return Response.json({ error: "Service not configured" }, { status: 503 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${phpBase}/session/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": PHP_API_SECRET,
      },
      body: JSON.stringify({
        product_id: body.product_id ?? null,
        variant_id: body.variant_id ?? null,
        device_type: body.device_type ?? null,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.ok ? 200 : res.status });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return Response.json(
      { error: isAbort ? "Request timed out" : "Session creation failed" },
      { status: isAbort ? 504 : 500 },
    );
  }
};

function verifyShopifyProxySignature(searchParams, secret) {
  if (!secret) return true;
  const sig = searchParams.get("signature");
  if (!sig) return false;

  const pairs = [];
  for (const [k, v] of searchParams.entries()) {
    if (k !== "signature") pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const message = pairs.join("");

  try {
    const expected = createHmac("sha256", secret).update(message).digest("hex");
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}
