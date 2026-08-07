/**
 * Generates the pages VoiceKernel writes itself: pricing and partners.
 *
 * These are not design exports. The pricing page describes the licensing model
 * and the partners page carries a form that posts to the API, so both need to
 * stay in step with the code rather than with a design file. Keeping them here
 * means a change to the model is a change to this repository, reviewable like
 * anything else.
 *
 *   npm run gen:marketing
 */
import fs from 'node:fs';
import path from 'node:path';
import { SHELL_STYLE, SHELL_FOOTER, THEME_SCRIPT, navFor } from './lib/shell';
import { SECTORS } from './lib/sectors';

const WEB_DIR = path.resolve(__dirname, '../web');

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PAGE_CSS = `
/* The docs shell centres its content with .shell; it has no .wrap. These pages
   use .wrap like the imported marketing pages do, so it has to be defined here
   or every section renders full-bleed with the text jammed against the left
   edge. Same geometry as .shell and .nav-inner, so the columns line up. */
.wrap{max-width:1240px;margin-left:auto;margin-right:auto;padding:0 28px}
@media (max-width:860px){ .wrap{padding:0 18px} }

.mhero{padding:66px 0 22px;text-align:center}
.mhero h1{font-family:'Archivo';font-size:2.5rem;font-weight:800;letter-spacing:-.03em;line-height:1.08}
.mhero p{font-size:1.06rem;color:var(--ink-soft);max-width:62ch;margin:14px auto 0}
/* The shared shell sets .eyebrow to display:flex for the decorative rule it
   used to carry. Left as flex inside a centred hero it stretches full width and
   the label sits hard against the left edge, ignoring text-align. */
.eyebrow{font-family:'IBM Plex Mono';font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;
  color:var(--teal-bright);margin-bottom:12px;display:block}
.mhero .eyebrow{text-align:center}

.editions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:40px 0 20px;align-items:stretch}
.ed{border:1px solid var(--mist);border-radius:14px;padding:28px;background:var(--white);display:flex;flex-direction:column}
.ed.featured{background:var(--panel);border-color:var(--panel);color:#EAF2F8;position:relative}
/* In dark mode --white resolves to the panel navy, so both cards came out the
   same colour and the featured one stopped reading as featured. Give the
   plain card a distinct surface and the featured one its amber edge. */
:root[data-theme="dark"] .ed{background:#0A1220;border-color:#1D2F45}
:root[data-theme="dark"] .ed.featured{background:#16283E;border-color:var(--amber)}
.ed.featured h3,.ed.featured .price{color:#fff}
.ed.featured .ed-sub,.ed.featured li{color:#B9CBDA}
.ed-tag{font-family:'IBM Plex Mono';font-size:.64rem;letter-spacing:.14em;text-transform:uppercase;color:var(--teal-bright)}
.ed.featured .ed-tag{color:var(--amber)}
.ed h3{font-family:'Archivo';font-size:1.6rem;font-weight:800;margin:8px 0 6px}
.ed-sub{font-size:.9rem;color:var(--ink-soft);line-height:1.55;min-height:3.1em}
.price{font-family:'Archivo';font-size:2.1rem;font-weight:800;margin:20px 0 2px;letter-spacing:-.02em}
.price small{font-family:'IBM Plex Mono';font-size:.72rem;font-weight:400;letter-spacing:.04em;opacity:.7}
.ed ul{list-style:none;margin:20px 0 0;padding:0;flex:1}
.ed li{font-size:.9rem;padding:9px 0 9px 24px;position:relative;border-top:1px solid var(--mist)}
.ed.featured li{border-top-color:rgba(255,255,255,.1)}
.ed li:first-child{border-top:0}
.ed li:before{content:"";position:absolute;left:2px;top:15px;width:11px;height:6px;
  border-left:2px solid var(--teal-bright);border-bottom:2px solid var(--teal-bright);transform:rotate(-45deg)}
.ed .btn{margin-top:22px;text-align:center;display:block}
/* Scoped to page content. Redefining the bare .btn also restyled the nav's
   Console button, and the extra padding pushed the nav 2px past a 390px
   viewport - a horizontal scrollbar on every phone, from a rule meant for the
   pricing cards. */
.ed .btn,.form .btn{display:inline-block;font-weight:600;font-size:.9rem;padding:12px 20px;
  border-radius:var(--radius);text-decoration:none;background:var(--ink);color:#fff;
  border:1px solid var(--ink);cursor:pointer}
.ed .btn:hover,.form .btn:hover{background:#16283E}
.ed .btn-line{background:transparent;color:var(--ink);border-color:var(--mist)}
.ed .btn-line:hover{background:var(--porcelain)}
.ed.featured .btn{background:var(--amber);color:#0A1220;border-color:var(--amber)}
.ed.featured .btn:hover{background:#F0B055}

.compare{width:100%;border-collapse:collapse;margin:14px 0 30px;font-size:.88rem}
.compare th,.compare td{padding:11px 12px;border-bottom:1px solid var(--mist);text-align:left;vertical-align:top}
.compare th{font-family:'IBM Plex Mono';font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}
.compare td:first-child{font-weight:600}
.yes{color:var(--teal-bright);font-weight:700}
.no{color:var(--ink-soft);opacity:.6}

.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:26px 0 10px}
.step{border:1px solid var(--mist);border-radius:12px;padding:20px;background:var(--white)}
.step b{display:block;font-family:'Archivo';font-size:1rem;margin-bottom:6px}
.step span{font-size:.88rem;color:var(--ink-soft);line-height:1.55}
.step .n{font-family:'IBM Plex Mono';font-size:.66rem;color:var(--teal-bright);letter-spacing:.1em}

.form{border:1px solid var(--mist);border-radius:14px;padding:26px;background:var(--white);max-width:720px;margin:8px auto 0}
.frow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.field{margin-bottom:14px}
.field label{display:block;font-size:.78rem;font-weight:600;color:var(--ink-soft);margin-bottom:6px}
.field input,.field textarea,.field select{width:100%;padding:11px 12px;border:1px solid var(--mist);border-radius:9px;
  font:inherit;font-size:.9rem;background:var(--white);color:var(--ink)}
.field textarea{min-height:104px;resize:vertical}
.field input:focus,.field textarea:focus,.field select:focus{outline:2px solid var(--teal-bright);outline-offset:1px;border-color:transparent}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.formnote{font-family:'IBM Plex Mono';font-size:.66rem;color:var(--ink-soft);margin-top:12px}
.formmsg{margin-top:14px;padding:12px 14px;border-radius:9px;font-size:.88rem;display:none}
.formmsg.ok{display:block;background:rgba(46,158,143,.14);color:var(--teal)}
.formmsg.err{display:block;background:rgba(208,84,75,.14);color:#B0332A}

.faqs{max-width:760px;margin:0 auto}
.faq{border-top:1px solid var(--mist);padding:18px 0}
.faq b{display:block;font-size:.96rem;margin-bottom:6px}
.faq p{font-size:.9rem;color:var(--ink-soft);line-height:1.6}


/* ---------------------------------------------------------------------------
   Layered architecture diagram
   ---------------------------------------------------------------------------
   Built from HTML and CSS rather than a diagramming library. The site's CSP
   allows scripts from 'self' only, so a renderer would have to be vendored and
   shipped to every visitor to draw five boxes; and a real DOM stays readable
   to a screen reader, reflows on a phone, and follows the theme without a
   second palette.
   --------------------------------------------------------------------------- */
.arch{margin:28px 0 12px;display:flex;flex-direction:column;gap:10px}
.layer{border-radius:12px;padding:14px 16px;border:1px solid transparent}
.layer-h{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.layer-h b{font-family:'Archivo';font-size:.94rem;letter-spacing:.01em}
.layer-h span{font-family:'IBM Plex Mono';font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;opacity:.75}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border-radius:8px;padding:8px 11px;font-size:.82rem;line-height:1.35;border:1px solid transparent}
.chip i{display:block;font-style:normal;font-size:.7rem;opacity:.75;margin-top:2px}

.layer.l-ch{background:#EAF6FA;border-color:#9CD0E0}
.layer.l-ch .layer-h b,.layer.l-ch .layer-h span{color:#0B5A72}
.layer.l-ch .chip{background:#1E88A8;color:#fff}

.layer.l-vk{background:#FFF6E8;border-color:#E8A13D;border-width:2px}
.layer.l-vk .layer-h b,.layer.l-vk .layer-h span{color:#8A5A12}
.layer.l-vk .chip{background:#E8A13D;color:#231400}
.layer.l-vk .chip.gov{background:#2E9E8F;color:#04110F}

.layer.l-int{background:#F1EEFB;border-color:#B7ADE8}
.layer.l-int .layer-h b,.layer.l-int .layer-h span{color:#4B3E96}
.layer.l-int .chip{background:#7C6BD4;color:#fff}

.layer.l-org{background:#EEF2F6;border-color:#B9C9D6}
.layer.l-org .layer-h b,.layer.l-org .layer-h span{color:#0E1C2E}
.layer.l-org .chip{background:#0E1C2E;color:#E4EDF5}

.arrow{text-align:center;font-size:1.05rem;line-height:1;color:var(--ink-soft);opacity:.5}

:root[data-theme="dark"] .layer.l-ch{background:rgba(30,136,168,.12);border-color:#1E88A8}
:root[data-theme="dark"] .layer.l-ch .layer-h b,:root[data-theme="dark"] .layer.l-ch .layer-h span{color:#7FC8DE}
:root[data-theme="dark"] .layer.l-vk{background:rgba(232,161,61,.1)}
:root[data-theme="dark"] .layer.l-vk .layer-h b,:root[data-theme="dark"] .layer.l-vk .layer-h span{color:#F0B055}
:root[data-theme="dark"] .layer.l-int{background:rgba(124,107,212,.14);border-color:#7C6BD4}
:root[data-theme="dark"] .layer.l-int .layer-h b,:root[data-theme="dark"] .layer.l-int .layer-h span{color:#B7ADE8}
:root[data-theme="dark"] .layer.l-org{background:rgba(120,140,160,.1);border-color:#31445A}
:root[data-theme="dark"] .layer.l-org .layer-h b,:root[data-theme="dark"] .layer.l-org .layer-h span{color:#C6D5E2}
:root[data-theme="dark"] .layer.l-org .chip{background:#16283E;color:#E4EDF5}

.sector-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:30px 0}
.sector-card{border:1px solid var(--mist);border-radius:12px;padding:20px;background:var(--white);
  text-decoration:none;color:inherit;display:block}
.sector-card:hover{border-color:var(--teal-bright)}
.sector-card b{display:block;font-family:'Archivo';font-size:1.05rem;margin:6px 0 6px}
.sector-card span{font-size:.86rem;color:var(--ink-soft);line-height:1.5}
.sector-card em{font-style:normal;font-family:'IBM Plex Mono';font-size:.64rem;letter-spacing:.1em;
  text-transform:uppercase;color:var(--teal-bright)}

.note{border-left:3px solid var(--teal-bright);padding:10px 14px;background:rgba(46,158,143,.08);
  border-radius:0 9px 9px 0;font-size:.86rem;line-height:1.55;margin:18px 0}
.jrn{border-top:1px solid var(--mist);padding:16px 0}
.jrn b{display:block;font-size:.96rem;margin-bottom:5px}
.jrn p{font-size:.89rem;color:var(--ink-soft);line-height:1.6}

@media (max-width:860px){ .sector-grid{grid-template-columns:minmax(0,1fr)} }

@media (max-width:860px){
  .editions,.steps,.frow{grid-template-columns:minmax(0,1fr)}
  .mhero h1{font-size:2rem}
  .table-scroll{overflow-x:auto}
}
`;

