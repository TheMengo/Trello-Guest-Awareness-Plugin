/** TEST ONLY: Playwright cannot route MV3 extension service-worker fetches.
 * Install in the isolated test worker before any request; production files are untouched.
 * No real Trello network or credentials are used by these browser fixtures.
 */
export function installWorkerApi({ mock, ids, members }) {
  globalThis.fixtureData = mock;
  globalThis.fixtureRequests = [];
  globalThis.fixtureViolations = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const pathname = url.pathname.replace(/^\/1/, '');
    const method = options.method ?? 'GET';
    globalThis.fixtureRequests.push({ method, pathname });
    function violation(message) { globalThis.fixtureViolations.push(message); throw new Error(message); }
    if (url.origin !== 'https://api.trello.com') return violation('Unexpected fixture fetch origin');
    if (method !== 'GET' || options.body) return violation('Extension request must be read-only');
    if (url.searchParams.has('token') || url.searchParams.has('key')) return violation('Credentials must stay out of query URLs');
    if (options.credentials !== 'omit') return violation('Extension must omit session credentials');
    if (options.redirect !== 'error') return violation('Extension must reject credential-bearing redirects');
    if (!new Headers(options.headers).get('Authorization')?.startsWith('OAuth ')) return violation('Missing documented API authorization header');
    const data = globalThis.fixtureData;
    if (data.delay) await new Promise(resolve => setTimeout(resolve, data.delay));
    if (data.status !== 200) return new Response('Fixture API error', { status: data.status });
    let body;
    if (/^\/cards\/[^/]+$/.test(pathname)) {
      const second = /CaRd5678|dddddddddddddddddddddddd/.test(pathname);
      body = { id: second ? ids.card2 : ids.card, idBoard: ids.board, idMembers: second ? data.card2Members : data.cardMembers };
    } else if (/^\/boards\/[^/]+\/members$/.test(pathname)) body = pathname.includes(ids.board2) ? [members.internal] : data.members;
    else if (/^\/boards\/[^/]+$/.test(pathname)) body = { id: /BoArd002|bbbbbbbbbbbbbbbbbbbbbbbb/.test(pathname) ? ids.board2 : ids.board, idOrganization: data.noWorkspace ? null : ids.workspace };
    else if (/^\/organizations\/[^/]+\/members$/.test(pathname)) body = data.workspace;
    else if (pathname === '/members/me') body = { id: ids.internal };
    else return violation(`Unexpected fixture endpoint: ${pathname}`);
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status: 200 });
  };
}
