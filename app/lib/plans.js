export const PLAN_ORDER = ['free', 'growth', 'pro'];

export const PLAN_LABELS = {
  free:   'Preview',
  growth: 'Growth',
  pro:    'Pro',
};

export const PLAN_PRICES = {
  free:   'Free',
  growth: '$19/month',
  pro:    '$49/month',
};

export const PLAN_TRYONS = {
  free:   10,
  growth: 100,
  pro:    500,
};

/** Returns true if currentPlan meets or exceeds requiredPlan. */
export function planAtLeast(currentPlan, requiredPlan) {
  const ci = PLAN_ORDER.indexOf(currentPlan ?? 'free');
  const ri = PLAN_ORDER.indexOf(requiredPlan);
  if (ri === -1 || ci === -1) return false;
  return ci >= ri;
}
