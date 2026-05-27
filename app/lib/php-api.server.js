/**
 * PHP API client — server-side only.
 * baseUrl and apiKey are never exposed to the client bundle.
 * Named .server.js so React Router excludes it from the browser bundle.
 *
 * Every request carries both:
 *   X-Api-Key: <per-shop merchant key>   — for PHP to resolve the merchant
 *   X-Shop-Domain: <shop domain>         — explicit fallback so PHP can always
 *                                          scope data to the correct shop even
 *                                          if the api_key lookup fails
 */
export default function phpApiClient(apiKey, baseUrl, shopDomain = null) {
  const base = baseUrl.replace(/\/$/, '');

  async function request(method, path, body = null, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
      };

      if (shopDomain) {
        headers['X-Shop-Domain'] = shopDomain;
      }

      const init = { method, headers, signal: controller.signal };

      if (body !== null) {
        init.body = JSON.stringify(body);
      }

      // Append shop as query param on GET requests for extra scoping
      let url = `${base}${path}`;
      if (shopDomain && method === 'GET' && !path.includes('shop=')) {
        const sep = path.includes('?') ? '&' : '?';
        url = `${url}${sep}shop=${encodeURIComponent(shopDomain)}`;
      }

      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        return { ok: false, error: data.error ?? 'Request failed', status: res.status };
      }

      return { ok: true, data };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        error: isAbort ? 'Request timed out' : (err?.message ?? 'Network error'),
        status: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getSettings: () =>
      request('GET', '/settings'),

    saveSettings: (data) =>
      request('POST', '/settings', data),

    getProducts: () =>
      request('GET', '/products'),

    syncProduct: (data) =>
      request('POST', '/products/sync', data),

    getVariantMappings: (productId) =>
      request('GET', `/variants/mapping?product_id=${productId}`),

    saveVariantMapping: (data) =>
      request('POST', '/variants/mapping', data),

    createSession: (data) =>
      request('POST', '/session/create', data, 35_000),

    trackAction: (sessionId, action) =>
      request('POST', '/session/track', { session_id: sessionId, action }),

    getAnalytics: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request('GET', `/analytics${qs ? '?' + qs : ''}`);
    },

    getPlans: () =>
      request('GET', '/plans'),

    checkPlanLimit: () =>
      request('GET', '/plan/limit'),

    updatePlan: (plan) =>
      request('POST', '/plan/update', { plan }),

    recordConversion: (data) =>
      request('POST', '/conversion', data),

    getShopInfo: () =>
      request('GET', '/shop'),

    getShopProducts: () =>
      request('GET', '/shop/products'),

    getWidgetSettings: () =>
      request('GET', '/widget/settings'),

    patchWidgetSettings: (data) =>
      request('PATCH', '/widget/settings', data),
  };
}
