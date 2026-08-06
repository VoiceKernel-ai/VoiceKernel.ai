/**
 * Generates web/docs.html and web/openapi.json.
 *
 * The docs used to be a JSON route on the API, which meant voicekernel.ai/docs - * linked from the nav of every marketing page - was a dead end whenever the API
 * origin was unreachable, and raw JSON even when it was. Documentation is the
 * one thing that must render for a visitor who has no account and no API.
 *
 * So it is generated from the same in-repo sources the server uses (the provider
 * operation map, the provider catalog, the event vocabulary) and shipped as a
 * static page. It cannot drift from the API, and it cannot go down with it.
 *
 *   npm run gen:docs
 */
import fs from 'node:fs';
import path from 'node:path';

import { PROVIDER_OPERATIONS, PROVIDER_OPERATION_COUNT } from '../src/provider/operations.generated';
import {
  LLM_PROVIDERS,
  TOOL_TYPES,
  TRANSCRIBER_PROVIDERS,
  VOICE_PROVIDERS,
} from '../src/provider/catalog.generated';
import { POLICY_BY_OPERATION } from '../src/provider/resources';
import { RESOURCE_ROUTES } from '../src/routes/v1/generic';
import { AVAILABLE_SCOPES } from '../src/services/apikeys';
import { EVENT_TYPES } from '../src/services/webhooks';

const WEB_DIR = path.resolve(__dirname, '../web');
const BASE = process.env.PUBLIC_BASE_URL ?? 'https://voicekernel.ai';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Section {
  id: string;
  title: string;
  body: string;
}

const modelCount = LLM_PROVIDERS.reduce((n, p) => n + p.options.length, 0);

// ---------------------------------------------------------------------------

function quickstart(): string {
  return `
<p class="lede">Every VoiceKernel object is an API call. Authenticate with a key from
Settings &rarr; API keys, then create an agent and put it on a line.</p>

<h3>1 &middot; Create an agent</h3>
<pre class="code"><span class="c"># An agent is a prompt, a model, a voice and the actions it may call.</span>
curl ${esc(BASE)}/v1/agents \\
  -H <span class="s">"Authorization: Bearer $VK_KEY"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{
    "name": "Card disputes",
    "systemPrompt": "You are a card disputes specialist for a retail bank. Answer only from the supplied policy documents. If unsure, escalate to a human.",
    "firstMessage": "Thanks for calling - how can I help with your card today?",
    "model": { "provider": "anthropic", "model": "claude-sonnet-5", "temperature": 0.3 },
    "voice": { "provider": "11labs", "voiceId": "matilda" },
    "transcriber": { "provider": "deepgram", "model": "nova-3" }
  }'</span></pre>

<h3>2 &middot; Place a call</h3>
<pre class="code">curl ${esc(BASE)}/v1/calls \\
  -H <span class="s">"Authorization: Bearer $VK_KEY"</span> \\
  -H <span class="s">"Idempotency-Key: $(uuidgen)"</span> \\
  -d <span class="s">'{ "to": "+61400000000", "agentId": "asst_…", "metadata": { "ticket": "INC-9912" } }'</span></pre>

<h3>3 &middot; Receive the outcome</h3>
<pre class="code">curl ${esc(BASE)}/v1/webhook-endpoints \\
  -H <span class="s">"Authorization: Bearer $VK_KEY"</span> \\
  -d <span class="s">'{ "url": "https://crm.example.com/hooks/voicekernel", "events": ["call.ended"] }'</span>

<span class="c"># The response carries the signing secret, once. Store it.</span></pre>

<div class="callout">
  <b>Switching models never touches the prompt.</b> The upstream provider stores
  the system prompt inside its model object, so a naive patch clobbers it.
  <code>PUT /v1/agents/:id/model</code> preserves it.
</div>`;
}