function page(opts: {
  title: string;
  description: string;
  active: string;
  body: string;
  script?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
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
${SHELL_STYLE}
${PAGE_CSS}
</style>
</head>
<body>
${navFor(opts.active)}
${opts.body}
${SHELL_FOOTER}
${THEME_SCRIPT}
${opts.script ?? ''}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function pricingBody(): string {
  return `
<div class="wrap mhero">
  <div class="eyebrow">Editions</div>
  <h1>Start with the source. Buy the guarantees.</h1>
  <p>VoiceKernel Community is the whole control plane, open source and free to
  run in production, forever. Enterprise adds the things a company needs once
  the pilot works: a support contract, an SLA, and someone accountable.</p>
</div>

<div class="wrap">
  <div class="editions">
    <div class="ed">
      <div class="ed-tag">Community</div>
      <h3>Open source</h3>
      <div class="ed-sub">The complete control plane. Self-hosted, on your
      infrastructure, against your own provider account and keys.</div>
      <div class="price">Free <small>MIT licensed</small></div>
      <ul>
        <li>Every feature in this repository, no gated modules</li>
        <li>Multi-tenant isolation and the ownership registry</li>
        <li>Full provider surface, providers swappable per agent</li>
        <li>Browser test calls, live console, audit log</li>
        <li>Right-to-erasure, signed webhooks, scoped API keys</li>
        <li>Community support through GitHub issues</li>
        <li>Production use with no seat, call or minute limit</li>
      </ul>
      <a class="btn btn-line" href="https://github.com/VoiceKernel-ai/VoiceKernel.ai">Get the source</a>
    </div>

    <div class="ed featured">
      <div class="ed-tag">Enterprise</div>
      <h3>Licensed &amp; supported</h3>
      <div class="ed-sub">Everything in Community, plus the contract, response
      times and accountability that a procurement review asks for.</div>
      <div class="price">Talk to us <small>annual, invoiced</small></div>
      <ul>
        <li>Written SLA on uptime and support response</li>
        <li>Named engineer, 24/7 on-call bridge for severity one</li>
        <li>Security review support, DPAs, audit rights</li>
        <li>Deployment help: VPC, on-prem, region-locked residency</li>
        <li>Private builds and long-term support branches</li>
        <li>Upgrade and migration assistance</li>
        <li>Indemnity and contractual commitments</li>
      </ul>
      <a class="btn" href="#contact">Talk to us</a>
    </div>
  </div>

  <h2 style="font-family:'Archivo';font-size:1.3rem;margin:36px 0 4px">What differs</h2>
  <p style="font-size:.9rem;color:var(--ink-soft);margin-bottom:8px">
    The software is the same. What you buy is the commitment around it.</p>

  <div class="table-scroll">
  <table class="compare">
    <thead><tr><th>&nbsp;</th><th>Community</th><th>Enterprise</th></tr></thead>
    <tbody>
      <tr><td>Source code</td><td class="yes">Complete</td><td class="yes">Complete</td></tr>
      <tr><td>Features</td><td class="yes">All of them</td><td class="yes">All of them</td></tr>
      <tr><td>Production use</td><td class="yes">Unlimited</td><td class="yes">Unlimited</td></tr>
      <tr><td>Support</td><td>GitHub issues, best effort</td><td class="yes">Contracted, with response times</td></tr>
      <tr><td>Uptime SLA</td><td class="no">None</td><td class="yes">Written and measured</td></tr>
      <tr><td>Security review</td><td>Self-serve, docs and source</td><td class="yes">We answer your questionnaire</td></tr>
      <tr><td>Deployment</td><td>Docs and compose files</td><td class="yes">Assisted, VPC and on-prem</td></tr>
      <tr><td>Upgrades</td><td>Self-managed</td><td class="yes">Assisted, LTS branches</td></tr>
      <tr><td>Contractual protection</td><td class="no">None, as-is</td><td class="yes">DPA, indemnity, audit rights</td></tr>
    </tbody>
  </table>
  </div>

  <p style="font-size:.86rem;color:var(--ink-soft);margin-bottom:34px">
    Provider costs are separate and go directly to whoever carries your calls.
    VoiceKernel never resells minutes, so there is no margin for us in your
    call volume and no reason for us to make switching providers difficult.</p>

  <div class="eyebrow" id="contact">Getting started</div>
  <h2 style="font-family:'Archivo';font-size:1.3rem;margin:0 0 12px">How this usually goes</h2>
  <div class="steps">
    <div class="step"><span class="n">01</span><b>Run Community</b>
      <span>Clone it, point it at your provider account, put a real queue
      through it. No conversation with us required.</span></div>
    <div class="step"><span class="n">02</span><b>Prove it internally</b>
      <span>Show your security and compliance teams the source, the audit log
      and the isolation model. They will have questions; the answers are in
      the repository.</span></div>
    <div class="step"><span class="n">03</span><b>Buy the guarantees</b>
      <span>When it is carrying real volume and needs an SLA behind it, talk to
      us. Nothing about your deployment has to change.</span></div>
  </div>

  <div class="faqs" style="margin-top:44px">
    <div class="faq"><b>Is Community a trial?</b>
      <p>No. It is the same software, MIT licensed, with no expiry, no usage
      ceiling and no feature gates. If you never contact us, nothing stops
      working.</p></div>
    <div class="faq"><b>What exactly is licensed in Enterprise?</b>
      <p>The support relationship and the contractual commitments, not access to
      the code. You are buying response times, accountability and the paperwork
      procurement needs.</p></div>
    <div class="faq"><b>Can we start on Community and move later?</b>
      <p>That is the intended path, and the reason it is not crippled. Moving is
      a contract, not a migration.</p></div>
    <div class="faq"><b>Do you take a cut of our call spend?</b>
      <p>No. You hold the provider account and pay your provider directly.</p></div>
    <div class="faq"><b>We are a systems integrator, not an end user.</b>
      <p>See the <a href="/partners">partner programme</a>.</p></div>
  </div>
</div>
`;
}

// ---------------------------------------------------------------------------
// Partners
// ---------------------------------------------------------------------------

function partnersBody(): string {
  return `
<div class="wrap mhero">
  <div class="eyebrow">Integration partners</div>
  <h1>Build voice on infrastructure you can read</h1>
  <p>VoiceKernel is open source, so you can deploy it for a client, audit it
  line by line, extend it, and never explain to their security team why a black
  box holds their call recordings. We are looking for integrators who want to
  do exactly that.</p>
</div>

<div class="wrap">
  <div class="steps">
    <div class="step"><span class="n">Why</span><b>No platform risk to pass on</b>
      <span>Your client owns the deployment, the provider account and the keys.
      If we disappear, their system keeps running. That is a much easier
      sentence to say in a procurement meeting.</span></div>
    <div class="step"><span class="n">Why</span><b>Extend it properly</b>
      <span>Providers, tools and integrations are pluggable, and the whole
      upstream surface is reachable. Where the facade stops, the passthrough
      keeps going.</span></div>
    <div class="step"><span class="n">Why</span><b>Keep the relationship</b>
      <span>We do not sell minutes and we are not trying to land your client
      directly. You hold the engagement; we back you up on the platform.</span></div>
  </div>

  <h2 style="font-family:'Archivo';font-size:1.3rem;margin:40px 0 4px">What partners get</h2>
  <div class="table-scroll">
  <table class="compare">
    <thead><tr><th>&nbsp;</th><th>Included</th></tr></thead>
    <tbody>
      <tr><td>Technical enablement</td><td>Architecture sessions, deployment review, a direct channel to the maintainers</td></tr>
      <tr><td>Pre-release access</td><td>Early builds and roadmap visibility, so you are not surprised mid-project</td></tr>
      <tr><td>Enterprise licensing</td><td>Partner terms when your client needs an SLA, sold through you or alongside you</td></tr>
      <tr><td>Listing</td><td>A place on this page once you have delivered a deployment</td></tr>
      <tr><td>Co-delivery</td><td>We join client calls when the questions are about the platform, not your work</td></tr>
    </tbody>
  </table>
  </div>

  <h2 style="font-family:'Archivo';font-size:1.3rem;margin:36px 0 4px">What we ask</h2>
  <p style="font-size:.9rem;color:var(--ink-soft);max-width:70ch;margin-bottom:30px">
    That you have actually run it before you sell it - one real deployment, with
    real calls. That you contribute the fixes you make, because the next
    integrator will hit the same thing. And that you are straight with clients
    about what is Community and what needs a contract.</p>

  <div class="eyebrow">Apply</div>
  <h2 style="font-family:'Archivo';font-size:1.3rem;margin:0 0 4px">Become an integration partner</h2>
  <p style="font-size:.9rem;color:var(--ink-soft);margin-bottom:16px">
    A person reads every one of these. Expect a reply within a few working days.</p>

  <form class="form" id="partnerForm" novalidate>
    <div class="frow">
      <div class="field"><label for="company">Company *</label>
        <input id="company" name="company" required maxlength="200" autocomplete="organization"></div>
      <div class="field"><label for="website">Website</label>
        <input id="website" name="website" maxlength="300" placeholder="https://" autocomplete="url"></div>
    </div>
    <div class="frow">
      <div class="field"><label for="contactName">Your name *</label>
        <input id="contactName" name="contactName" required maxlength="200" autocomplete="name"></div>
      <div class="field"><label for="contactEmail">Work email *</label>
        <input id="contactEmail" name="contactEmail" type="email" required maxlength="320" autocomplete="email"></div>
    </div>
    <div class="frow">
      <div class="field"><label for="country">Country</label>
        <input id="country" name="country" maxlength="100" autocomplete="country-name"></div>
      <div class="field"><label for="focus">Where you focus</label>
        <input id="focus" name="focus" maxlength="300" placeholder="Banking, health, public sector..."></div>
    </div>
    <div class="field"><label for="message">What are you building, and for whom?</label>
      <textarea id="message" name="message" maxlength="4000"></textarea></div>

    <div class="hp" aria-hidden="true">
      <label for="fax">Fax</label>
      <input id="fax" name="fax" tabindex="-1" autocomplete="off">
    </div>

    <button class="btn" type="submit" id="partnerSubmit">Send application</button>
    <div class="formnote">We use this to reply to you. Nothing else.</div>
    <div class="formmsg" id="partnerMsg" role="status"></div>
  </form>
</div>
`;
}

const PARTNER_SCRIPT = `<script>
(function () {
  var form = document.getElementById('partnerForm');
  if (!form) return;
  var btn = document.getElementById('partnerSubmit');
  var msg = document.getElementById('partnerMsg');

  function show(kind, text) {
    msg.className = 'formmsg ' + kind;
    msg.textContent = text;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var body = {};
    ['company','website','contactName','contactEmail','country','focus','message','fax']
      .forEach(function (k) {
        var el = document.getElementById(k);
        var v = el && el.value.trim();
        if (v) body[k] = v;
      });

    if (!body.company || !body.contactName || !body.contactEmail) {
      show('err', 'Company, your name and a work email are needed.');
      return;
    }

    btn.disabled = true;
    show('ok', 'Sending...');

    fetch('/partners/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          var err = res.d && res.d.error;
          // Field-level validation reads better than the envelope's summary.
          var detail = err && err.details && err.details[0] && err.details[0].message;
          throw new Error(detail || (err && err.message) || 'Something went wrong.');
        }
        form.reset();
        show('ok', (res.d && res.d.message) || 'Thanks - we have your application.');
      })
      .catch(function (e) {
        show('err', e.message);
        btn.disabled = false;
      });
  });
})();
</script>`;


// ---------------------------------------------------------------------------
// Case studies - one reference architecture per organisation type
// ---------------------------------------------------------------------------

type Sector = (typeof SECTORS)[number];

/**
 * The layered diagram.
 *
 * Only the bottom layer changes between sectors. That is the argument the page
 * is making - the voice layer is the same everywhere, and what differs is which
 * systems of record it reaches into - so the top three layers are shared
 * markup rather than six near-copies.
 */
function archDiagram(sector: Sector): string {
  const chip = (name: string, detail?: string, cls = '') =>
    `<div class="chip ${cls}">${esc(name)}${detail ? `<i>${esc(detail)}</i>` : ''}</div>`;

  return `
<div class="arch" role="img" aria-label="Layered architecture: channels, VoiceKernel, integration, and ${esc(sector.name)} systems of record">
  <div class="layer l-ch">
    <div class="layer-h"><b>Channels</b><span>where the conversation starts</span></div>
    <div class="chips">
      ${chip('Inbound numbers', 'published lines')}
      ${chip('SIP / contact centre', 'existing estate')}
      ${chip('Outbound', 'campaigns and callbacks')}
      ${chip('In-app', 'browser WebRTC')}
    </div>
  </div>
  <div class="arrow">&#9660;</div>

  <div class="layer l-vk">
    <div class="layer-h"><b>VoiceKernel</b><span>the agentic voice layer</span></div>
    <div class="chips">
      ${chip('Conversation', 'agent, voice, turn taking')}
      ${chip('Knowledge grounding', 'answers with citations')}
      ${chip('Tool calls', 'reads and writes back')}
      ${chip('Transfer', 'to a human, with context')}
      ${chip('Tenant isolation', 'ownership registry', 'gov')}
      ${chip('Audit and erasure', 'per call, per mutation', 'gov')}
    </div>
  </div>
  <div class="arrow">&#9660;</div>

  <div class="layer l-int">
    <div class="layer-h"><b>Integration</b><span>your boundary, your rules</span></div>
    <div class="chips">
      ${chip('REST + typed SDK', 'scoped API keys')}
      ${chip('Signed webhooks', 'retried, replayable')}
      ${chip('Live event stream', 'SSE')}
    </div>
  </div>
  <div class="arrow">&#9660;</div>

  <div class="layer l-org">
    <div class="layer-h"><b>${esc(sector.name)}</b><span>your systems of record</span></div>
    <div class="chips">
      ${sector.systems.map((sys) => chip(sys.name, sys.detail)).join('\n      ')}
    </div>
  </div>
</div>`;
}

function caseStudyBody(sector: Sector): string {
  return `
<div class="wrap mhero">
  <div class="eyebrow">${esc(sector.eyebrow)}</div>
  <h1>${esc(sector.headline)}</h1>
  <p>${esc(sector.intro)}</p>
</div>

<div class="wrap">
  <div class="note"><b>An illustrative reference architecture</b>, not a customer
  case study. No organisation is named and no deployment is described - this is
  what the layers look like for a ${esc(sector.name.toLowerCase())} organisation,
  so you can map it onto your own estate.</div>

  ${archDiagram(sector)}

  <p style="font-size:.86rem;color:var(--ink-soft);margin:6px 0 34px">
    Only the bottom layer is specific to ${esc(sector.name.toLowerCase())}. The
    three above it are identical in every deployment, which is the point: the
    voice layer does not need to know what industry it is in, only which systems
    it is allowed to reach and what it may say.</p>

  <h2 style="font-family:'Archivo';font-size:1.3rem;margin:0 0 2px">What the agent actually does</h2>
  <div style="margin-bottom:34px">
    ${sector.journeys.map((j) => `<div class="jrn"><b>${esc(j.title)}</b><p>${esc(j.detail)}</p></div>`).join('\n    ')}
  </div>

  <h2 style="font-family:'Archivo';font-size:1.3rem;margin:0 0 2px">What keeps it deployable</h2>
  <div style="margin-bottom:30px">
    ${sector.compliance.map((c) => `<div class="jrn"><b>${esc(c.title)}</b><p>${esc(c.detail)}</p></div>`).join('\n    ')}
  </div>

  <div class="note">${esc(sector.metric)}</div>

  <div class="steps" style="margin-top:34px">
    <div class="step"><span class="n">Next</span><b>Read the source</b>
      <span>Everything above is in the open-source Community edition. Nothing on
      this page needs a licence.</span></div>
    <div class="step"><span class="n">Next</span><b>Run it yourself</b>
      <span>Point it at your provider account and put one queue through it before
      you talk to anybody.</span></div>
    <div class="step"><span class="n">Next</span><b>Then buy the guarantees</b>
      <span>An <a href="/pricing">Enterprise</a> agreement adds the SLA and the
      support contract when it carries real volume.</span></div>
  </div>
</div>`;
}

function caseIndexBody(): string {
  return `
<div class="wrap mhero">
  <div class="eyebrow">Reference architectures</div>
  <h1>What this looks like in your organisation</h1>
  <p>An agentic voice layer means very little until you can see which of your own
  systems it would touch. These are illustrative architectures by organisation
  type - same voice layer, different systems of record.</p>
</div>

<div class="wrap">
  <div class="sector-grid">
    ${SECTORS.map((s) => `<a class="sector-card" href="/case-studies/${s.slug}">
      <em>${esc(s.eyebrow)}</em>
      <b>${esc(s.name)}</b>
      <span>${esc(s.headline)}</span>
    </a>`).join('\n    ')}
  </div>

  <div class="note">These describe how the layers fit together for a given kind of
  organisation. They are not customer testimonials, and none of them names or
  implies a real deployment.</div>
</div>`;
}

function main(): void {
  fs.mkdirSync(WEB_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(WEB_DIR, 'pricing.html'),
    page({
      title: 'Pricing - VoiceKernel',
      description:
        'VoiceKernel Community is open source and free to run in production. Enterprise adds a support contract, an SLA and contractual protection.',
      active: 'Pricing',
      body: pricingBody(),
    }),
  );
  console.log('  wrote web/pricing.html');

  fs.writeFileSync(
    path.join(WEB_DIR, 'partners.html'),
    page({
      title: 'Integration partners - VoiceKernel',
      description:
        'Deploy an open-source voice control plane for your clients. Technical enablement, pre-release access and partner licensing terms.',
      active: 'Partners',
      body: partnersBody(),
      script: PARTNER_SCRIPT,
    }),
  );
  console.log('  wrote web/partners.html');

  // Written as case-studies/index.html, not case-studies.html. With a
  // case-studies/ directory also present, the asset server resolves the
  // extensionless /case-studies to the directory and looks for an index -
  // the sibling .html file is never consulted, and the index 404s.
  const caseDir = path.join(WEB_DIR, 'case-studies');
  fs.mkdirSync(caseDir, { recursive: true });

  fs.writeFileSync(
    path.join(caseDir, 'index.html'),
    page({
      title: 'Reference architectures - VoiceKernel',
      description:
        'Illustrative layered architectures by organisation type: banking, insurance, superannuation, telco, government and health administration.',
      active: 'Case studies',
      body: caseIndexBody(),
    }),
  );
  console.log('  wrote web/case-studies/index.html');

  for (const sector of SECTORS) {
    fs.writeFileSync(
      path.join(caseDir, `${sector.slug}.html`),
      page({
        title: `${sector.name.replace(/&amp;/g, '&')} - VoiceKernel`,
        description: `An illustrative layered architecture for a ${sector.name.toLowerCase()} organisation: channels, the agentic voice layer, integration and systems of record.`,
        active: 'Case studies',
        body: caseStudyBody(sector),
      }),
    );
  }
  console.log(`  wrote web/case-studies/ (${SECTORS.length} pages)`);
}

main();
