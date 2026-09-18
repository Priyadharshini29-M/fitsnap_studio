import { Link } from "react-router";
import { planAtLeast, PLAN_LABELS, PLAN_PRICES } from "../lib/plans";

function LockIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="3" stroke="var(--accent-500, #4F46E5)" strokeWidth="1.6" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="var(--accent-500, #4F46E5)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function UpgradeCard({ label, price, featureName }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "18px",
        padding: "40px 32px",
        textAlign: "center",
        background: "var(--surface-1, #fff)",
        borderRadius: "var(--radius-lg, 16px)",
        border: "1px solid var(--border-subtle, #E8E8EC)",
        boxShadow: "var(--shadow-md, 0 4px 12px rgba(15,23,42,0.06))",
        maxWidth: "420px",
        margin: "0 auto",
        width: "100%",
      }}
    >
      <div
        style={{
          width: "56px",
          height: "56px",
          borderRadius: "var(--radius-md, 12px)",
          background: "var(--accent-50, #EEF0FD)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <LockIcon />
      </div>
      <div>
        <p style={{ fontSize: "13px", fontWeight: 700, color: "var(--ink-900, #0B0F19)", margin: 0, letterSpacing: "-0.01em" }}>
          {featureName ?? "This feature"} requires the {label} plan
        </p>
        <p style={{ fontSize: "11px", color: "var(--ink-500, #6B7280)", marginTop: "6px", lineHeight: 1.55 }}>
          Upgrade to {label} ({price}) to unlock this feature and more.
        </p>
      </div>
      <Link
        to="/app/plans"
        style={{
          display: "inline-block",
          padding: "10px 28px",
          background: "var(--accent-500, #4F46E5)",
          color: "#fff",
          borderRadius: "var(--radius-sm, 8px)",
          textDecoration: "none",
          fontSize: "12px",
          fontWeight: 600,
          letterSpacing: "0.01em",
          transition: "background 0.15s ease",
        }}
      >
        View Plans
      </Link>
    </div>
  );
}

/**
 * Renders children when the plan qualifies, otherwise shows an upgrade prompt.
 * mode="replace" — replaces content entirely (for full-page or tab gates).
 * mode="overlay" — blurs children and overlays the prompt (for inline section gates).
 */
export default function PlanGate({
  currentPlan,
  requiredPlan,
  featureName,
  children,
  mode = "replace",
}) {
  if (planAtLeast(currentPlan, requiredPlan)) {
    return children;
  }

  const label = PLAN_LABELS[requiredPlan] ?? requiredPlan;
  const price = PLAN_PRICES[requiredPlan] ?? "";

  if (mode === "overlay") {
    return (
      <div style={{ position: "relative" }}>
        <div
          style={{
            filter: "blur(4px)",
            pointerEvents: "none",
            userSelect: "none",
            opacity: 0.35,
          }}
        >
          {children}
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255,255,255,0.7)",
            borderRadius: "12px",
            padding: "16px",
          }}
        >
          <UpgradeCard label={label} price={price} featureName={featureName} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "48px 16px" }}>
      <UpgradeCard label={label} price={price} featureName={featureName} />
    </div>
  );
}