function authSection(): string {
  return `
<p>Pass your key as a bearer token. <code>X-API-Key</code> is also accepted, for
gateways that will not forward <code>Authorization</code>.</p>
<pre class="code">Authorization: Bearer vk_live_…</pre>

<p>Keys are scoped. A key that lacks a scope is refused with <code>403</code> and told
which scope it needed - it does not silently return an empty list.</p>

<div class="pills">${AVAILABLE_SCOPES.map((s) => `<span class="pill">${esc(s)}</span>`).join('')}</div>

<h3>Errors</h3>
<p>Every failure has the same shape. Quote <code>requestId</code> when reporting a problem.</p>
<pre class="code">{
  <span class="k">"error"</span>: {
    <span class="k">"type"</span>:      <span class="s">"permission_error"</span>,
    <span class="k">"code"</span>:      <span class="s">"permission_denied"</span>,
    <span class="k">"message"</span>:   <span class="s">"This API key lacks the \\"agents:write\\" scope."</span>,
    <span class="k">"requestId"</span>: <span class="s">"req_8f21…"</span>
  }
}</pre>

<h3>Idempotency</h3>
<p>Send <code>Idempotency-Key</code> on any <code>POST</code> or <code>PATCH</code>. A replay returns the
original response rather than repeating the operation - so a timeout you retry
cannot place a second call. Reusing a key with a different body is a
<code>409</code>, because that is a client bug worth surfacing loudly.</p>

<h3>Pagination</h3>
<p><code>?limit=&amp;offset=</code>. Responses carry <code>{ data, pagination }</code>.</p>

<h3>Rate limits</h3>
<p><code>X-RateLimit-Limit</code>, <code>-Remaining</code> and <code>-Reset</code> on every response.
A <code>429</code> carries <code>Retry-After</code>.</p>`;
}

function webhooksSection(): string {
  return `
<p>Register an endpoint and VoiceKernel posts every event to it, signed, retried
with exponential backoff, and individually replayable from the console.</p>

<h3>Events</h3>
<div class="pills">${EVENT_TYPES.map((e) => `<span class="pill">${esc(e)}</span>`).join('')}<span class="pill">billing.threshold</span></div>
<p class="note">Subscribe to <code>*</code> for everything, or a prefix like <code>call.*</code>.</p>

<h3>Verifying a delivery</h3>
<p>This is the security-critical half of the integration. Without it, anyone who
learns your endpoint URL can forge call events.</p>
<pre class="code">X-VoiceKernel-Signature: t=1785668467,v1=9f2c…</pre>
<pre class="code"><span class="k">const</span> [t, v1] = header.split(<span class="s">','</span>).map(p =&gt; p.split(<span class="s">'='</span>)[1]);
<span class="k">const</span> expected = crypto
  .createHmac(<span class="s">'sha256'</span>, process.env.VK_WEBHOOK_SECRET)
  .update(<span class="s">\`\${t}.\${rawBody}\`</span>)
  .digest(<span class="s">'hex'</span>);

<span class="c">// Constant time, and over the RAW body - re-serialising changes key order.</span>
<span class="k">if</span> (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) <span class="k">return</span> res.sendStatus(<span class="n">401</span>);

<span class="c">// A valid signature replayed next week is still an attack.</span>
<span class="k">if</span> (Math.abs(Date.now() / <span class="n">1000</span> - Number(t)) &gt; <span class="n">300</span>) <span class="k">return</span> res.sendStatus(<span class="n">401</span>);</pre>

<div class="callout">
  Respond <code>2xx</code> to acknowledge. Anything else is retried up to 8 times with
  backoff, so acknowledge first and do slow work after.
</div>`;
}

