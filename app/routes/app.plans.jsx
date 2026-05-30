// Server-side: redirect lives in react-router (React Router v7 equivalent of @remix-run/node)
import { redirect } from "react-router";

// Client-side hooks and components (React Router v7 equivalent of @remix-run/react)
import {
  Form,
  useLoaderData,
  useNavigation,
  useNavigate,
  useActionData,
  useRouteError,
} from "react-router";

import { useState, useEffect } from "react";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import phpApiClient from "../lib/php-api.server";
import { ensureMerchant } from "../lib/merchant.server";
import { PHP_API_URL, NODE_ENV } from "../lib/env.server";

// ─── Billing constants ────────────────────────────────────────────────────────

const PLAN_KEY_MAP = {
  growth: "FitSnap Growth",
  pro:    "FitSnap Pro",
};

const PLAN_PRICES = { growth: 19, pro: 49 };

// Numeric rank for upgrade vs downgrade label
const PLAN_RANK = { free: 0, growth: 1, pro: 2 };

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }) {
  console.log("[loader] plans page start");

  let session, admin;
  try {
    ({ session, admin } = await authenticate.admin(request));
    console.log("[loader] authenticated shop:", session?.shop);
  } catch (authErr) {
    // Re-throw Shopify auth Responses (redirects, 401s) — do NOT swallow them
    if (authErr instanceof Response) throw authErr;
    console.error("[loader] authentication error:", authErr?.message ?? authErr);
    // Re-throw so the ErrorBoundary can display the message
    throw new Error(`Authentication failed: ${authErr?.message ?? "Unknown error"}`);
  }

  const apiKey = await ensureMerchant(session);
  const api    = phpApiClient(apiKey, PHP_API_URL, session.shop);

  const url         = new URL(request.url);
  const chargeId    = url.searchParams.get("charge_id");
  const pendingPlan = url.searchParams.get("plan");

  // ── Post-billing callback: verify subscription ────────────────────────────
  if (chargeId && pendingPlan && PLAN_KEY_MAP[pendingPlan]) {
    console.log("[loader] verifying charge_id for plan:", pendingPlan);
    try {
      const gqlRes = await admin.graphql(`
        #graphql
        query {
          currentAppInstallation {
            activeSubscriptions { name status }
          }
        }
      `);
      const gqlData    = await gqlRes.json();
      const activeSubs = gqlData?.data?.currentAppInstallation?.activeSubscriptions ?? [];
      const isActive   = activeSubs.some(
        (s) => s.name === PLAN_KEY_MAP[pendingPlan] && s.status === "ACTIVE"
      );

      if (isActive) {
        console.log("[loader] subscription active, updating plan:", pendingPlan);
        await api.updatePlan(pendingPlan);
        return redirect("/app/plans");
      }
      console.log("[loader] subscription not active, billing declined");
    } catch (verifyErr) {
      console.error("[loader] charge verification error:", verifyErr?.message ?? verifyErr);
    }
    return redirect("/app/plans?billing_declined=1");
  }

  // ── Normal load ───────────────────────────────────────────────────────────
  let planRes;
  try {
    planRes = await api.checkPlanLimit();
  } catch (planErr) {
    console.error("[loader] checkPlanLimit error:", planErr?.message ?? planErr);
    planRes = { ok: false };
  }

  const planData        = planRes.ok ? planRes.data : null;
  const rawPlan        = planData?.plan ?? "free";
  const billingDeclined = url.searchParams.get("billing_declined") === "1";
  const planUpgraded    = url.searchParams.get("plan_upgraded")    === "1";

  console.log("[loader] current plan:", rawPlan, "upgraded:", planUpgraded);

  return {
    currentPlan:    rawPlan === "basic" ? "free" : rawPlan,
    usedTryons:     planData?.used  ?? 0,
    limitTryons:    planData?.limit ?? 10,
    billingDeclined,
    planUpgraded,
  };
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }) {
  console.log("[action] plans action start");

  // ── Authenticate ──────────────────────────────────────────────────────────
  let admin, session;
  try {
    ({ admin, session } = await authenticate.admin(request));
    console.log("[action] authenticated shop:", session?.shop);
  } catch (authErr) {
    // Re-throw Shopify auth Responses (redirects, 401s) — do NOT swallow them
    if (authErr instanceof Response) throw authErr;
    console.error("[action] authentication error:", authErr?.message ?? authErr);
    return { error: `Authentication error: ${authErr?.message ?? "Unknown"}` };
  }

  // ── Read form data ────────────────────────────────────────────────────────
  let planName;
  try {
    const formData = await request.formData();
    planName       = formData.get("plan");
    console.log("[action] selected plan:", planName);
  } catch (bodyErr) {
    console.error("[action] formData error:", bodyErr?.message ?? bodyErr);
    return { error: `Could not read form: ${bodyErr?.message ?? "Unknown"}` };
  }

  // ── Downgrade to free ─────────────────────────────────────────────────────
  if (planName === "free") {
    console.log("[action] downgrading to free plan");
    try {
      const gqlRes = await admin.graphql(`
        #graphql
        query GetActiveSubscriptions {
          currentAppInstallation {
            activeSubscriptions { id name status }
          }
        }
      `);
      const gqlData    = await gqlRes.json();
      const activeSubs = gqlData?.data?.currentAppInstallation?.activeSubscriptions ?? [];

      for (const sub of activeSubs) {
        if (sub.status === "ACTIVE") {
          console.log("[action] cancelling subscription:", sub.id);
          await admin.graphql(
            `#graphql
            mutation CancelSubscription($id: ID!) {
              appSubscriptionCancel(id: $id) {
                appSubscription { id status }
                userErrors { field message }
              }
            }`,
            { variables: { id: sub.id } }
          );
        }
      }
    } catch (cancelErr) {
      console.error("[action] subscription cancel error:", cancelErr?.message ?? cancelErr);
      // Non-fatal — continue to update PHP backend
    }

    try {
      const freeApiKey = await ensureMerchant(session);
      await phpApiClient(freeApiKey, PHP_API_URL, session.shop).updatePlan("free");
      console.log("[action] PHP plan updated to free");
    } catch (phpErr) {
      console.error("[action] PHP update error:", phpErr?.message ?? phpErr);
      // Non-blocking — plan will reconcile on next load
    }

    return redirect("/app/plans");
  }

  // ── Upgrade / switch paid plan ────────────────────────────────────────────
  const planKey = PLAN_KEY_MAP[planName];
  const amount  = PLAN_PRICES[planName];

  if (!planKey || !amount) {
    console.error("[action] invalid plan selected:", planName);
    return { error: "Invalid plan selected. Please try again." };
  }

  const { origin } = new URL(request.url);
  const returnUrl  = `${origin}/billing/callback?plan=${planName}&shop=${session.shop}`;
  console.log("[action] creating subscription for plan:", planKey, "returnUrl:", returnUrl);

  try {
    const gqlRes = await admin.graphql(
      `#graphql
      mutation AppSubscriptionCreate(
        $name: String!
        $returnUrl: URL!
        $test: Boolean
        $trialDays: Int
        $lineItems: [AppSubscriptionLineItemInput!]!
      ) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          test: $test
          trialDays: $trialDays
          lineItems: $lineItems
        ) {
          appSubscription { id }
          confirmationUrl
          userErrors { field message }
        }
      }`,
      {
        variables: {
          name:      planKey,
          returnUrl,
          test:      NODE_ENV !== "production",
          trialDays: 3,
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: String(amount), currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          }],
        },
      }
    );

    const gqlData        = await gqlRes.json();
    const confirmationUrl = gqlData?.data?.appSubscriptionCreate?.confirmationUrl;
    const userErrors      = gqlData?.data?.appSubscriptionCreate?.userErrors ?? [];

    if (userErrors.length > 0) {
      console.error("[action] GraphQL userErrors:", JSON.stringify(userErrors));
    }

    if (!confirmationUrl) {
      const msg = userErrors[0]?.message ?? "Could not create subscription. Please try again.";
      console.error("[action] no confirmationUrl returned:", msg);
      return { error: msg };
    }

    console.log("[action] subscription created, confirmationUrl received");
    return { billingUrl: confirmationUrl };
  } catch (billingErr) {
    console.error("[action] billing GraphQL error:", billingErr?.message ?? billingErr);
    return { error: "Billing service error. Please try again or contact support." };
  }
}

