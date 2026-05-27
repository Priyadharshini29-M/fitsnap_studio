import { Form, redirect, useLoaderData, useNavigation, useNavigate } from "react-router";
import { useState } from "react";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import phpApiClient from "../lib/php-api.server";
import { ensureMerchant } from "../lib/merchant.server";
import { PHP_API_URL, SHOPIFY_APP_URL, NODE_ENV } from "../lib/env.server";

// ─── Billing ─────────────────────────────────────────────────────────────────

const PLAN_KEY_MAP = {
  growth: "FitSnap Growth",
  pro:    "FitSnap Pro",
};

// Numeric rank for upgrade vs downgrade label
const PLAN_RANK = { free: 0, growth: 1, pro: 2 };

export async function loader({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const apiKey = await ensureMerchant(session);
  const api = phpApiClient(apiKey, PHP_API_URL, session.shop);

  const url = new URL(request.url);
  const chargeId    = url.searchParams.get("charge_id");
  const pendingPlan = url.searchParams.get("plan");

  if (chargeId && pendingPlan && PLAN_KEY_MAP[pendingPlan]) {
    const gqlRes = await admin.graphql(`
      #graphql
      query {
        currentAppInstallation {
          activeSubscriptions { name status }
        }
      }
    `);
    const gqlData    = await gqlRes.json();
    const activeSubs = gqlData.data?.currentAppInstallation?.activeSubscriptions ?? [];
    const isActive   = activeSubs.some(
      (s) => s.name === PLAN_KEY_MAP[pendingPlan] && s.status === "ACTIVE"
    );
    if (isActive) await api.updatePlan(pendingPlan);
    throw redirect("/app/plans");
  }

  const planRes = await api.checkPlanLimit();
  const planData = planRes.ok ? planRes.data : null;

  const rawPlan = planData?.plan ?? "free";
  return {
    currentPlan: rawPlan === "basic" ? "free" : rawPlan,
    usedTryons:  planData?.used  ?? 0,
    limitTryons: planData?.limit ?? 10,
  };
}

export async function action({ request }) {
  const { admin, billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const planName = formData.get("plan");

  // ── Downgrade to free: cancel the active Shopify subscription ────────────
  if (planName === "free") {
    const gqlRes = await admin.graphql(`
      #graphql
      query GetActiveSubscriptions {
        currentAppInstallation {
          activeSubscriptions { id name status }
        }
      }
    `);
    const gqlData = await gqlRes.json();
    const activeSubs =
      gqlData.data?.currentAppInstallation?.activeSubscriptions ?? [];

    for (const sub of activeSubs) {
      if (sub.status === "ACTIVE") {
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

    // Sync plan change to PHP backend
    try {
      const { session: freeSession } = await authenticate.admin(request);
      const freeApiKey = await ensureMerchant(freeSession);
      await phpApiClient(freeApiKey, PHP_API_URL).updatePlan("free");
    } catch {
      // Non-blocking — plan will reconcile on next load
    }

    throw redirect("/app/plans");
  }

  // ── Upgrade or switch between paid plans ─────────────────────────────────
  const planKey = PLAN_KEY_MAP[planName];
  if (!planKey) return { error: "Invalid plan selected" };

  const appUrl = SHOPIFY_APP_URL.replace(/\/$/, "");
  await billing.request({
    plan:      planKey,
    isTest:    NODE_ENV !== "production",
    returnUrl: `${appUrl}/app/plans?plan=${planName}`,
  });

  return null;
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

// ─── Usage meter ─────────────────────────────────────────────────────────────

function UsageMeter({ used, limit, plan }) {
  const pct    = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const danger = pct >= 90;
  const warn   = pct >= 70;
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
    if (isDowngrade) ctaLabel = `Downgrade to ${config.name}`;
    else if (isUpgrade) ctaLabel = `Upgrade to ${config.name}`;
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
  const { currentPlan, usedTryons, limitTryons } = useLoaderData();
  const navigation   = useNavigation();
  const navigate     = useNavigate();
  const isSubmitting = navigation.state === "submitting";

  return (
    <Page backAction={{ onAction: () => navigate("/app"), content: "Dashboard" }}>
      <div className="vto-plan-page">
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