function sdkSection(): string {
  return `
<h3>TypeScript <span class="tag ok">available</span></h3>
<pre class="code">npm install @voicekernel/sdk</pre>
<pre class="code"><span class="k">import</span> { VoiceKernel } <span class="k">from</span> <span class="s">'@voicekernel/sdk'</span>;

<span class="k">const</span> vk = <span class="k">new</span> VoiceKernel({ apiKey: process.env.VK_API_KEY });

<span class="k">const</span> agent = <span class="k">await</span> vk.agents.create({
  name: <span class="s">'Card disputes'</span>,
  systemPrompt: <span class="s">'You are a card disputes specialist…'</span>,
  model: { provider: <span class="s">'anthropic'</span>, model: <span class="s">'claude-sonnet-5'</span> },
});

<span class="c">// An idempotency key is attached automatically - a retried timeout</span>
<span class="c">// must never place a second call.</span>
<span class="k">await</span> vk.calls.create({ to: <span class="s">'+61400000000'</span>, agentId: agent.id });

<span class="c">// Walks every page.</span>
<span class="k">for await</span> (<span class="k">const</span> call <span class="k">of</span> vk.calls.iterate({ status: <span class="s">'ended'</span> })) { … }

<span class="c">// Anything not wrapped by a typed method.</span>
<span class="k">await</span> vk.provider(<span class="s">'GET'</span>, <span class="s">'/assistant/abc123'</span>);</pre>

<p><code>verifyWebhook()</code> throws rather than returning <code>false</code> - a caller who
forgets to check a boolean silently accepts forgeries.</p>

<h3>Python <span class="tag pending">not yet available</span></h3>
<h3>Go <span class="tag pending">not yet available</span></h3>
<p>Until those ship, generate a client from the
<a href="/openapi.json">OpenAPI document</a>.</p>`;
}

function surfaceSection(): string {
  const native = [
    ['/v1/agents', 'Voice agents - prompt, model, voice, actions'],
    ['/v1/calls', 'Place, inspect and end calls; transcripts and recordings'],
    ['/v1/analytics', 'Volume, containment, cost, and the latency budget'],
    ['/v1/catalog', 'Supported providers, models and action types'],
    ['/v1/webhook-endpoints', 'Signed event delivery into your systems'],
    ['/v1/events', 'Event history and the audit trail'],
    ['/v1/observe/monitors', 'Monitors and open issues'],
    ['/v1/governance/billing', 'Budget, alerts and the no-dead-line policy'],
    ['/v1/subjects/:number', 'Right to erasure, with a receipt'],
    ['/v1/api-keys', 'Credential management'],
    ['/v1/organization', 'Tenant settings and provider mode'],
    ...RESOURCE_ROUTES.map((r) => [`/v1/${r.segment}`, `CRUD for ${r.label}s`] as [string, string]),
  ];

  return `
<table class="ref">
  <thead><tr><th>Route</th><th>Purpose</th></tr></thead>
  <tbody>
    ${native.map(([p, d]) => `<tr><td><code>${esc(p)}</code></td><td>${esc(d)}</td></tr>`).join('\n    ')}
    <tr><td><code>/v1/provider/*</code></td><td><b>All ${PROVIDER_OPERATION_COUNT} upstream operations</b>, mediated</td></tr>
  </tbody>
</table>

<div class="callout">
  The native routes are ergonomics, not a cage. Anything they do not wrap is
  reachable through <code>/v1/provider/*</code> with the same auth, tenant isolation, rate
  limiting and audit. <code>GET /v1/provider/_operations</code> lists what your
  organisation can reach.
</div>`;
}

function operationsSection(): string {
  const byTag = new Map<string, typeof PROVIDER_OPERATIONS[number][]>();
  for (const endpoint of PROVIDER_OPERATIONS) {
    const list = byTag.get(endpoint.tag) ?? [];
    list.push(endpoint);
    byTag.set(endpoint.tag, list);
  }

  return `
<p class="lede">${PROVIDER_OPERATION_COUNT} operations, generated from the upstream OpenAPI
document - so this list is what the API accepts, not what someone remembered to
write down.</p>

${[...byTag.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([tag, endpoints]) => `
<h3>${esc(tag)}</h3>
<table class="ref ops">
  <tbody>
    ${endpoints
      .map((e) => {
        const policy = POLICY_BY_OPERATION.get(e.operationId);
        const restricted = policy?.scope === 'tenant';
        return `<tr>
      <td class="m"><span class="method ${e.method.toLowerCase()}">${e.method}</span></td>
      <td><code>/v1/provider${esc(e.path)}</code></td>
      <td>${esc(e.summary)}</td>
      <td class="r">${restricted ? '<span class="tag pending">shared-key restricted</span>' : ''}</td>
    </tr>`;
      })
      .join('\n    ')}
  </tbody>
</table>`,
  )
  .join('\n')}

<p class="note">Operations marked <em>shared-key restricted</em> aggregate an entire
upstream account. On the shared platform key that would span tenants, so they
are refused and answered from VoiceKernel's own org-scoped data instead. Adding
your own provider key enables them.</p>`;
}