// ─── Static plan config ───────────────────────────────────────────────────────

const PLAN_CONFIG = [
  {
    key:         "free",
    name:        "Preview",
    badge:       null,
    price:       "Free",
    priceSub:    "forever",
    extraRate:   null,
    description: "Get started with AI virtual try-on at zero cost.",
    features: [
      "10 monthly AI try-ons included",
      "Mobile & desktop responsive widget",
      "Privacy consent screen",
      "Product page try-on support",
      "Standard AI processing",
      "Email support",
    ],
    buttonLabel:   "Current Plan",
    buttonVariant: "outline",
    featured:      false,
  },
  {
    key:         "growth",
    name:        "Growth",
    badge:       { label: "MOST POPULAR", variant: "popular" },
    price:       "$19",
    priceSub:    "/ month",
    extraRate:   "+$0.15 / extra try-on",
    description: "Scale your virtual try-on with powerful store tools.",
    features: [
      "100 monthly AI try-ons included",
      "Collection page mini try-on icons",
      "Variant image mapping system",
      "Product-level try-on enable/disable",
      "Advanced widget customization",
      "Typography & branding controls",
      "WhatsApp share support",
      "Analytics dashboard",
      "Customer email collection",
      "Add-to-cart tracking",
      "Conversion tracking",
      "Faster AI processing queue",
      "Standard support",
    ],
    buttonLabel:   "Upgrade to Growth",
    buttonVariant: "green",
    featured:      true,
  },
  {
    key:         "pro",
    name:        "Pro",
    badge:       { label: "PREMIUM", variant: "premium" },
    price:       "$49",
    priceSub:    "/ month",
    extraRate:   "+$0.08 / extra try-on",
    description: "Full power for high-volume stores and brands.",
    features: [
      "500 monthly AI try-ons included",
      "Advanced analytics dashboard",
      "Top-performing product insights",
      "Device-based analytics (mobile vs desktop)",
      "7-day trend reporting",
      "Multi-language widget support",
      "Premium widget customization",
      "Priority AI processing",
      "Faster try-on rendering",
      "Custom icon positioning",
      "Priority support",
      "Early access to new features",
      "Dedicated onboarding assistance",
    ],
    buttonLabel:   "Upgrade to Pro",
    buttonVariant: "dark",
    featured:      false,
  },
];

