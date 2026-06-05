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
import https from "node:https";
const phpHttpsAgent = new https.Agent({ rejectUnauthorized: false });

export default function phpApiClient(apiKey, baseUrl, shopDomain = null) {
  const base = baseUrl.replace(/\/$/, '');

  function request(method, path, body = null, timeoutMs = 10_000) {
    if (!base) {
      return Promise.resolve({ ok: false, error: 'PHP_API_URL is not configured on this server.', status: 0 });
    }

    // Append shop as query param on GET requests for extra scoping
    let urlStr = `${base}${path}`;
    if (shopDomain && method === 'GET' && !path.includes('shop=')) {
      const sep = path.includes('?') ? '&' : '?';
      urlStr = `${urlStr}${sep}shop=${encodeURIComponent(shopDomain)}`;
    }
    // POST/PUT/PATCH: also append shop so PHP can always scope
    if (shopDomain && method !== 'GET' && !urlStr.includes('shop=')) {
      const sep = urlStr.includes('?') ? '&' : '?';
      urlStr = `${urlStr}${sep}shop=${encodeURIComponent(shopDomain)}`;
    }

    const headers = {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (shopDomain) headers['X-Shop-Domain'] = shopDomain;

    const bodyStr = body !== null ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();

    const parsed = new URL(urlStr);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        req.destroy();
        resolve({ ok: false, error: 'Request timed out', status: 0 });
      }, timeoutMs);

      const req = https.request(
        { hostname: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search, method, headers, agent: phpHttpsAgent },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            clearTimeout(timer);
            let data = {};
            try { data = JSON.parse(raw); } catch { data = {}; }
            if (!res.ok && (res.statusCode < 200 || res.statusCode >= 300)) {
              const errMsg = data.error ?? data.message ?? data.msg ?? data.detail ?? (Array.isArray(data.errors) ? data.errors[0] : null) ?? `Request failed (HTTP ${res.statusCode})`;
              resolve({ ok: false, error: errMsg, status: res.statusCode });
            } else {
              resolve({ ok: true, data });
            }
          });
        }
      );
      req.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err?.message ?? 'Network error', status: 0 });
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
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

    updateVariantMapping: (id, data) =>
      request('PUT', `/variants/mapping/${id}`, data),

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
