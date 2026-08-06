/**
 * VoiceKernel edge Worker.
 *
 * Serves the marketing site and console from Cloudflare's edge, and proxies the
 * API to the origin that runs the Node control plane.
 *
 * Why a proxy rather than porting the API to Workers: the control plane depends
 * on argon2 (a native addon), node-postgres over TCP, and Express. None of those
 * run on the Workers runtime. Fronting the origin instead keeps one domain, one
 * TLS certificate and same-origin cookies - which is what the console's session
 * auth needs - without a rewrite that would change the security properties of
 * password hashing and tenant isolation.
 *
 * Set BACKEND_ORIGIN (e.g. https://api.voicekernel.ai) to activate the API.
 * Until it is set, API routes answer 503 with setup instructions rather than
 * failing opaquely.
 */

/**
 * Paths owned by the control plane, not by static assets.
 *
 * `/docs` is deliberately NOT here. It is linked from the nav of every
 * marketing page, so routing it to the origin made the entire public
 * documentation a dead end whenever the API was unreachable - and raw JSON even
 * when it was not. Documentation is the one thing that has to render for a
 * visitor with no account and no backend, so it ships as a static page built
 * from the same sources the API uses.
 */
const API_PREFIXES = ['/v1/', '/auth/', '/webhooks/'];
const API_EXACT = new Set(['/health', '/healthz']);

function isApiPath(pathname) {
  if (API_EXACT.has(pathname)) return true;
  return API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Static routes that answer a path the API also serves. */
// `/docs` itself is NOT aliased: the asset server already maps an
// extensionless path to its .html file, and asking it for `/docs.html`
// explicitly earns a redirect back to `/docs` - a loop the browser sees as a
// 307 instead of a page.
const STATIC_ALIASES = new Map([
  ['/docs/openapi.json', '/openapi.json'],
  // The operation map now lives inside the docs page and the OpenAPI document;
  // send anyone following the old API path somewhere that exists.
  ['/docs/operations', '/docs'],
]);

/**
 * Landing page A/B split.
 *
 * Two hero treatments compete for "/": the console-led page and the
 * photography-led one. The assignment is sticky per visitor via a cookie rather
 * than re-rolled per request, because a visitor who lands, opens Pricing and
 * comes back should not see a different homepage than the one they arrived on -
 * that reads as a broken site and would also make the results meaningless.
 *
 * `?variant=console|photo` forces one, so a specific page can be linked or
 * screenshotted without fighting the coin flip.
 */
// Extensionless on purpose. The asset server rewrites an explicit ".html" path
// to its trailing-slash form, so asking for "/index.html" returns a 307 rather
// than the page - the same trap that broke /docs and the console deep links.
const VARIANTS = {
  console: '/home',
  photo: '/landing',
};
const VARIANT_COOKIE = 'vk_variant';

function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

async function serveLanding(request, url, env) {
  const forced = url.searchParams.get('variant');
  const existing = readCookie(request, VARIANT_COOKIE);

  let variant;
  let assignedNow = false;
  if (forced && VARIANTS[forced]) {
    variant = forced;
  } else if (existing && VARIANTS[existing]) {
    variant = existing;
  } else {
    variant = Math.random() < 0.5 ? 'console' : 'photo';
    assignedNow = true;
  }

  const asset = await env.ASSETS.fetch(new Request(new URL(VARIANTS[variant], url.origin), request));
  const response = withSecurityHeaders(asset);
  const headers = new Headers(response.headers);

  // Two visitors share one URL but must not share one cached body, and the
  // asset server's ETag describes the file, not the variant.
  headers.set('Cache-Control', 'no-store');
  headers.delete('ETag');
  headers.set('X-Landing-Variant', variant);

  if (assignedNow || forced) {
    headers.append(
      'Set-Cookie',
      `${VARIANT_COOKIE}=${variant}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`,
    );
  }

  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (isApiPath(url.pathname)) {
      return proxyToOrigin(request, url, env);
    }

    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return serveLanding(request, url, env);
    }

    const alias = STATIC_ALIASES.get(url.pathname);
    if (alias) {
      return withSecurityHeaders(
        await env.ASSETS.fetch(new Request(new URL(alias, url.origin), request)),
      );
    }

    // The console is a single-page app: /app/settings and friends have no file
    // on disk, so they must render the shell.
    //
    // Deciding on the file extension rather than on the asset lookup's status
    // matters: the asset server answers an extensionless miss with a 307 to a
    // trailing-slash variant, and forwarding that would bounce the browser
    // instead of loading the app.
    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
      const looksLikeFile = /\.[a-z0-9]+$/i.test(url.pathname);

      if (looksLikeFile) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status < 400) return withSecurityHeaders(asset);
      }

      return withSecurityHeaders(
        // '/app/' rather than '/app/index.html': the asset server rewrites explicit
        // .html paths to their trailing-slash form, which would return a redirect.
        await env.ASSETS.fetch(new Request(new URL('/app/', url.origin), request)),
      );
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

async function proxyToOrigin(request, url, env) {
  const origin = env.BACKEND_ORIGIN;

  if (!origin) {
    return json(
      {
        error: {
          type: 'api_error',
          code: 'backend_not_configured',
          message:
            'The VoiceKernel API origin is not configured for this deployment. Set the BACKEND_ORIGIN secret on the Worker to the host running the control plane, then redeploy.',
        },
      },
      503,
    );
  }

  const target = new URL(url.pathname + url.search, origin);

  // Preserve the client's identity for the origin's rate limiting and audit
  // trail - behind a proxy, req.ip would otherwise be Cloudflare's.
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', 'https');
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('X-Forwarded-For', clientIp);

  // Host must match the origin, or its TLS/vhost routing rejects the request.
  headers.set('Host', target.host);

  try {
    const response = await fetch(
      new Request(target.toString(), {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      }),
    );

    // Streamed through unchanged so Set-Cookie and status codes survive.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    return json(
      {
        error: {
          type: 'api_error',
          code: 'upstream_unreachable',
          message: `Could not reach the VoiceKernel API origin: ${err.message}`,
        },
      },
      502,
    );
  }
}

/**
 * Static responses get the same hardening the Node app applies via helmet, so
 * serving from the edge does not quietly weaken the site's headers.
 */
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // The self-hosted WebRTC client fetches its versioned call-machine
      // bundle from the vendor's CDN at join time.
      "script-src 'self' 'unsafe-inline' https://c.dailywebrtc.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: https:",
      // WebRTC for in-browser test calls: the browser reaches the media
      // vendor directly, and the audio pipeline needs blob-backed workers.
      "connect-src 'self' https://*.daily.co wss://*.daily.co https://c.dailywebrtc.net https://*.dailywebrtc.net wss://*.dailywebrtc.net",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  return new Response(response.body, { status: response.status, headers });
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