const FAQ_ITEMS = [
  {
    q: "Can I change my plan at any time?",
    a: "Yes. Upgrades take effect immediately with prorated billing. You can change your plan whenever you need.",
  },
  {
    q: "What happens when I exceed my monthly try-on limit?",
    a: "Additional try-ons are charged at your plan's per-try-on rate — $0.28 (Preview), $0.15 (Growth), or $0.08 (Pro). You are never blocked mid-session.",
  },
  {
    q: "Is there a free trial on paid plans?",
    a: "Yes — paid plans include a 3-day free trial so you can evaluate before being charged.",
  },
  {
    q: "Does the Preview plan require a credit card?",
    a: "No. The Preview plan is completely free with no payment method required.",
  },
];

// ─── Icons ────────────────────────────────────────────────────────────────────

function FeatureCheck() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, marginTop: "1px" }}
    >
      <circle cx="8" cy="8" r="8" fill="#EAF3DE" />
      <path
        d="M5 8l2 2 4-4"
        stroke="#1D9E75"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Chevron({ open }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 0.25s ease",
        color: "#9CA3AF",
      }}
    >
      <path
        d="M5 7.5l5 5 5-5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── Usage meter ──────────────────────────────────────────────────────────────

function UsageMeter({ used, limit, plan }) {
  const pct      = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const danger   = pct >= 90;
  const warn     = pct >= 70;
  const barColor = danger ? "#EF4444" : warn ? "#F59E0B" : "#1D9E75";

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #E5E7EB",
        borderRadius: "12px",
        padding: "20px 24px",
        marginBottom: "32px",
        maxWidth: "520px",
        margin: "0 auto 32px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "10px",
        }}
      >
        <span style={{ fontSize: "13px", fontWeight: 600, color: "#374151" }}>
          Monthly Try-On Usage
        </span>
        <span style={{ fontSize: "13px", color: "#6B7280" }}>
          {used} / {limit} used
        </span>
      </div>
      <div
        style={{
          height: "6px",
          background: "#F3F4F6",
          borderRadius: "999px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: barColor,
            borderRadius: "999px",
            transition: "width 0.4s ease",
          }}
        />
      </div>
      {danger && (
        <p
          style={{
            fontSize: "12px",
            color: "#EF4444",
            marginTop: "8px",
            fontWeight: 500,
          }}
        >
          You&apos;ve used {pct}% of your {plan} plan quota. Additional try-ons will be charged per use.
        </p>
      )}
    </div>
  );
}