function catalogSection(): string {
  const grid = (title: string, entries: readonly { provider: string; label: string; options: readonly string[] }[]) => `
<h3>${esc(title)} <span class="count">${entries.length}</span></h3>
<table class="ref">
  <thead><tr><th>Provider</th><th>Known values</th></tr></thead>
  <tbody>
    ${entries
      .map(
        (e) => `<tr><td><code>${esc(e.provider)}</code></td><td class="opts">${
          e.options.length
            ? e.options.slice(0, 8).map((o) => `<span class="pill">${esc(o)}</span>`).join('') +
              (e.options.length > 8 ? `<span class="pill dim">+${e.options.length - 8}</span>` : '')
            : '<span class="note">any provider-specific identifier</span>'
        }</td></tr>`,
      )
      .join('\n    ')}
  </tbody>
</table>`;

  return `
<p class="lede">Any agent can move between these without touching its prompt.
Generated from the upstream spec, so a value listed here is a value the API will
accept - <code>GET /v1/catalog</code> returns the same data at runtime.</p>

${grid('Language models', LLM_PROVIDERS)}
${grid('Voices', VOICE_PROVIDERS)}
${grid('Transcribers', TRANSCRIBER_PROVIDERS)}

<h3>Actions <span class="count">${TOOL_TYPES.length}</span></h3>
<table class="ref">
  <thead><tr><th>Type</th><th>Group</th><th></th></tr></thead>
  <tbody>
    ${TOOL_TYPES.map(
      (t) =>
        `<tr><td><code>${esc(t.type)}</code></td><td>${esc(t.group)}</td><td class="r">${
          t.custom ? '<span class="tag">your endpoint</span>' : '<span class="tag ok">built-in</span>'
        }</td></tr>`,
    ).join('\n    ')}
  </tbody>
</table>`;
}

// ---------------------------------------------------------------------------

