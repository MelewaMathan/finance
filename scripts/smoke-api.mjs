/**
 * End-to-end API smoke check against a running server.
 *
 * Usage: node scripts/smoke-api.mjs [baseUrl]
 *
 * Verifies the M1 slice: login, session bootstrap, profile read/write,
 * auditor write rejection, and refresh-token rotation. It prints a compact
 * PASS/FAIL table so the demo can be checked with one command.
 */
const base = (process.argv[2] || 'http://127.0.0.1:4000').replace(/\/$/, '');
const password = 'Passw0rd!demo';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function call(path, { method = 'GET', token, body, cookie } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (docs HTML) */
  }
  return { status: response.status, json, text, setCookie: response.headers.getSetCookie?.() ?? [] };
}

function refreshCookieOf(setCookie) {
  const entry = setCookie.find((value) => value.startsWith('smf_refresh='));
  return entry ? entry.split(';')[0] : null;
}

async function main() {
  const health = await call('/api/health');
  record('GET /api/health', health.status === 200 && health.json?.status === 'ok', `status ${health.status}`);

  const docs = await call('/api/docs/');
  record('GET /api/docs', docs.status === 200, `status ${docs.status}`);

  const login = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'borrower@smf.demo', password },
  });
  record('POST /auth/login (borrower)', login.status === 200 && Boolean(login.json?.accessToken), `status ${login.status}`);
  const token = login.json?.accessToken;
  const cookie = refreshCookieOf(login.setCookie);

  const badLogin = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'borrower@smf.demo', password: 'wrong-password' },
  });
  record('POST /auth/login (bad password)', badLogin.status === 401, `status ${badLogin.status}`);

  const me = await call('/api/v1/auth/me', { token });
  record('GET /auth/me', me.status === 200 && me.json?.user?.role === 'borrower', `status ${me.status}`);

  const unauth = await call('/api/v1/me/profile');
  record('GET /me/profile without token', unauth.status === 401, `status ${unauth.status}`);

  const update = await call('/api/v1/me/profile', {
    method: 'PUT',
    token,
    body: { occupation: 'Tailor', monthlyIncomeCents: 4500000, address: 'Kawangware, Nairobi' },
  });
  record('PUT /me/profile', update.status === 200, `status ${update.status}`);

  const auditorLogin = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'auditor@smf.demo', password },
  });
  const auditorToken = auditorLogin.json?.accessToken;
  record('POST /auth/login (auditor)', auditorLogin.status === 200, `status ${auditorLogin.status}`);

  const auditorWrite = await call('/api/v1/me/profile', {
    method: 'PUT',
    token: auditorToken,
    body: { occupation: 'nope' },
  });
  record('PUT /me/profile as auditor (read-only)', auditorWrite.status === 403, `status ${auditorWrite.status}`);

  if (cookie) {
    const refreshed = await call('/api/v1/auth/refresh', { method: 'POST', cookie });
    const rotatedCookie = refreshCookieOf(refreshed.setCookie) ?? cookie;
    record('POST /auth/refresh (rotation)', refreshed.status === 200 && Boolean(refreshed.json?.accessToken), `status ${refreshed.status}`);

    // Immediate replay of the same cookie is the two-tab race: allowed by design.
    const concurrent = await call('/api/v1/auth/refresh', { method: 'POST', cookie });
    record('POST /auth/refresh (concurrent replay)', concurrent.status === 200, `status ${concurrent.status}`);

    // Rotate once more, then replay a token whose replacement is already dead:
    // that is theft and must revoke the family.
    const second = await call('/api/v1/auth/refresh', { method: 'POST', cookie: rotatedCookie });
    record('POST /auth/refresh (second rotation)', second.status === 200, `status ${second.status}`);
    const stolen = await call('/api/v1/auth/refresh', { method: 'POST', cookie });
    record('POST /auth/refresh with superseded token', stolen.status === 401, `status ${stolen.status}`);
  } else {
    record('refresh cookie returned by login', false, 'no smf_refresh Set-Cookie');
  }

  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[smoke] failed:', error);
  process.exit(1);
});
