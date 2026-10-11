/*
 * Optional Cloudflare Worker proxy for GameDock's Modrinth search.
 * Deploy as a Worker, then set API_BASE in app.js to the Worker URL.
 * Route used by the frontend: https://YOUR-WORKER.workers.dev/search?...query params...
 */
const MODRINTH_SEARCH_URL = 'https://api.modrinth.com/v2/search';
const ALLOWED_ORIGIN = '*'; // In production, replace * with your GitHub Pages origin.
const USER_AGENT = 'GameDock-Modrinth-Explorer/1.0 (GitHub Pages community tool)';

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== 'GET') return json({ error: 'method_not_allowed', description: 'Only GET requests are supported.' }, 405, corsHeaders);
    if (requestUrl.pathname !== '/search') return json({ error: 'not_found', description: 'Use the /search endpoint.' }, 404, corsHeaders);

    const query = (requestUrl.searchParams.get('query') || '').slice(0, 240);
    const limit = Math.max(1, Math.min(20, Number.parseInt(requestUrl.searchParams.get('limit') || '12', 10) || 12));
    const offset = Math.max(0, Math.min(10000, Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10) || 0));
    const sort = requestUrl.searchParams.get('index') || 'relevance';
    const validSorts = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated']);
    const facetsRaw = requestUrl.searchParams.get('facets');
    let facets;
    try { facets = facetsRaw ? JSON.parse(facetsRaw) : []; }
    catch { return json({ error: 'invalid_facets', description: 'The facets parameter must be JSON.' }, 400, corsHeaders); }
    if (!Array.isArray(facets) || facets.length > 8 || facets.some(group => !Array.isArray(group) || group.length > 8 || group.some(item => typeof item !== 'string' || item.length > 100))) {
      return json({ error: 'invalid_facets', description: 'The facets structure is invalid.' }, 400, corsHeaders);
    }

    const upstream = new URL(MODRINTH_SEARCH_URL);
    if (query) upstream.searchParams.set('query', query);
    if (facets.length) upstream.searchParams.set('facets', JSON.stringify(facets));
    upstream.searchParams.set('index', validSorts.has(sort) ? sort : 'relevance');
    upstream.searchParams.set('limit', String(limit));
    upstream.searchParams.set('offset', String(offset));

    try {
      const response = await fetch(upstream.toString(), {
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
      });
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': response.headers.get('Content-Type') || 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30' }
      });
    } catch {
      return json({ error: 'upstream_unavailable', description: 'Could not reach Modrinth right now. Try again shortly.' }, 502, corsHeaders);
    }
  }
};

function json(value, status, headers) {
  return new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