function page(sections: Section[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API reference - VoiceKernel</title>
<meta name="description" content="VoiceKernel API reference: agents, calls, webhooks, the TypeScript SDK, and complete coverage of ${PROVIDER_OPERATION_COUNT} upstream voice operations.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png">
<link rel="shortcut icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0E1C2E">
<script>
(function(){try{var s=localStorage.getItem('vk-theme');if(s==='light'||s==='dark')document.documentElement.setAttribute('data-theme',s);}catch(e){}})();
</script>
<style>
:root{
  color-scheme:light;
  --ink:#0E1C2E;--ink-soft:#31445A;--porcelain:#F4F7F9;--panel:#0B1626;
  --panel-line:#1D2F45;--amber:#E8A13D;--amber-deep:#B87716;--teal:#0F5D5D;
  --teal-bright:#2E9E8F;--mist:#DEE7ED;--white:#FFF;--radius:10px;
}
/* Dark palette, keyed off the same data-theme attribute the console and
   marketing pages use, so one preference covers the whole site. */
:root[data-theme="dark"]{
  color-scheme:dark;
  --ink:#E4EDF5;--ink-soft:#8FA9BF;--porcelain:#0A1220;--panel:#0E1A2C;
  --panel-line:#1D2F45;--amber:#E8A13D;--amber-deep:#E8A13D;--teal:#2E9E8F;
  --teal-bright:#3FBFAE;--mist:#1D2F45;--white:#0E1A2C;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme]){
    color-scheme:dark;
    --ink:#E4EDF5;--ink-soft:#8FA9BF;--porcelain:#0A1220;--panel:#0E1A2C;
    --panel-line:#1D2F45;--amber:#E8A13D;--amber-deep:#E8A13D;--teal:#2E9E8F;
    --teal-bright:#3FBFAE;--mist:#1D2F45;--white:#0E1A2C;
  }
}
/* The nav background is a literal porcelain rgba below, so it does not follow
   the tokens - in dark mode it stayed pale while the text switched to pale.
   Same class of bug as the marketing exports. */
:root[data-theme="dark"] nav{background:rgba(10,18,32,.9);border-bottom-color:var(--panel-line)}
:root[data-theme="dark"] .btn{background:var(--amber);color:#0A1220}
:root[data-theme="dark"] .btn:hover{background:#F0B055}
:root[data-theme="dark"] table.ref th{background:var(--panel)}
:root[data-theme="dark"] table.ref tr:hover td{background:var(--panel)}
:root[data-theme="dark"] .callout,
:root[data-theme="dark"] .pill,
:root[data-theme="dark"] table.ref{border-color:var(--panel-line)}
@media (prefers-color-scheme: dark){
  :root:not([data-theme]) nav{background:rgba(10,18,32,.9);border-bottom-color:var(--panel-line)}
  :root:not([data-theme]) .btn{background:var(--amber);color:#0A1220}
  :root:not([data-theme]) .btn:hover{background:#F0B055}
  :root:not([data-theme]) table.ref th{background:var(--panel)}
  :root:not([data-theme]) table.ref tr:hover td{background:var(--panel)}
  :root:not([data-theme]) .callout,
  :root:not([data-theme]) .pill,
  :root:not([data-theme]) table.ref{border-color:var(--panel-line)}
}
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;width:40px;height:38px;border:1px solid var(--mist);border-radius:10px;background:var(--white);color:var(--ink-soft);padding:0;cursor:pointer;flex-shrink:0}
.theme-toggle:hover{color:var(--ink);border-color:var(--ink-soft)}
.theme-toggle svg{width:17px;height:17px}
.theme-toggle .i-sun{display:none}
.theme-toggle .i-moon{display:block}
:root[data-theme="dark"] .theme-toggle .i-sun{display:block}
:root[data-theme="dark"] .theme-toggle .i-moon{display:none}
@media (prefers-color-scheme: dark){
  :root:not([data-theme]) .theme-toggle .i-sun{display:block}
  :root:not([data-theme]) .theme-toggle .i-moon{display:none}
}
/* Touch targets: the TOC pills and footer links shipped at ~29-34px tall. */
@media (pointer:coarse){
  .toc a{min-height:42px;display:flex;align-items:center}
  .logo{min-height:42px}
  .theme-toggle{min-width:44px;min-height:42px}
  footer a{min-height:40px;display:inline-flex;align-items:center}
  .nav-links a{min-height:42px;display:inline-flex;align-items:center}
}
.nav-toggle{display:none;align-items:center;justify-content:center;flex:0 0 auto;
  width:44px;height:40px;border:1px solid var(--mist);border-radius:9px;
  background:var(--white);color:var(--ink);cursor:pointer;padding:0}
.nav-toggle svg{width:19px;height:19px}
.nav-toggle[aria-expanded="true"]{background:var(--ink);color:var(--white);border-color:var(--ink)}
@media (max-width:700px){
  .nav-toggle{display:inline-flex}
  /* Not display:none - the links become a panel the toggle reveals. */
  .nav-links{display:none;position:absolute;top:64px;left:0;right:0;
    flex-direction:column;gap:0;padding:6px 18px 12px;
    background:var(--porcelain);border-bottom:1px solid var(--mist)}
  .nav-links.open{display:flex}
  .nav-links a{padding:11px 0;border-bottom:1px solid var(--mist)}
  .nav-links a:last-child{border-bottom:0}
  .nav-inner{padding:0 18px;position:relative}
  main{padding:24px 0 64px}
  .hero h1{font-size:1.9rem}
  .stats{gap:18px}
}
@media (max-width:1000px){ .shell{grid-template-columns:minmax(0,1fr)} main{min-width:0} pre.code{max-width:100%} .table-scroll,table.ref{display:block;overflow-x:auto} }
.nav-right{display:flex;align-items:center;gap:14px}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:80px}
body{font-family:'IBM Plex Sans',system-ui,sans-serif;color:var(--ink);background:var(--porcelain);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
::selection{background:var(--amber);color:var(--ink)}
a{color:var(--teal)}
h1,h2,h3{font-family:'Archivo',sans-serif;line-height:1.1;letter-spacing:-.015em}
code{font-family:'IBM Plex Mono',monospace;font-size:.86em;background:var(--white);border:1px solid var(--mist);border-radius:4px;padding:1px 6px}

nav{position:sticky;top:0;z-index:50;background:rgba(244,247,249,.9);backdrop-filter:blur(10px);border-bottom:1px solid var(--mist)}
.nav-inner{max-width:1240px;margin:0 auto;padding:0 28px;display:flex;align-items:center;justify-content:space-between;height:64px}
.logo{display:flex;align-items:center;gap:10px;font-family:'Archivo';font-weight:800;font-size:1.12rem;letter-spacing:-.02em;text-decoration:none;color:var(--ink)}
.logo em{font-style:normal;color:var(--amber-deep)}
.logo .dot{font-weight:600;opacity:.55;font-size:.82em}
.logo .wordmark{white-space:nowrap}
.nav-links{display:flex;gap:26px;font-size:.9rem;font-weight:500}
.nav-links a{text-decoration:none;color:var(--ink-soft)}
.nav-links a:hover,.nav-links a[aria-current]{color:var(--ink)}
.btn{display:inline-block;font-weight:600;font-size:.9rem;padding:11px 20px;border-radius:var(--radius);text-decoration:none;background:var(--ink);color:var(--white)}
.btn:hover{background:#16283E}

.shell{max-width:1240px;margin:0 auto;padding:0 28px;display:grid;grid-template-columns:212px 1fr;gap:48px;align-items:start}
.toc{position:sticky;top:88px;padding:40px 0;font-size:.86rem}
.toc a{display:block;padding:6px 0;color:var(--ink-soft);text-decoration:none;border-left:2px solid transparent;padding-left:12px}
.toc a:hover{color:var(--ink)}
.toc a.on{color:var(--ink);font-weight:600;border-left-color:var(--amber)}
.toc .grp{font-family:'IBM Plex Mono';font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);opacity:.7;margin:20px 0 6px;padding-left:12px}

main{padding:40px 0 96px;min-width:0}
.hero{margin-bottom:44px}
.eyebrow{font-family:'IBM Plex Mono';font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--teal);display:flex;align-items:center;gap:10px;margin-bottom:14px}
.eyebrow{gap:0}
.hero h1{font-size:clamp(2rem,4vw,2.9rem);font-weight:900;margin-bottom:14px}
.hero p{font-size:1.06rem;color:var(--ink-soft);max-width:62ch}
.stats{display:flex;gap:30px;flex-wrap:wrap;margin-top:26px;padding-top:24px;border-top:1px solid var(--mist)}
.stat b{display:block;font-family:'Archivo';font-size:1.5rem;font-weight:800}
.stat span{font-family:'IBM Plex Mono';font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}

section{margin-bottom:56px;scroll-margin-top:80px}
section>h2{font-size:1.6rem;font-weight:800;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--mist)}
section h3{font-size:1.02rem;font-weight:800;margin:26px 0 10px}
section p{margin-bottom:12px;max-width:70ch}
.lede{color:var(--ink-soft)}
.note{font-size:.86rem;color:var(--ink-soft)}

pre.code{background:var(--panel);color:#C9D9E6;border-radius:12px;border:1px solid var(--panel-line);font-family:'IBM Plex Mono',monospace;font-size:.78rem;line-height:1.7;padding:18px 20px;overflow-x:auto;margin:12px 0 18px;white-space:pre}
pre.code .k{color:var(--amber)}
pre.code .s{color:var(--teal-bright)}
pre.code .c{color:#5A7690}
pre.code .n{color:#9FBBD1}

.callout{background:var(--white);border:1px solid var(--mist);border-left:3px solid var(--amber);border-radius:8px;padding:14px 18px;font-size:.9rem;color:var(--ink-soft);margin:18px 0}
.callout b{color:var(--ink)}

.pills{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 16px}
.pill{font-family:'IBM Plex Mono';font-size:.68rem;background:var(--white);border:1px solid var(--mist);border-radius:20px;padding:3px 10px;color:var(--ink-soft)}
.pill.dim{opacity:.6}

table.ref{width:100%;border-collapse:collapse;background:var(--white);border:1px solid var(--mist);border-radius:10px;overflow:hidden;margin:12px 0 20px;font-size:.88rem}
table.ref th{text-align:left;font-family:'IBM Plex Mono';font-size:.64rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);font-weight:500;padding:12px 16px;border-bottom:1px solid var(--mist);background:var(--porcelain)}
table.ref td{padding:11px 16px;border-bottom:1px solid var(--mist);color:var(--ink-soft);vertical-align:top}
table.ref tr:last-child td{border-bottom:none}
table.ref td code{background:transparent;border:none;padding:0;color:var(--ink);font-size:.82rem}
table.ref td.r{text-align:right;white-space:nowrap}
table.ref td.m{width:64px}
table.ref td.opts{padding:8px 16px}
table.ops td{padding:8px 16px;font-size:.84rem}

.method{font-family:'IBM Plex Mono';font-size:.62rem;font-weight:500;padding:2px 7px;border-radius:4px;letter-spacing:.06em}
.method.get{background:rgba(46,158,143,.14);color:var(--teal)}
.method.post{background:rgba(232,161,61,.16);color:var(--amber-deep)}
.method.patch{background:rgba(91,141,217,.14);color:#3C6BAF}
.method.put{background:rgba(91,141,217,.14);color:#3C6BAF}
.method.delete{background:rgba(208,106,78,.14);color:#B04A2E}

.tag{font-family:'IBM Plex Mono';font-size:.62rem;padding:2px 8px;border-radius:4px;background:var(--mist);color:var(--ink-soft);letter-spacing:.06em}
.tag.ok{background:rgba(46,158,143,.16);color:var(--teal)}
.tag.pending{background:rgba(232,161,61,.18);color:var(--amber-deep)}
.count{font-family:'IBM Plex Mono';font-size:.7rem;color:var(--ink-soft);font-weight:400}

footer{background:var(--panel);color:#8FA9BF;padding:44px 0;font-size:.85rem;margin-top:40px}
.foot-inner{max-width:1240px;margin:0 auto;padding:0 28px;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;font-family:'IBM Plex Mono';font-size:.72rem}
footer a{color:#8FA9BF;text-decoration:none}
footer a:hover{color:#D7E3EE}

@media (max-width:1000px){
  .shell{grid-template-columns:1fr;gap:0}
  .toc{position:static;padding:24px 0 0;display:flex;flex-wrap:wrap;gap:4px}
  .toc a{border-left:none;padding:5px 11px;border:1px solid var(--mist);border-radius:20px;background:var(--white)}
  .toc a.on{border-color:var(--amber-deep)}
  .toc .grp{display:none}
  .nav-links{display:none}
}
</style>
</head>
<body>

<nav>
  <div class="nav-inner">
    <a class="logo" href="/">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#0E1C2E"/>
        <g fill="#E8A13D"><rect x="11.25" y="8" width="3.5" height="16" rx="1.75"/><rect x="17.25" y="5" width="3.5" height="22" rx="1.75"/></g>
        <g fill="#2E9E8F"><rect x="5.25" y="12" width="3.5" height="8" rx="1.75"/><rect x="23.25" y="10" width="3.5" height="12" rx="1.75"/></g>
      </svg><span class="wordmark">Voice<em>Kernel</em><span class="dot">.ai</span></span></a>
    <div class="nav-links" id="navLinks">
      <a href="/#platform">Platform</a>
      <a href="/industries">Industries</a>
      <a href="/pricing">Pricing</a>
      <a href="/docs" aria-current="page">Docs</a>
    </div>
    <div class="nav-right">
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="Switch theme" title="Switch theme">
        <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round"/></svg>
        <svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      </button>
      <button class="nav-toggle" id="navToggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="navLinks">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke-linecap="round"/></svg>
      </button>
      <a class="btn" href="/app">Console</a>
    </div>
  </div>
</nav>

<div class="shell">
  <aside class="toc">
    <div class="grp">Start</div>
    ${sections
      .slice(0, 3)
      .map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`)
      .join('\n    ')}
    <div class="grp">Reference</div>
    ${sections
      .slice(3)
      .map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`)
      .join('\n    ')}
    <div class="grp">Machine readable</div>
    <a href="/openapi.json">OpenAPI 3.1</a>
  </aside>

  <main>
    <div class="hero">
      <span class="eyebrow">API reference</span>
      <h1>Build a voice channel in three calls.</h1>
      <p>VoiceKernel is the voice infrastructure layer for regulated enterprise.
      Create agents, place calls, ground answers in your own knowledge, and stream
      every event into your systems - with tenant isolation, an audit trail and
      signed webhooks as defaults rather than add-ons.</p>
      <div class="stats">
        <div class="stat"><b>${PROVIDER_OPERATION_COUNT}</b><span>operations covered</span></div>
        <div class="stat"><b>${modelCount}</b><span>models</span></div>
        <div class="stat"><b>${VOICE_PROVIDERS.length}</b><span>voice providers</span></div>
        <div class="stat"><b>${TOOL_TYPES.length}</b><span>action types</span></div>
      </div>
    </div>

    ${sections
      .map((s) => `<section id="${s.id}"><h2>${esc(s.title)}</h2>${s.body}</section>`)
      .join('\n\n    ')}
  </main>
</div>

<footer>
  <div class="foot-inner">
    <span>© 2026 VoiceKernel · PayFar Global Ltd</span>
    <span><a href="/openapi.json">OpenAPI</a> · <a href="/app">Console</a> · <a href="/pricing">Pricing</a></span>
  </div>
</footer>

<script>
(function () {
  var KEY = 'vk-theme';
  function effective() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  var button = document.getElementById('themeToggle');
  if (!button) return;
  button.addEventListener('click', function () {
    var next = effective() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
    button.setAttribute('aria-label', next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  });
})();

(function () {
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (!toggle || !links) return;

  function set(open) {
    links.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  toggle.addEventListener('click', function () {
    set(links.className.indexOf('open') === -1);
  });

  // A link inside the panel jumps to an anchor on this same page, which
  // leaves the menu covering the heading it just scrolled to.
  links.addEventListener('click', function (e) {
    if (e.target && e.target.tagName === 'A') set(false);
  });
})();
</script>

<script>
// Highlights the section currently in view. Progressive enhancement only:
// every link works with JavaScript disabled.
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  var sections = links
    .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
    .filter(Boolean);
  if (!('IntersectionObserver' in window) || !sections.length) return;

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      links.forEach(function (a) {
        a.classList.toggle('on', a.getAttribute('href') === '#' + entry.target.id);
      });
    });
  }, { rootMargin: '-80px 0px -70% 0px' });

  sections.forEach(function (s) { observer.observe(s); });
})();
</script>
</body>
</html>
`;
}

function main(): void {
  const sections: Section[] = [
    { id: 'quickstart', title: 'Quickstart', body: quickstart() },
    { id: 'authentication', title: 'Authentication & conventions', body: authSection() },
    { id: 'sdks', title: 'SDKs', body: sdkSection() },
    { id: 'webhooks', title: 'Webhooks', body: webhooksSection() },
    { id: 'surface', title: 'API surface', body: surfaceSection() },
    { id: 'catalog', title: 'Providers & models', body: catalogSection() },
    { id: 'operations', title: 'Upstream operations', body: operationsSection() },
  ];

  fs.mkdirSync(WEB_DIR, { recursive: true });
  fs.writeFileSync(path.join(WEB_DIR, 'docs.html'), page(sections));
  console.log('  wrote web/docs.html');

  // Static copy so /openapi.json resolves without the API being reachable.
  process.env.PUBLIC_BASE_URL = BASE;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildOpenApiDocument } = require('../src/routes/docs') as {
    buildOpenApiDocument: () => Record<string, unknown>;
  };
  fs.writeFileSync(
    path.join(WEB_DIR, 'openapi.json'),
    `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`,
  );
  console.log('  wrote web/openapi.json');
}

main();
