/**
 * The pieces every VoiceKernel-authored page shares: design tokens, the nav,
 * the footer and the theme switch.
 *
 * Extracted so the docs page and the marketing pages cannot drift apart. They
 * did once already in this codebase - a second copy of the same CSS acquired
 * its own bugs, and the fix had to be applied twice before anyone noticed the
 * second copy existed.
 *
 * Pages imported from design exports are handled separately, in
 * scripts/build-web.ts. This file is only for pages we write ourselves.
 */

export const SHELL_STYLE = `:root{
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
}`;

export const SHELL_NAV = `<nav>
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
      <a href="/case-studies">Architectures</a>\n      <a href="/pricing">Pricing</a>\n      <a href="/partners">Partners</a>
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
</nav>`;

export const SHELL_FOOTER = `<footer>
  <div class="foot-inner">
    <span>© 2026 VoiceKernel · PayFar Global Ltd</span>
    <span><a href="/openapi.json">OpenAPI</a> · <a href="/app">Console</a> · <a href="/pricing">Pricing</a></span>
  </div>
</footer>`;

export const THEME_SCRIPT = `<script>
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
</script>`;

/**
 * Marks the current nav item, so a page does not have to hand-edit a copy of
 * the nav to highlight itself.
 */
export function navFor(active: string): string {
  return SHELL_NAV.replace(
    new RegExp(`(<a href="[^"]*"[^>]*?)(>${active}</a>)`),
    '$1 aria-current="page"$2',
  );
}