// ─── Plan card ────────────────────────────────────────────────────────────────

function PlanCard({ config, isCurrent, currentPlanKey, isSubmitting }) {
  const currentRank = PLAN_RANK[currentPlanKey] ?? 0;
  const thisRank    = PLAN_RANK[config.key]     ?? 0;
  const isDowngrade = thisRank < currentRank;
  const isUpgrade   = thisRank > currentRank;

  let ctaLabel = config.buttonLabel;
  if (!isCurrent) {
    if (isDowngrade)      ctaLabel = `Downgrade to ${config.name}`;
    else if (isUpgrade)   ctaLabel = `Upgrade to ${config.name}`;
  }

  return (
    <div className={`vto-plan-card${config.featured ? " vto-plan-card--featured" : ""}`}>
      {/* Badge row */}
      <div className="vto-plan-badge-row">
        {config.badge ? (
          <span className={`vto-plan-badge vto-plan-badge--${config.badge.variant}`}>
            {config.badge.label}
          </span>
        ) : (
          <span className="vto-plan-badge-spacer" />
        )}
      </div>

      {/* Header */}
      <div className="vto-plan-header">
        <p className="vto-plan-name">{config.name}</p>
        <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
          <p className="vto-plan-price">{config.price}</p>
          {config.priceSub && (
            <span style={{ fontSize: "13px", color: "#6B7280", fontWeight: 400 }}>
              {config.priceSub}
            </span>
          )}
        </div>
        {config.extraRate && (
          <p style={{ fontSize: "11px", color: "#9CA3AF", marginTop: "4px", fontWeight: 500 }}>
            {config.extraRate}
          </p>
        )}
        <p className="vto-plan-desc" style={{ marginTop: "10px" }}>
          {config.description}
        </p>
      </div>

      {/* Features */}
      <ul className="vto-plan-features">
        {config.features.map((f, i) => (
          <li key={i} className="vto-plan-feature-item">
            <FeatureCheck />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      {/* CTA */}
      <div className="vto-plan-cta">
        {isCurrent ? (
          <button className="vto-plan-btn vto-plan-btn--outline" disabled>
            Current Plan
          </button>
        ) : (
          <Form method="post" style={{ width: "100%" }}>
            <input type="hidden" name="plan" value={config.key} />
            <button
              type="submit"
              className={`vto-plan-btn vto-plan-btn--${isDowngrade ? "secondary" : config.buttonVariant}`}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Processing…" : ctaLabel}
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}

// ─── FAQ accordion ────────────────────────────────────────────────────────────

function FaqAccordion() {
  const [open, setOpen] = useState(null);

  return (
    <div className="vto-faq">
      <hr className="vto-faq-divider" />
      <h2 className="vto-faq-heading">Frequently Asked Questions</h2>

      {FAQ_ITEMS.map((item, i) => (
        <div key={i} className="vto-faq-item">
          <button
            className="vto-faq-question"
            onClick={() => setOpen(open === i ? null : i)}
            aria-expanded={open === i}
          >
            <span>{item.q}</span>
            <Chevron open={open === i} />
          </button>
          <div
            className="vto-faq-answer"
            style={{ maxHeight: open === i ? "300px" : "0" }}
          >
            <p>{item.a}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Plans() {
  const { currentPlan, usedTryons, limitTryons, billingDeclined, planUpgraded } = useLoaderData();
  const actionData   = useActionData();
  const navigation   = useNavigation();
  const navigate     = useNavigate();
  const isSubmitting = navigation.state === "submitting";

  // Auto-redirect to Shopify billing page as soon as we have the URL.
  // window.top.location.href works in Shopify's embedded iframe (allow-top-navigation).
  // The button below is the fallback if the browser blocks the automatic redirect.
  useEffect(() => {
    if (!actionData?.billingUrl) return;
    try {
      window.top.location.href = actionData.billingUrl;
    } catch {
      // Cross-origin blocked — user will click the button below
    }
  }, [actionData?.billingUrl]);

  if (actionData?.billingUrl) {
    return (
      <Page backAction={{ onAction: () => navigate("/app"), content: "Dashboard" }}>
        <div style={{ textAlign: "center", padding: "80px 20px" }}>
          <p style={{ fontSize: "15px", color: "#6B7280", marginBottom: "20px" }}>
            Redirecting to Shopify billing…
          </p>
          <a
            href={actionData.billingUrl}
            target="_top"
            rel="noreferrer"
            style={{
              display: "inline-block",
              background: "#1D9E75",
              color: "#fff",
              padding: "14px 32px",
              borderRadius: "8px",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: "15px",
            }}
          >
            Click here if not redirected automatically →
          </a>
        </div>
      </Page>
    );
  }

  return (
    <Page backAction={{ onAction: () => navigate("/app"), content: "Dashboard" }}>
      <div className="vto-plan-page">

        {/* Plan upgrade success banner */}
        {planUpgraded && (
          <div style={{
            background: "#D1FAE5",
            border: "1px solid #6EE7B7",
            borderRadius: "8px",
            padding: "14px 18px",
            marginBottom: "24px",
            fontSize: "14px",
            color: "#065F46",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}>
            <span style={{ fontSize: "20px" }}>✅</span>
            <span>
              Your plan has been upgraded to <strong>{currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}</strong> successfully!
              Your new features are active now.
            </span>
          </div>
        )}

        {/* Action error banner */}
        {actionData?.error && (
          <div style={{
            background: "#FEE2E2",
            border: "1px solid #EF4444",
            borderRadius: "8px",
            padding: "12px 16px",
            marginBottom: "24px",
            fontSize: "14px",
            color: "#991B1B",
          }}>
            ⚠ {actionData.error}
          </div>
        )}

        {/* Billing declined notice */}
        {billingDeclined && (
          <div style={{
            background: "#FFF3CD",
            border: "1px solid #F59E0B",
            borderRadius: "8px",
            padding: "12px 16px",
            marginBottom: "24px",
            fontSize: "14px",
            color: "#92400E",
          }}>
            The subscription request was declined. You can upgrade again whenever you&apos;re ready.
          </div>
        )}

        {/* Header */}
        <div className="vto-plan-page-header">
          <span className="vto-pricing-pill">PRICING</span>
          <h1 className="vto-plan-page-title">Choose Your Plan</h1>
          <p className="vto-plan-page-subtitle">
            Simple, transparent pricing that grows with your store. No hidden fees.
          </p>
        </div>

        {/* Usage meter */}
        <UsageMeter used={usedTryons} limit={limitTryons} plan={currentPlan} />

        {/* Cards grid */}
        <div className="vto-plan-grid">
          {PLAN_CONFIG.map((config) => (
            <PlanCard
              key={config.key}
              config={config}
              isCurrent={currentPlan === config.key}
              currentPlanKey={currentPlan}
              isSubmitting={isSubmitting}
            />
          ))}
        </div>

        {/* FAQ */}
        <FaqAccordion />
      </div>
    </Page>
  );
}

// ─── Error boundary ───────────────────────────────────────────────────────────

export function ErrorBoundary() {
  const error = useRouteError();

  const message =
    error?.message ??
    error?.data ??
    (typeof error === "string" ? error : null) ??
    "An unexpected error occurred.";

  const stack =
    typeof error?.stack === "string" ? error.stack : null;

  return (
    <div style={{ padding: "40px 24px", fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ color: "#dc2626", marginBottom: "16px" }}>Plans Page Error</h2>
      <pre
        style={{
          background: "#fee2e2",
          border: "1px solid #fca5a5",
          padding: "16px",
          borderRadius: "8px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontSize: "13px",
          color: "#7f1d1d",
          marginBottom: "12px",
        }}
      >
        {message}
      </pre>
      {stack && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: "13px", color: "#6b7280" }}>
            Stack trace
          </summary>
          <pre
            style={{
              background: "#f9fafb",
              padding: "12px",
              borderRadius: "6px",
              fontSize: "12px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              marginTop: "8px",
            }}
          >
            {stack}
          </pre>
        </details>
      )}
    </div>
  );
}
