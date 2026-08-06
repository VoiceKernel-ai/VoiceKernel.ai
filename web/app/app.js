/* ===========================================================================
   VoiceKernel Console
   ---------------------------------------------------------------------------
   No framework and no build step: the console is served straight from the API
   container, so a bundler would add a deployment dependency for a UI that is a
   few thousand lines. Views render to innerHTML from a small state object and
   re-render whole; there is no diffing to get subtly wrong.

   Session auth rides on httpOnly cookies set by /auth/login, so this file never
   touches a token. `credentials: 'same-origin'` on every request is what makes
   that work.
   =========================================================================== */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var state = {
    user: null,
    org: null,
    role: 'viewer',
    view: 'overview',
    catalog: null,
    counts: {},
    overview: null,
    calls: [],
    agents: [],
    editing: null,      // agent currently open in the editor
    inspecting: null,   // call currently open in the inspector
    number: null,       // phone number open in the detail view
    campaign: null,     // campaign draft in the builder
    latency: null,      // latency budget, shared by editor and monitoring
    settingsTab: 'general',
    editorTab: 'prompt',
    loading: false
  };

  var VIEWS = [
    'overview', 'calls', 'inspector', 'analytics', 'audit',
    'agents', 'editor', 'knowledge', 'actions', 'numbers', 'numberDetail', 'campaigns', 'campaignNew',
    'simulator', 'evals', 'voices', 'schemas',
    'webhooks', 'keys', 'api',
    'monitoring', 'access', 'providers', 'settings'
  ];

  var VIEW_TITLES = {
    overview: 'Overview', calls: 'Call log', inspector: 'Call inspector',
    analytics: 'Insights', audit: 'Compliance log', agents: 'Agents',
    editor: 'Agent editor', knowledge: 'Knowledge', actions: 'Actions',
    numbers: 'Numbers & trunks', numberDetail: 'Number detail', campaigns: 'Campaigns',
    campaignNew: 'New campaign',
    simulator: 'Simulator', evals: 'Evals', voices: 'Voices', schemas: 'Intel schemas',
    webhooks: 'Webhooks', keys: 'API keys', api: 'API explorer',
    monitoring: 'Monitoring', access: 'Access & keys', providers: 'Providers & routing',
    settings: 'Settings'
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function el(sel, root) { return (root || document).querySelector(sel); }
  function els(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /**
   * Escapes every value interpolated into markup. Agent prompts, call
   * transcripts and webhook error bodies are all attacker-influenced in a
   * multi-tenant product - none of it may reach innerHTML raw.
   */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtNum(n, digits) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits === undefined ? 0 : digits
    });
  }

  function fmtPct(v) {
    if (v === null || v === undefined) return '-';
    return (v * 100).toFixed(1) + '%';
  }

  function fmtMoney(v) {
    if (v === null || v === undefined) return '-';
    return '$' + Number(v).toFixed(2);
  }

  function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined) return '-';
    var s = Math.round(Number(seconds));
    var m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtDate(value) {
    if (!value) return '-';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function timeAgo(value) {
    if (!value) return '-';
    var diff = (Date.now() - new Date(value).getTime()) / 1000;
    if (diff < 60) return Math.max(0, Math.floor(diff)) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  // ---------------------------------------------------------------------------
  // API client
  // ---------------------------------------------------------------------------

  function ApiError(message, status, body) {
    this.message = message;
    this.status = status;
    this.body = body;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function api(path, options) {
    options = options || {};
    var init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: {}
    };

    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        init.body = options.body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
    }
    if (options.idempotencyKey) init.headers['Idempotency-Key'] = options.idempotencyKey;

    return fetch(path, init).then(function (res) {
      var contentType = res.headers.get('content-type') || '';
      var parse = contentType.indexOf('application/json') !== -1
        ? res.json().catch(function () { return null; })
        : res.text().catch(function () { return null; });

      return parse.then(function (body) {
        if (res.ok) return body;

        var message = (body && body.error && body.error.message)
          || (typeof body === 'string' && body)
          || ('Request failed with status ' + res.status);

        // A 401 anywhere means the session died; bounce to the gate rather than
        // letting every view render its own "unauthorised" error.
        if (res.status === 401 && path.indexOf('/auth/') !== 0) {
          showAuth();
        }
        throw new ApiError(message, res.status, body);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------

  function toast(title, message, kind) {
    var node = document.createElement('div');
    node.className = 'toast' + (kind ? ' ' + kind : '');
    node.innerHTML = '<b>' + esc(title) + '</b>' + (message ? '<p>' + esc(message) + '</p>' : '');
    $('toasts').appendChild(node);
    setTimeout(function () {
      node.style.opacity = '0';
      setTimeout(function () { node.remove(); }, 250);
    }, kind === 'err' ? 7000 : 4000);
  }

  function fail(err) {
    toast(err && err.status === 403 ? 'Not permitted' : 'Something went wrong',
      err && err.message ? err.message : String(err), 'err');
  }

  // ---------------------------------------------------------------------------
  // Drawer
  // ---------------------------------------------------------------------------

  function openDrawer(title, bodyHtml, footHtml) {
    $('drawerTitle').textContent = title;
    $('drawerBody').innerHTML = bodyHtml;
    $('drawerFoot').innerHTML = footHtml || '';
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawerVeil').classList.add('open');
    var firstInput = el('input, textarea, select', $('drawerBody'));
    if (firstInput) firstInput.focus();
  }

  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('drawerVeil').classList.remove('open');
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  var authMode = 'login';

  function showAuth() {
    $('authVeil').style.display = 'flex';
    $('app').classList.add('hidden');
  }

  function hideAuth() {
    $('authVeil').style.display = 'none';
    $('app').classList.remove('hidden');
  }

  function setAuthMode(mode) {
    authMode = mode;
    var isSignup = mode === 'signup';
    $('authTitle').textContent = isSignup ? 'Create your organisation' : 'Sign in to the console';
    $('authLede').textContent = isSignup
      ? 'Spin up a VoiceKernel workspace and issue your first API key.'
      : 'Operate your voice agents, inspect calls, and manage integrations.';
    $('authSubmit').textContent = isSignup ? 'Create account' : 'Sign in';
    $('authNameField').hidden = !isSignup;
    $('authOrgField').hidden = !isSignup;
    $('authPwHint').hidden = !isSignup;
    $('authSwitchText').textContent = isSignup ? 'Already have an account?' : 'No account yet?';
    $('authSwitch').textContent = isSignup ? 'Sign in' : 'Create one';
    $('authPassword').setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
    $('authErr').classList.add('hidden');
  }

  function submitAuth(event) {
    event.preventDefault();
    var btn = $('authSubmit');
    var errBox = $('authErr');
    errBox.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = authMode === 'signup' ? 'Creating…' : 'Signing in…';

    var payload = {
      email: $('authEmail').value.trim(),
      password: $('authPassword').value
    };
    if (authMode === 'signup') {
      payload.name = $('authName').value.trim() || undefined;
      payload.organizationName = $('authOrg').value.trim() || undefined;
    }

    api('/auth/' + (authMode === 'signup' ? 'signup' : 'login'), { method: 'POST', body: payload })
      .then(function () {
        hideAuth();
        return boot();
      })
      .catch(function (err) {
        errBox.textContent = err.message || 'Could not sign in.';
        errBox.classList.remove('hidden');
      })
      .then(function () {
        btn.disabled = false;
        setAuthMode(authMode);
      });
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  function navigate(view, options) {
    if (VIEWS.indexOf(view) === -1) view = 'overview';
    state.view = view;

    VIEWS.forEach(function (name) {
      var node = $('view-' + name);
      if (node) node.classList.toggle('visible', name === view);
    });

    els('.nav-item').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-view') === view);
    });

    var title = VIEW_TITLES[view] || 'Console';
    $('crumb').innerHTML = '<b>' + esc(title) + '</b>';
    $('subnav').classList.toggle('hidden', view !== 'settings');

    // Deep links survive a refresh, which matters when someone pastes a call
    // link into an incident channel.
    if (!options || !options.silent) {
      var hash = '#' + view;
      if (view === 'editor' && state.editing) hash += '/' + state.editing.id;
      if (view === 'inspector' && state.inspecting) hash += '/' + state.inspecting.id;
      if (location.hash !== hash) history.replaceState(null, '', hash);
    }

    setSidebar(false);
    updatePrimaryAction();
    renderView(view);
  }

  function updatePrimaryAction() {
    var btn = $('primaryAction');
    var actions = {
      agents: '+ New agent', editor: 'Save agent', calls: '+ Place call',
      knowledge: '+ Upload document', actions: '+ New action',
      numbers: '+ Add number', numberDetail: 'Save number', campaigns: '+ New campaign',
      campaignNew: 'Run pre-flight',
      webhooks: '+ Add endpoint', keys: '+ Create key', access: '+ Create key',
      evals: '+ New suite', schemas: '+ New schema', simulator: 'Run simulation'
    };
    var label = actions[state.view];
    btn.textContent = label || '+ New agent';
    btn.classList.toggle('hidden', !label);
  }

  function primaryAction() {
    switch (state.view) {
      case 'editor': return saveAgent();
      case 'calls': return openPlaceCall();
      case 'knowledge': return openUpload();
      case 'actions': return openToolForm();
      case 'numbers': return openNumberForm();
      case 'campaigns': return openCampaignForm();
      case 'campaignNew': { var b = $('cpCheck'); if (b) b.click(); return; }
      case 'webhooks': return openWebhookForm();
      case 'keys': case 'access': return openKeyForm();
      case 'numberDetail': return saveNumber();
      case 'evals': return openEvalForm();
      case 'schemas': return openSchemaForm();
      case 'simulator': return runSimulation();
      default: return openAgentEditor(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  var RENDERERS = {};

  function renderView(view) {
    var node = $('view-' + view);
    if (!node) return;
    var renderer = RENDERERS[view];
    if (!renderer) {
      node.innerHTML = emptyState('Not available', 'This view is not implemented in this build.');
      return;
    }
    renderer(node);
  }

  function loading(node, label) {
    node.innerHTML = '<div class="empty"><span class="spinner"></span>' +
      '<p style="margin-top:12px">' + esc(label || 'Loading…') + '</p></div>';
  }

  function emptyState(title, body, actionLabel, actionId) {
    return '<div class="card"><div class="empty">' +
      '<h4>' + esc(title) + '</h4>' +
      '<p>' + esc(body) + '</p>' +
      (actionLabel ? '<button class="btn btn-amber" id="' + esc(actionId) + '">' + esc(actionLabel) + '</button>' : '') +
      '</div></div>';
  }

  // ---- Overview -------------------------------------------------------------

  RENDERERS.overview = function (node) {
    loading(node, 'Loading metrics…');

    Promise.all([
      api('/v1/analytics/overview'),
      api('/v1/analytics/timeseries?granularity=day'),
      api('/v1/calls?limit=8'),
      api('/v1/events?limit=8')
    ]).then(function (results) {
      var ov = results[0], ts = results[1], calls = results[2], events = results[3];
      state.overview = ov;
      state.counts = ov.resources || {};
      updateCounts();

      var series = ts.data || [];
      var peak = series.reduce(function (m, p) { return Math.max(m, p.calls); }, 1);

      node.innerHTML =
        '<div class="kpis">' +
          kpi('Calls · 30d', fmtNum(ov.calls.total), ov.calls.inProgress + ' in progress', 'flat') +
          kpi('Containment', fmtPct(ov.calls.containmentRate), 'resolved without transfer', 'up') +
          kpi('Minutes', fmtNum(ov.minutes.total, 1), 'avg ' + fmtNum(ov.minutes.average, 1) + ' min/call', 'flat') +
          kpi('P50 latency', ov.latency.p50 === null ? '-' : ov.latency.p50 + '<span style="font-size:.9rem;color:var(--txt-dim)">ms</span>',
              ov.latency.p95 === null ? 'no samples yet' : 'p95 ' + ov.latency.p95 + 'ms', 'flat') +
          kpi('Spend', fmtMoney(ov.cost.total), fmtMoney(ov.cost.perCall) + ' / call', 'flat') +
        '</div>' +

        '<div class="grid-2">' +
          '<div class="card">' +
            '<div class="card-head"><h3>Call volume</h3><span class="meta">last 30 days</span></div>' +
            '<div class="card-body">' +
              (series.length
                ? '<div class="chart">' + series.map(function (p) {
                    var h = Math.max(2, Math.round((p.calls / peak) * 100));
                    return '<div class="col" title="' + esc(p.bucket.slice(0, 10) + ' · ' + p.calls + ' calls') + '">' +
                      '<div class="seg-ai" style="height:' + h + '%"></div></div>';
                  }).join('') + '</div>' +
                  '<div class="chart-x">' + series.map(function (p, i) {
                    return '<span>' + (i % Math.ceil(series.length / 8) === 0 ? esc(p.bucket.slice(5, 10)) : '') + '</span>';
                  }).join('') + '</div>' +
                  '<div class="legend"><span><i style="background:var(--teal)"></i>Calls per day</span></div>'
                : '<div class="empty"><p>No calls yet. Place one from the Calls view, or point a phone number at an agent.</p></div>') +
            '</div>' +
          '</div>' +

          '<div class="card">' +
            '<div class="card-head"><h3>Recent events</h3><span class="meta">' + (events.data || []).length + '</span></div>' +
            '<div class="feed">' +
              ((events.data || []).length
                ? events.data.map(function (e) {
                    var kind = e.type.indexOf('ended') !== -1 ? 'teal'
                      : e.type.indexOf('tool') !== -1 ? 'amber' : 'teal';
                    return '<div class="feed-item">' +
                      '<div class="feed-ico ' + kind + '">●</div>' +
                      '<div><b>' + esc(e.type) + '</b>' +
                      '<p>' + esc(e.resource && e.resource.id ? e.resource.kind + ' ' + e.resource.id.slice(0, 18) : 'platform event') + '</p></div>' +
                      '<span class="t">' + esc(timeAgo(e.createdAt)) + '</span></div>';
                  }).join('')
                : '<div class="empty"><p>Events from your calls will appear here.</p></div>') +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><h3>Latest calls</h3>' +
            '<button class="btn btn-line btn-sm" data-go="calls">View all</button></div>' +
          callsTable(calls.data || []) +
        '</div>';

      wireCallRows(node);
      els('[data-go]', node).forEach(function (b) {
        b.addEventListener('click', function () { navigate(b.getAttribute('data-go')); });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load metrics', err.message);
    });
  };

  function kpi(label, value, delta, deltaClass) {
    return '<div class="kpi"><div class="label">' + esc(label) + '</div>' +
      '<div class="val">' + value + '</div>' +
      '<div class="delta ' + (deltaClass || 'flat') + '">' + esc(delta) + '</div></div>';
  }

  // ---- Calls ---------------------------------------------------------------

  function callsTable(calls) {
    if (!calls.length) {
      return '<div class="empty"><h4>No calls yet</h4>' +
        '<p>Place a call from the console, or point a phone number at one of your agents to start receiving them.</p></div>';
    }
    return '<table><thead><tr>' +
      '<th>Call</th><th>Agent</th><th>Direction</th><th>Status</th><th>Duration</th><th>Cost</th><th>Started</th>' +
      '</tr></thead><tbody>' +
      calls.map(function (c) {
        var cls = c.status === 'ended' ? 'wrap'
          : (c.status === 'in-progress' ? 'live' : (c.endedReason && /error|fail/i.test(c.endedReason) ? 'err' : 'esc'));
        return '<tr class="clickable" data-call="' + esc(c.id) + '">' +
          '<td><b>' + esc((c.customer && c.customer.number) || c.id.slice(0, 14)) + '</b>' +
            '<div class="mono" style="font-size:.62rem;color:var(--txt-dim)">' + esc(c.id.slice(0, 20)) + '</div></td>' +
          '<td>' + esc(agentNameFor(c.assistantId)) + '</td>' +
          '<td>' + esc(c.direction || c.type || '-') + '</td>' +
          '<td><span class="status ' + cls + '">' + esc(c.status || 'unknown') + '</span></td>' +
          '<td class="mono">' + esc(fmtDuration(c.durationSeconds)) + '</td>' +
          '<td class="mono">' + esc(c.cost === null ? '-' : fmtMoney(c.cost)) + '</td>' +
          '<td class="mono" style="font-size:.7rem">' + esc(fmtDate(c.startedAt || c.createdAt)) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>';
  }

  function agentNameFor(assistantId) {
    if (!assistantId) return '-';
    var match = state.agents.filter(function (a) { return a.id === assistantId; })[0];
    return match && match.name ? match.name : assistantId.slice(0, 12) + '…';
  }

  function wireCallRows(root) {
    els('[data-call]', root).forEach(function (row) {
      row.addEventListener('click', function () {
        openInspector(row.getAttribute('data-call'));
      });
    });
  }

  RENDERERS.calls = function (node) {
    loading(node, 'Loading calls…');

    api('/v1/calls?limit=100').then(function (res) {
      state.calls = res.data || [];
      node.innerHTML =
        '<div class="card">' +
          '<div class="card-head"><h3>Calls</h3>' +
            '<span class="meta">' + fmtNum(res.pagination && res.pagination.total) + ' total</span></div>' +
          callsTable(state.calls) +
        '</div>';
      wireCallRows(node);
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load calls', err.message);
    });
  };

  function openPlaceCall() {
    // An outbound call needs a number to dial *from*. The field used to be a
    // free-text "phone number ID" and optional, so the common path was to leave
    // it blank and get the provider's "Couldn't Get Phone Number" back. The
    // org's own numbers are known, so offer them and require one.
    api('/v1/phone-numbers').then(function (r) {
      renderPlaceCall((r && r.data) || []);
    }).catch(function () {
      renderPlaceCall([]);
    });
  }

  function renderPlaceCall(numbers) {
    // With no agents the select used to fall back to a placeholder whose value
    // was the empty string, which the form then posted as agentId. The API
    // answered "specify who should take the call" - correct, and useless: the
    // real problem is that this organisation has no agents to call with.
    var hasAgents = state.agents.length > 0;
    var hasNumbers = numbers.length > 0;
    var numberOptions = numbers.map(function (n) {
      return '<option value="' + esc(n.id) + '">' + esc(n.number || n.name || n.id) + '</option>';
    }).join('');
    var agentOptions = state.agents.map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.name || a.id) + '</option>';
    }).join('');

    openDrawer('Place an outbound call',
      (hasAgents ? '' :
        '<div class="notice warn">No agents exist yet, so there is nobody to place this call with. ' +
        'Create one under Agents first - and if creating one fails, add your provider key under ' +
        'Settings &rarr; Voice provider.</div>') +
      (hasNumbers ? '' :
        '<div class="notice warn">No phone numbers are attached to this organisation, so there is ' +
        'nothing to dial out from. Add or import one under Numbers &amp; trunks.</div>') +
      '<div class="field"><label for="pcTo">Destination number</label>' +
        '<input id="pcTo" placeholder="+61400000000">' +
        '<div class="hint">E.164 format, including country code.</div></div>' +
      '<div class="field"><label for="pcAgent">Agent</label>' +
        '<select id="pcAgent"' + (hasAgents ? '' : ' disabled') + '>' +
          (agentOptions || '<option value="">No agents yet</option>') + '</select></div>' +
      '<div class="field"><label for="pcNumber">Call from</label>' +
        '<select id="pcNumber"' + (hasNumbers ? '' : ' disabled') + '>' +
          (numberOptions || '<option value="">No numbers yet</option>') + '</select>' +
        '<div class="hint">The number the recipient sees. Manage these under Numbers &amp; trunks.</div></div>',
      '<button class="btn btn-line" data-close>Cancel</button>' +
      '<button class="btn btn-amber" id="pcSubmit"' +
        (hasAgents && hasNumbers ? '' : ' disabled') + '>Place call</button>');

    $('pcSubmit').addEventListener('click', function () {
      var agentId = $('pcAgent').value;
      var body = { to: $('pcTo').value.trim() };
      if (agentId) body.agentId = agentId;
      var from = $('pcNumber').value;
      if (from) body.phoneNumberId = from;
      if (!body.to) return toast('Destination required', 'Enter a number in E.164 format.', 'err');
      if (!body.agentId) return toast('Agent required', 'Pick the agent that should take this call.', 'err');
      if (!body.phoneNumberId) return toast('Number required', 'Pick the number to call from.', 'err');

      this.disabled = true;
      api('/v1/calls', { method: 'POST', body: body, idempotencyKey: 'call-' + Date.now() })
        .then(function () {
          closeDrawer();
          toast('Call placed', 'It will appear in the list once it connects.');
          navigate('calls');
        })
        .catch(function (err) { fail(err); $('pcSubmit').disabled = false; });
    });
  }

  // ---- Inspector -----------------------------------------------------------

  function openInspector(callId) {
    state.inspecting = { id: callId };
    navigate('inspector');
  }

  RENDERERS.inspector = function (node) {
    if (!state.inspecting) {
      node.innerHTML = emptyState('No call selected', 'Pick a call from the Calls view to inspect its transcript.');
      return;
    }
    loading(node, 'Loading call…');

    var id = state.inspecting.id;
    Promise.all([
      api('/v1/calls/' + encodeURIComponent(id)).catch(function () { return null; }),
      api('/v1/calls/' + encodeURIComponent(id) + '/transcript').catch(function () { return null; })
    ]).then(function (results) {
      var call = results[0] || {};
      var tr = results[1] || {};
      var messages = (tr.messages || []).filter(function (m) { return m.role !== 'system'; });

      node.innerHTML =
        '<div class="row" style="margin-bottom:14px">' +
          '<button class="btn btn-line btn-sm" data-go="calls">← Back to calls</button>' +
          '<span class="mono" style="font-size:.7rem;color:var(--txt-dim)">' + esc(id) + '</span>' +
        '</div>' +
        '<div class="insp">' +
          '<div class="card transcript-pane">' +
            '<div class="card-head"><h3>Transcript</h3>' +
              '<span class="meta">' + messages.length + ' turns</span></div>' +
            (messages.length
              ? messages.map(function (m) {
                  var role = m.role === 'bot' || m.role === 'assistant' ? 'agent' : 'caller';
                  return '<div class="tline">' +
                    '<span class="tag ' + role + '">' + esc(role === 'agent' ? 'Agent' : 'Caller') + '</span>' +
                    '<p>' + esc(m.message || m.content || '') + '</p>' +
                    (m.secondsFromStart !== undefined
                      ? '<span class="ts">' + esc(fmtDuration(m.secondsFromStart)) + '</span>' : '') +
                    '</div>';
                }).join('')
              : (tr.transcript
                  ? '<div class="tline"><p style="white-space:pre-wrap">' + esc(tr.transcript) + '</p></div>'
                  : '<div class="empty"><p>No transcript captured for this call yet.</p></div>')) +
          '</div>' +

          '<div class="insp-side">' +
            '<div class="card">' +
              '<div class="card-head"><h3>Call detail</h3></div>' +
              kvRow('Status', call.status || '-') +
              kvRow('Ended reason', call.endedReason || '-') +
              kvRow('Direction', call.direction || call.type || '-') +
              kvRow('Customer', (call.customer && call.customer.number) || '-') +
              kvRow('Agent', agentNameFor(call.assistantId)) +
              kvRow('Duration', fmtDuration(call.durationSeconds)) +
              kvRow('Cost', call.cost === null || call.cost === undefined ? '-' : fmtMoney(call.cost)) +
              kvRow('Started', fmtDate(call.startedAt)) +
              kvRow('Ended', fmtDate(call.endedAt)) +
            '</div>' +

            (tr.summary ? '<div class="card"><div class="card-head"><h3>Summary</h3></div>' +
              '<div class="card-body" style="font-size:.84rem;color:var(--txt-mid)">' + esc(tr.summary) + '</div></div>' : '') +

            '<div class="card">' +
              '<div class="card-head"><h3>Artifacts</h3></div>' +
              '<div class="card-body stack">' +
                '<button class="btn btn-line" data-artifact="recording">Get recording URL</button>' +
                '<button class="btn btn-line" data-artifact="logs">Get call logs</button>' +
                '<div id="artifactOut"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';

      els('[data-go]', node).forEach(function (b) {
        b.addEventListener('click', function () { navigate(b.getAttribute('data-go')); });
      });

      els('[data-artifact]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          var kind = b.getAttribute('data-artifact');
          b.disabled = true;
          api('/v1/calls/' + encodeURIComponent(id) + '/artifacts/' + kind)
            .then(function (out) {
              $('artifactOut').innerHTML = out && out.url
                ? '<div class="code">' + esc(out.url) + '</div>'
                : '<p class="muted" style="font-size:.78rem">No artifact available.</p>';
            })
            .catch(function (err) {
              $('artifactOut').innerHTML = '<p class="muted" style="font-size:.78rem">' + esc(err.message) + '</p>';
            })
            .then(function () { b.disabled = false; });
        });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load call', err.message);
    });
  };

  function kvRow(key, value) {
    return '<div class="kv"><span class="k">' + esc(key) + '</span>' +
      '<span class="v">' + esc(value) + '</span></div>';
  }

  // ---- Agents --------------------------------------------------------------

  RENDERERS.agents = function (node) {
    loading(node, 'Loading agents…');

    api('/v1/agents?limit=100').then(function (res) {
      state.agents = res.data || [];
      if (!state.agents.length) {
        node.innerHTML = emptyState(
          'No agents yet',
          'An agent is a prompt, a model, a voice and the tools it may call. Create one and place a test call in the same session.',
          '+ Create your first agent', 'firstAgent');
        var first = $('firstAgent');
        if (first) first.addEventListener('click', function () { openAgentEditor(null); });
        return;
      }

      node.innerHTML = '<div class="agents-grid">' + state.agents.map(function (a) {
        var model = a.model || {};
        var voice = a.voice || {};
        return '<button class="agent-card" data-agent="' + esc(a.id) + '">' +
          '<div class="top"><h3>' + esc(a.name || 'Untitled agent') + '</h3>' +
            '<span class="chip ' + (model.provider === 'anthropic' ? 'amber' : 'teal') + '">' +
              esc(model.provider || 'unset') + '</span></div>' +
          '<p class="desc">' + esc(a.systemPrompt || 'No prompt set.') + '</p>' +
          '<div class="stat-row">' +
            '<div class="stat"><div class="n">' + esc(shortModel(model.model)) + '</div><div class="l">Model</div></div>' +
            '<div class="stat"><div class="n">' + esc(voice.voiceId || voice.provider || '-') + '</div><div class="l">Voice</div></div>' +
            '<div class="stat"><div class="n">' + esc((model.toolIds || []).length) + '</div><div class="l">Actions</div></div>' +
          '</div></button>';
      }).join('') + '</div>';

      els('[data-agent]', node).forEach(function (card) {
        card.addEventListener('click', function () {
          var id = card.getAttribute('data-agent');
          var agent = state.agents.filter(function (a) { return a.id === id; })[0];
          openAgentEditor(agent);
        });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load agents', err.message);
    });
  };

  function shortModel(model) {
    if (!model) return '-';
    return String(model).replace(/-\d{8}$/, '').slice(0, 18);
  }

  // ---- Agent editor --------------------------------------------------------

  function openAgentEditor(agent) {
    state.editing = agent || {
      id: null,
      name: '',
      systemPrompt: '',
      firstMessage: '',
      model: { provider: 'openai', model: 'gpt-4o', temperature: 0.3 },
      voice: { provider: 'voicekernel', voiceId: 'Elliot' },
      transcriber: { provider: 'deepgram', model: 'nova-3' }
    };
    state.editorTab = 'prompt';
    navigate('editor');
  }

  RENDERERS.editor = function (node) {
    var a = state.editing;
    if (!a) {
      node.innerHTML = emptyState('No agent open', 'Pick an agent from the Agents view, or create a new one.');
      return;
    }
    // The catalog drives the provider pickers and the latency budget annotates
    // the pipeline; fetch both once, then render.
    if (!state.catalog || state.latency === null) {
      loading(node, 'Loading provider catalog…');
      return Promise.all([
        state.catalog ? state.catalog : api('/v1/catalog'),
        api('/v1/analytics/latency').catch(function () {
          return { sampleSize: 0, stages: [], totalP50: null, turnP50: null, slaMs: 600 };
        })
      ]).then(function (r) {
        state.catalog = r[0];
        state.latency = r[1];
        RENDERERS.editor(node);
      }).catch(function (err) {
        node.innerHTML = emptyState('Could not load catalog', err.message);
      });
    }

    var model = a.model || {};
    var voice = a.voice || {};
    var transcriber = a.transcriber || {};

    node.innerHTML =
      '<div class="deploy-strip">' +
        '<div class="stage done"><span class="dot"></span>Draft</div>' +
        '<div class="stage-arrow"></div>' +
        '<div class="stage ' + (a.id ? 'done' : '') + '"><span class="dot"></span>Saved</div>' +
        '<div class="stage-arrow"></div>' +
        '<div class="stage ' + (a.id ? 'live' : '') + '"><span class="dot"></span>' + (a.id ? 'Live' : 'Not deployed') + '</div>' +
        '<div class="deploy-meta">' +
          (a.id ? '<span>id <b>' + esc(a.id.slice(0, 18)) + '</b></span>' : '<span>unsaved</span>') +
          (a.updatedAt ? '<span>updated <b>' + esc(timeAgo(a.updatedAt)) + '</b></span>' : '') +
          // Only a saved agent can be called: the upstream needs an assistant
          // id, and offering the button on a draft would fail after the mic
          // permission prompt rather than before it.
          (a.id
            ? '<button class="btn btn-talk" id="agTalk" type="button">' + micIcon() + 'Talk</button>'
            : '<span class="talk-hint">Save the agent to talk to it</span>') +
        '</div>' +
      '</div>' +

      '<div class="editor-grid">' +
        '<div>' +
          '<div class="pipeline">' +
            pipeCard('TRANSCRIBER', transcriber.provider, transcriber.model, 'transcriber', 'transcriber') +
            pipeCard('REASONING', model.provider, model.model, 'model', 'model') +
            pipeCard('VOICE', voice.provider, voice.voiceId, 'voice', 'voice') +
          '</div>' +

          latencyBudgetCard() +

          '<div class="card" style="margin-bottom:14px">' +
            '<div class="tabs">' +
              tab('prompt', 'Behaviour') +
              tab('knowledge', 'Knowledge') +
              tab('guardrails', 'Guardrails') +
              tab('settings', 'Tuning') +
              tab('actions', 'Actions') +
              tab('advanced', 'Raw provider') +
            '</div>' +

            '<div class="tab-panel' + (state.editorTab === 'knowledge' ? ' on' : '') + '" data-panel="knowledge">' +
              '<div id="agKbPanel"><div class="empty"><span class="spinner"></span></div></div>' +
            '</div>' +

            '<div class="tab-panel' + (state.editorTab === 'guardrails' ? ' on' : '') + '" data-panel="guardrails">' +
              guardrailRows(a) +
            '</div>' +

            '<div class="tab-panel' + (state.editorTab === 'prompt' ? ' on' : '') + '" data-panel="prompt">' +
              '<div class="prompt-area">' +
                '<div class="field"><label for="agName">Agent name</label>' +
                  '<input id="agName" value="' + esc(a.name || '') + '" placeholder="Card disputes"></div>' +
                '<div class="field"><label for="agPrompt">System prompt</label>' +
                  '<textarea class="prompt" id="agPrompt" placeholder="You are a card disputes specialist…">' + esc(a.systemPrompt || '') + '</textarea>' +
                  '<div class="hint">This becomes the agent\'s instructions. Ground it in your policies and say what to do when unsure.</div></div>' +
                '<div class="field"><label for="agFirst">First message</label>' +
                  '<input id="agFirst" value="' + esc(a.firstMessage || '') + '" placeholder="Thanks for calling - how can I help?"></div>' +
              '</div>' +
            '</div>' +

            '<div class="tab-panel' + (state.editorTab === 'settings' ? ' on' : '') + '" data-panel="settings">' +
              '<div class="prompt-area">' +
                '<div class="field-row">' +
                  '<div class="field"><label for="agTemp">Temperature</label>' +
                    '<input id="agTemp" type="number" step="0.1" min="0" max="2" value="' + esc(model.temperature !== null && model.temperature !== undefined ? model.temperature : 0.3) + '"></div>' +
                  '<div class="field"><label for="agMaxTok">Max tokens</label>' +
                    '<input id="agMaxTok" type="number" min="1" value="' + esc(model.maxTokens || 250) + '"></div>' +
                '</div>' +
                '<div class="field-row">' +
                  '<div class="field"><label for="agSilence">Silence timeout (s)</label>' +
                    '<input id="agSilence" type="number" min="10" max="3600" value="' + esc((a.provider && a.provider.silenceTimeoutSeconds) || 30) + '"></div>' +
                  '<div class="field"><label for="agMaxDur">Max duration (s)</label>' +
                    '<input id="agMaxDur" type="number" min="10" max="43200" value="' + esc((a.provider && a.provider.maxDurationSeconds) || 1800) + '"></div>' +
                '</div>' +
                '<div class="field"><label for="agEndMsg">End-call message</label>' +
                  '<input id="agEndMsg" value="' + esc((a.provider && a.provider.endCallMessage) || '') + '" placeholder="Thanks for calling. Goodbye."></div>' +
                '<div class="guard-row" style="padding-left:0;padding-right:0">' +
                  '<button class="toggle' + (a.recordingEnabled !== false ? ' on' : '') + '" id="agRecording" aria-label="Recording"></button>' +
                  '<div class="body"><b>Call recording</b><p>Store audio for QA and dispute resolution. PCI redaction still applies in-stream.</p></div>' +
                '</div>' +
                '<div class="guard-row" style="padding-left:0;padding-right:0;border:none">' +
                  '<button class="toggle' + (a.hipaaEnabled ? ' on' : '') + '" id="agHipaa" aria-label="HIPAA"></button>' +
                  '<div class="body"><b>HIPAA mode</b><p>Disables transcript and recording retention on our side entirely.</p></div>' +
                '</div>' +
              '</div>' +
            '</div>' +

            '<div class="tab-panel' + (state.editorTab === 'actions' ? ' on' : '') + '" data-panel="actions">' +
              '<div class="prompt-area">' +
                '<div class="field"><label for="agTools">Attached action IDs</label>' +
                  '<input id="agTools" value="' + esc((model.toolIds || []).join(', ')) + '" placeholder="tool_abc, tool_def">' +
                  '<div class="hint">Comma separated. Create actions under Actions - they let the agent call into your systems mid-conversation.</div></div>' +
                '<div class="field"><label for="agKb">Knowledge base ID</label>' +
                  '<input id="agKb" value="' + esc(model.knowledgeBaseId || '') + '" placeholder="Optional"></div>' +
              '</div>' +
            '</div>' +

            '<div class="tab-panel' + (state.editorTab === 'advanced' ? ' on' : '') + '" data-panel="advanced">' +
              '<div class="prompt-area">' +
                '<div class="field"><label for="agRaw">Raw provider overrides (JSON)</label>' +
                  '<textarea class="prompt" id="agRaw" placeholder=\'{ "backgroundSound": "office" }\'></textarea>' +
                  '<div class="hint">Merged over the generated assistant. Use for any provider field the editor does not expose.</div></div>' +
                (a.provider ? '<div class="sec-label">Current upstream object</div><div class="code">' +
                  esc(JSON.stringify(a.provider, null, 2)) + '</div>' : '') +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="test-panel">' +
          '<div class="card"><div class="card-head"><h3>Test</h3></div>' +
            '<div class="card-body stack">' +
              '<button class="talk-btn" id="agTestCall">Place a test call</button>' +
              '<p class="muted" style="font-size:.76rem">Calls your number using this agent\'s saved configuration.</p>' +
            '</div>' +
          '</div>' +
          '<div class="card"><div class="card-head"><h3>Configuration</h3></div>' +
            kvRow('Model', (model.provider || '-') + ' / ' + (model.model || '-')) +
            kvRow('Voice', (voice.provider || '-') + ' / ' + (voice.voiceId || '-')) +
            kvRow('Transcriber', (transcriber.provider || '-') + ' / ' + (transcriber.model || '-')) +
            kvRow('Actions', (model.toolIds || []).length) +
            kvRow('Events to', a.server && a.server.url ? 'VoiceKernel' : 'default') +
          '</div>' +
          (a.id ? '<div class="card"><div class="card-head"><h3>Danger zone</h3></div>' +
            '<div class="card-body"><button class="btn btn-red" style="width:100%" id="agDelete">Delete agent</button></div></div>' : '') +
        '</div>' +
      '</div>';

    var talkBtn = $('agTalk');
    if (talkBtn) talkBtn.addEventListener('click', function () { toggleTalk(a); });

    // Tabs
    els('[data-tab]', node).forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.editorTab = btn.getAttribute('data-tab');
        els('[data-tab]', node).forEach(function (b) { b.classList.toggle('on', b === btn); });
        els('[data-panel]', node).forEach(function (p) {
          p.classList.toggle('on', p.getAttribute('data-panel') === state.editorTab);
        });
      });
    });

    // Provider pickers
    els('[data-pick]', node).forEach(function (btn) {
      btn.addEventListener('click', function () { openProviderPicker(btn.getAttribute('data-pick')); });
    });

    // Toggles
    els('.toggle', node).forEach(function (t) {
      t.addEventListener('click', function () { t.classList.toggle('on'); });
    });

    if ($('agDelete')) {
      $('agDelete').addEventListener('click', function () {
        if (!confirm('Delete "' + (a.name || a.id) + '"? Calls already placed are unaffected.')) return;
        api('/v1/agents/' + encodeURIComponent(a.id), { method: 'DELETE' })
          .then(function () {
            toast('Agent deleted');
            state.editing = null;
            navigate('agents');
          })
          .catch(fail);
      });
    }

    if ($('agTestCall')) {
      $('agTestCall').addEventListener('click', function () {
        if (!a.id) return toast('Save first', 'Save the agent before placing a test call.', 'warn');
        openPlaceCall();
      });
    }

    loadEditorKnowledge();
  };

  /** Documents available to ground this agent's answers. */
  function loadEditorKnowledge() {
    var panel = $('agKbPanel');
    if (!panel) return;

    api('/v1/files?limit=50').then(function (res) {
      var files = res.data || [];
      var attached = (state.editing.model && state.editing.model.knowledgeBaseId) || null;

      panel.innerHTML =
        (files.length
          ? files.map(function (f) {
              return '<div class="kb-row">' +
                '<span class="chip teal">READY</span>' +
                '<div style="min-width:0"><div class="nm">' + esc(f.name || f.originalName || f.id) + '</div>' +
                  '<div class="mono">' + esc(f.id) + '</div></div>' +
                '<div class="right">' +
                  '<span class="mono" style="font-size:.64rem;color:var(--txt-dim)">' +
                    esc(f.mimetype || f.type || '') + '</span>' +
                '</div></div>';
            }).join('')
          : '<div class="kb-row" style="color:var(--txt-dim)">No documents uploaded yet.</div>') +
        '<div class="prompt-area" style="border-top:1px solid var(--line-soft)">' +
          '<div class="field" style="margin-bottom:0"><label for="agKbId">Knowledge base ID</label>' +
            '<input id="agKbId" value="' + esc(attached || '') + '" placeholder="kb_…">' +
            '<div class="hint">Attach a knowledge base so answers carry a citation. Upload documents under Knowledge, then create a knowledge base from them.</div></div>' +
        '</div>';
    }).catch(function (err) {
      panel.innerHTML = '<div class="kb-row" style="color:var(--txt-dim)">' + esc(err.message) + '</div>';
    });
  }

  function tab(id, label) {
    return '<button class="tab' + (state.editorTab === id ? ' on' : '') + '" data-tab="' + id + '">' + esc(label) + '</button>';
  }

  /**
   * A pipeline stage card. The latency figure is this org's measured p50 for
   * that stage, not a vendor datasheet number - and reads "not measured" when
   * no call has produced one.
   */
  function pipeCard(role, provider, value, pick, stageKey) {
    var stage = null;
    if (state.latency && state.latency.stages) {
      stage = state.latency.stages.filter(function (s) { return s.stage === stageKey; })[0];
    }
    var block = (state.editing && state.editing[pick]) || {};
    var fallbackPlan = block.fallbackPlan || null;
    var fallbacks = fallbackPlan
      ? (fallbackPlan.voices || fallbackPlan.transcribers || [])
      : (block.fallbackModels || []);

    return '<div class="pipe-card">' +
      '<div class="role"><span>' + esc(role) + '</span>' +
        '<button data-pick="' + esc(pick) + '">CHANGE</button></div>' +
      '<h4>' + esc(value || 'not set') + '</h4>' +
      '<div class="prov">' + esc(provider || 'no provider') + '</div>' +
      '<div class="pipe-stats">' +
        '<span>p50 <b>' + (stage && stage.p50 !== null ? Math.round(stage.p50) + 'ms' : '-') + '</b></span>' +
        '<span>share <b>' + (stage && stage.share !== null ? fmtPct(stage.share) : '-') + '</b></span>' +
      '</div>' +
      '<div class="fallback">' +
        (fallbacks && fallbacks.length
          ? 'failover → <i>' + esc(describeFallbackEntry(fallbacks[0])) + '</i>'
          : '<span class="muted">no failover configured</span>') +
      '</div>' +
      '</div>';
  }

  function describeFallbackEntry(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      return (entry.provider || '') + (entry.model || entry.voiceId ? ' / ' + (entry.model || entry.voiceId) : '');
    }
    return 'configured';
  }

  /**
   * Voice-to-voice latency against the SLA, measured from this org's calls.
   *
   * Stage medians are not additive and turn latency includes network and VAD
   * overhead the stages exclude, so both totals are shown rather than
   * reconciled into one misleading number.
   */
  function latencyBudgetCard() {
    var l = state.latency;

    if (!l || l.sampleSize === 0) {
      return '<div class="card" style="margin-bottom:14px">' +
        '<div class="card-head"><h3>Latency budget · voice-to-voice</h3>' +
          '<span class="meta">no measurements yet</span></div>' +
        '<div class="card-body"><p class="muted" style="font-size:.79rem">' +
          'Latency is reported once calls have completed. Place a call with this agent and the ' +
          'per-stage breakdown will appear here.</p></div>' +
        '</div>';
    }

    var measured = l.stages.filter(function (s) { return s.p50 !== null; });
    var total = l.totalP50 || 1;
    var slaPct = Math.min(100, ((l.turnP50 || 0) / l.slaMs) * 100);
    var classes = { transcriber: 'stt', model: 'llm', voice: 'tts', endpointing: 'stt' };

    return '<div class="card" style="margin-bottom:14px">' +
      '<div class="card-head"><h3>Latency budget · voice-to-voice</h3>' +
        '<span class="meta">SLA ' + l.slaMs + 'ms · p50 across ' + l.sampleSize + ' measured calls</span></div>' +
      '<div class="card-body budget">' +
        '<div class="bar">' +
          measured.map(function (s) {
            var pct = ((s.p50 / total) * 100).toFixed(1);
            return '<div class="seg ' + (classes[s.stage] || 'stt') + '" style="width:' + pct + '%" ' +
              'title="' + esc(s.label + ' ' + Math.round(s.p50) + 'ms') + '">' +
              (Number(pct) > 12 ? esc(s.label.toUpperCase() + ' ' + Math.round(s.p50)) : '') + '</div>';
          }).join('') +
          '<div class="sla" style="left:' + slaPct.toFixed(1) + '%" title="p50 vs SLA"></div>' +
        '</div>' +
        '<div class="lab">' +
          '<span class="' + (l.withinSla ? 'ok' : '') + '">' +
            'turn p50 ' + (l.turnP50 === null ? '-' : Math.round(l.turnP50) + 'ms') +
            (l.headroomMs !== null
              ? ' · ' + Math.abs(l.headroomMs) + 'ms ' + (l.headroomMs >= 0 ? 'under' : 'over') + ' SLA'
              : '') +
          '</span>' +
          '<span>stage sum ' + Math.round(total) + 'ms · p95 ' +
            (l.turnP95 === null ? '-' : Math.round(l.turnP95) + 'ms') + '</span>' +
        '</div>' +
      '</div>' +
      '</div>';
  }

  /**
   * Guardrails that map to real provider fields.
   *
   * Deliberately limited to settings that actually change agent behaviour - * a toggle that looks authoritative but writes nothing would be worse than
   * having no toggle at all on a compliance screen.
   */
  function guardrailRows(a) {
    var compliance = (a.provider && a.provider.compliancePlan) || {};
    var artifact = (a.provider && a.provider.artifactPlan) || {};

    var rails = [
      {
        id: 'gdPci',
        on: compliance.pciEnabled === true,
        title: 'PCI redaction in-stream',
        body: 'Masks card numbers in audio and transcript before storage. Writes compliancePlan.pciEnabled.'
      },
      {
        id: 'gdHipaa',
        on: compliance.hipaaEnabled === true || a.hipaaEnabled === true,
        title: 'HIPAA storage mode',
        body: 'Stores logs, recordings and transcripts in HIPAA-compliant storage. Requires the add-on on your provider account.'
      },
      {
        id: 'gdRecording',
        on: artifact.recordingEnabled !== false && a.recordingEnabled !== false,
        title: 'Call recording',
        body: 'Retains audio for QA and dispute resolution. Redaction still applies in-stream.'
      }
    ];

    return '<div>' + rails.map(function (r) {
      return '<div class="guard-row">' +
        '<button class="toggle' + (r.on ? ' on' : '') + '" id="' + r.id + '" aria-label="' + esc(r.title) + '"></button>' +
        '<div class="body"><b style="font-size:.82rem">' + esc(r.title) + '</b>' +
          '<p>' + esc(r.body) + '</p></div>' +
        '<span class="chip ' + (r.on ? 'teal' : 'dim') + '">' + (r.on ? 'ON' : 'OFF') + '</span>' +
        '</div>';
    }).join('') +
    '<div class="guard-row" style="border:none">' +
      '<div class="body"><p class="muted">Behavioural rules - grounding requirements, vulnerability handoff, ' +
      'off-topic containment - are enforced through the agent prompt and its attached actions rather than a ' +
      'platform switch. Write them into the Behaviour tab and verify them with an eval suite.</p></div>' +
    '</div></div>';
  }

  /**
   * Provider picker. The option lists come from /v1/catalog, which is generated
   * from the provider's own OpenAPI spec - so what is offered here is exactly what the
   * upstream accepts, and a stale hard-coded list cannot drift into a 400 at
   * call time.
   */
  function openProviderPicker(kind) {
    var cat = state.catalog;
    var groups = { model: cat.models, voice: cat.voices, transcriber: cat.transcribers }[kind];
    var current = state.editing[kind] || {};
    var titles = { model: 'Choose a model', voice: 'Choose a voice', transcriber: 'Choose a transcriber' };
    var valueKey = kind === 'voice' ? 'voiceId' : 'model';

    openDrawer(titles[kind],
      '<div class="field"><label for="ppProvider">Provider</label>' +
        '<select id="ppProvider">' + groups.map(function (g) {
          return '<option value="' + esc(g.provider) + '"' +
            (g.provider === current.provider ? ' selected' : '') + '>' + esc(g.label) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="field"><label for="ppValue">' + (kind === 'voice' ? 'Voice' : 'Model') + '</label>' +
        '<select id="ppValue"></select>' +
        '<div class="hint" id="ppHint"></div></div>' +
      '<div class="field" id="ppCustomWrap" hidden><label for="ppCustom">Custom identifier</label>' +
        '<input id="ppCustom" placeholder="Provider-specific ID"></div>',
      '<button class="btn btn-line" data-close>Cancel</button>' +
      '<button class="btn btn-amber" id="ppApply">Apply</button>');

    function refreshValues() {
      var provider = $('ppProvider').value;
      var entry = groups.filter(function (g) { return g.provider === provider; })[0];
      var options = (entry && entry.options) || [];
      var freeform = entry && entry.freeform;

      $('ppValue').innerHTML = options.length
        ? options.map(function (o) {
            return '<option value="' + esc(o) + '"' +
              (o === current[valueKey] ? ' selected' : '') + '>' + esc(o) + '</option>';
          }).join('') + (freeform ? '<option value="__custom__">Custom…</option>' : '')
        : '<option value="__custom__">Custom…</option>';

      $('ppHint').textContent = options.length
        ? options.length + ' option(s) supported by this provider.'
        : 'This provider accepts any identifier.';
      toggleCustom();
    }

    function toggleCustom() {
      var isCustom = $('ppValue').value === '__custom__';
      $('ppCustomWrap').hidden = !isCustom;
      if (isCustom && !$('ppCustom').value) $('ppCustom').value = current[valueKey] || '';
    }

    $('ppProvider').addEventListener('change', refreshValues);
    $('ppValue').addEventListener('change', toggleCustom);
    refreshValues();

    $('ppApply').addEventListener('click', function () {
      var provider = $('ppProvider').value;
      var picked = $('ppValue').value;
      var value = picked === '__custom__' ? $('ppCustom').value.trim() : picked;

      var next = { provider: provider };
      if (value) next[valueKey] = value;
      // Temperature and similar tuning belongs to the model, not the picker.
      if (kind === 'model') {
        if (current.temperature !== undefined) next.temperature = current.temperature;
        if (current.maxTokens !== undefined) next.maxTokens = current.maxTokens;
        if (current.toolIds) next.toolIds = current.toolIds;
        if (current.knowledgeBaseId) next.knowledgeBaseId = current.knowledgeBaseId;
      }
      state.editing[kind] = next;
      closeDrawer();
      renderView('editor');
    });
  }

  function saveAgent() {
    var a = state.editing;
    if (!a) return;

    var name = $('agName') ? $('agName').value.trim() : a.name;
    var prompt = $('agPrompt') ? $('agPrompt').value : a.systemPrompt;
    if (!name) return toast('Name required', 'Give the agent a name.', 'err');
    if (!prompt) return toast('Prompt required', 'Describe what this agent should do.', 'err');

    var model = Object.assign({}, a.model || {});
    if ($('agTemp') && $('agTemp').value !== '') model.temperature = Number($('agTemp').value);
    if ($('agMaxTok') && $('agMaxTok').value !== '') model.maxTokens = Number($('agMaxTok').value);
    if ($('agTools')) {
      var ids = $('agTools').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      model.toolIds = ids;
    }
    // The knowledge base ID appears on two tabs; whichever is present wins.
    var kbInput = $('agKbId') || $('agKb');
    if (kbInput) {
      var kb = kbInput.value.trim();
      if (kb) model.knowledgeBaseId = kb; else delete model.knowledgeBaseId;
    }

    var body = {
      name: name,
      systemPrompt: prompt,
      firstMessage: $('agFirst') ? ($('agFirst').value || null) : a.firstMessage,
      model: model,
      voice: a.voice,
      transcriber: a.transcriber,
      recordingEnabled: $('agRecording')
        ? $('agRecording').classList.contains('on')
        : ($('gdRecording') ? $('gdRecording').classList.contains('on') : undefined),
      hipaaEnabled: $('agHipaa')
        ? $('agHipaa').classList.contains('on')
        : ($('gdHipaa') ? $('gdHipaa').classList.contains('on') : undefined)
    };

    // Guardrails write real provider fields. compliancePlan carries both flags, so
    // it is only sent when at least one toggle was actually rendered.
    if ($('gdPci') || $('gdHipaa')) {
      body.compliancePlan = {
        pciEnabled: $('gdPci') ? $('gdPci').classList.contains('on') : undefined,
        hipaaEnabled: $('gdHipaa') ? $('gdHipaa').classList.contains('on') : undefined
      };
      Object.keys(body.compliancePlan).forEach(function (k) {
        if (body.compliancePlan[k] === undefined) delete body.compliancePlan[k];
      });
    }

    if ($('agSilence') && $('agSilence').value) body.silenceTimeoutSeconds = Number($('agSilence').value);
    if ($('agMaxDur') && $('agMaxDur').value) body.maxDurationSeconds = Number($('agMaxDur').value);
    if ($('agEndMsg') && $('agEndMsg').value.trim()) body.endCallMessage = $('agEndMsg').value.trim();

    if ($('agRaw') && $('agRaw').value.trim()) {
      try {
        body.provider = JSON.parse($('agRaw').value);
      } catch (e) {
        return toast('Invalid JSON', 'The raw provider overrides are not valid JSON.', 'err');
      }
    }

    Object.keys(body).forEach(function (k) { if (body[k] === undefined) delete body[k]; });

    var btn = $('primaryAction');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    var request = a.id
      ? api('/v1/agents/' + encodeURIComponent(a.id), { method: 'PATCH', body: body })
      : api('/v1/agents', { method: 'POST', body: body });

    request.then(function (saved) {
      state.editing = saved;
      toast('Agent saved', saved.name || '');
      loadCounts();
      renderView('editor');
    }).catch(fail).then(function () {
      btn.disabled = false;
      updatePrimaryAction();
    });
  }

  // ---- Generic resource views ----------------------------------------------

  /**
   * Most Build-section views are the same shape: fetch a collection, render a
   * table, offer a create form. Sharing one renderer keeps them consistent and
   * means a fix to empty states or error handling lands everywhere at once.
   */
  function resourceView(config) {
    return function (node) {
      loading(node, 'Loading ' + config.plural + '…');

      api(config.endpoint + '?limit=100').then(function (res) {
        var items = res.data || [];
        if (!items.length) {
          node.innerHTML = emptyState(config.emptyTitle, config.emptyBody, config.createLabel, 'resCreate');
          var b = $('resCreate');
          if (b) b.addEventListener('click', config.onCreate);
          return;
        }
        node.innerHTML =
          '<div class="card">' +
            '<div class="card-head"><h3>' + esc(config.title) + '</h3>' +
              '<span class="meta">' + items.length + '</span></div>' +
            '<table><thead><tr>' + config.columns.map(function (c) {
              return '<th>' + esc(c.label) + '</th>';
            }).join('') + '<th></th></tr></thead><tbody>' +
            items.map(function (item) {
              return '<tr>' + config.columns.map(function (c) {
                return '<td>' + c.render(item) + '</td>';
              }).join('') +
              '<td style="text-align:right"><button class="btn btn-line btn-sm" data-del="' +
                esc(item.id) + '">Delete</button></td></tr>';
            }).join('') +
            '</tbody></table>' +
          '</div>';

        els('[data-del]', node).forEach(function (b) {
          b.addEventListener('click', function () {
            if (!confirm('Delete this ' + config.singular + '?')) return;
            api(config.endpoint + '/' + encodeURIComponent(b.getAttribute('data-del')), { method: 'DELETE' })
              .then(function () { toast('Deleted'); loadCounts(); renderView(state.view); })
              .catch(fail);
          });
        });
      }).catch(function (err) {
        node.innerHTML = emptyState('Could not load ' + config.plural, err.message);
      });
    };
  }

  RENDERERS.knowledge = resourceView({
    endpoint: '/v1/files', title: 'Knowledge documents', plural: 'documents', singular: 'document',
    emptyTitle: 'No documents yet',
    emptyBody: 'Upload the policies and product docs your agents should answer from. Every answer is then citable back to a source.',
    createLabel: '+ Upload a document',
    onCreate: function () { openUpload(); },
    columns: [
      { label: 'Name', render: function (f) { return '<b>' + esc(f.name || f.originalName || f.id) + '</b>'; } },
      { label: 'Type', render: function (f) { return esc(f.mimetype || f.type || '-'); } },
      { label: 'Size', render: function (f) { return '<span class="mono">' + esc(f.bytes ? Math.round(f.bytes / 1024) + ' KB' : '-') + '</span>'; } },
      { label: 'Created', render: function (f) { return '<span class="mono" style="font-size:.7rem">' + esc(fmtDate(f.createdAt)) + '</span>'; } }
    ]
  });

  /**
   * The action library: what this org has configured, then the full catalogue
   * of action types grouped the way the platform thinks about them - what
   * happens on the line, what reaches into the customer's systems, and what
   * connects a third party.
   */
  RENDERERS.actions = function (node) {
    loading(node, 'Loading actions…');

    Promise.all([
      api('/v1/tools?limit=100'),
      api('/v1/catalog/actions')
    ]).then(function (r) {
      var tools = r[0].data || [];
      var catalog = r[1];

      node.innerHTML =
        '<div class="sec-label">Configured · ' + tools.length + '</div>' +
        (tools.length
          ? '<div class="act-grid">' + tools.map(function (t) {
              var fn = t.function || {};
              return '<div class="act-card">' +
                '<div class="top"><h4>' + esc(fn.name || t.name || t.type || t.id) + '</h4>' +
                  '<span class="chip ' + (t.server && t.server.url ? 'amber' : 'dim') + '">' +
                  esc(t.type || 'function') + '</span></div>' +
                '<p>' + esc(fn.description || 'No description.') + '</p>' +
                '<div class="foot">' +
                  '<span>' + esc(t.id ? t.id.slice(0, 18) : '') + '</span>' +
                  '<span>' + (t.server && t.server.url ? '→ your server' : 'no server URL') + '</span>' +
                '</div></div>';
            }).join('') +
            '<button class="act-card" id="newTool" style="border-style:dashed;display:flex;align-items:center;' +
              'justify-content:center;min-height:120px;color:var(--txt-dim);background:none">+ New action</button>' +
            '</div>'
          : '<div class="card"><div class="empty">' +
            '<h4>No actions configured</h4>' +
            '<p>An action is a function your agent can call mid-conversation - look up an account, ' +
            'raise a dispute, book a callback. VoiceKernel forwards the call to your endpoint and hands ' +
            'the result back to the agent as its next sentence.</p>' +
            '<button class="btn btn-amber" id="newTool">+ Create an action</button>' +
            '</div></div>') +

        (catalog.groups || []).map(function (g) {
          return '<div class="sec-label">' + esc(g.group) + '</div>' +
            '<div class="act-grid">' + g.tools.map(function (t) {
              return '<div class="act-card">' +
                '<div class="top"><h4>' + esc(t.label) + '</h4>' +
                  '<span class="chip ' + (t.custom ? 'amber' : 'teal') + '">' +
                  (t.custom ? 'CUSTOM' : 'BUILT-IN') + '</span></div>' +
                '<p>' + esc(t.description || 'Supported action type.') + '</p>' +
                '<div class="foot"><span class="mono">' + esc(t.type) + '</span>' +
                  '<button class="btn btn-line btn-sm" data-addtool="' + esc(t.type) + '">Add</button></div>' +
                '</div>';
            }).join('') + '</div>';
        }).join('') +

        '<p class="mono" style="font-size:.64rem;color:var(--txt-dim);margin-top:14px">' +
          esc(catalog.total + ' action types supported. Custom actions call your endpoint with a signed request; ' +
          'built-ins are handled on the line by the platform.') + '</p>';

      var newTool = $('newTool');
      if (newTool) newTool.addEventListener('click', function () { openToolForm(); });

      els('[data-addtool]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          openToolForm(b.getAttribute('data-addtool'));
        });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load actions', err.message);
    });
  };

  function openToolForm(presetType) {
    // Built-in types are handled on the line and take no schema or endpoint;
    // creating one is a single call rather than a form the user must fill in.
    if (presetType && presetType !== 'function' && presetType !== 'apiRequest') {
      return api('/v1/tools', { method: 'POST', body: { type: presetType } })
        .then(function () { toast('Action added', presetType); loadCounts(); renderView('actions'); })
        .catch(fail);
    }

    openDrawer('New action',
      '<div class="field"><label for="tlName">Function name</label>' +
        '<input id="tlName" placeholder="lookup_account">' +
        '<div class="hint">Snake case. This is what the model calls.</div></div>' +
      '<div class="field"><label for="tlDesc">Description</label>' +
        '<input id="tlDesc" placeholder="Look up a customer account by reference number"></div>' +
      '<div class="field"><label for="tlUrl">Your endpoint URL</label>' +
        '<input id="tlUrl" placeholder="https://api.yourcompany.com/voicekernel/lookup">' +
        '<div class="hint">We POST the tool call here and return your JSON to the agent.</div></div>' +
      '<div class="field"><label for="tlParams">Parameters (JSON Schema)</label>' +
        '<textarea id="tlParams" style="min-height:150px;font-family:\'IBM Plex Mono\';font-size:.74rem">' +
        esc('{\n  "type": "object",\n  "properties": {\n    "reference": { "type": "string" }\n  },\n  "required": ["reference"]\n}') +
        '</textarea></div>',
      '<button class="btn btn-line" data-close>Cancel</button>' +
      '<button class="btn btn-amber" id="tlSubmit">Create action</button>');

    $('tlSubmit').addEventListener('click', function () {
      var params;
      try {
        params = JSON.parse($('tlParams').value);
      } catch (e) {
        return toast('Invalid JSON', 'The parameter schema is not valid JSON.', 'err');
      }
      var name = $('tlName').value.trim();
      if (!name) return toast('Name required', 'Give the function a name.', 'err');

      var body = {
        type: 'function',
        function: { name: name, description: $('tlDesc').value.trim(), parameters: params }
      };
      var url = $('tlUrl').value.trim();
      if (url) body.server = { url: url };

      this.disabled = true;
      api('/v1/tools', { method: 'POST', body: body })
        .then(function () { closeDrawer(); toast('Action created'); loadCounts(); renderView('actions'); })
        .catch(function (err) { fail(err); $('tlSubmit').disabled = false; });
    });
  }

  /**
   * Numbers get a bespoke renderer rather than the generic table because each
   * row opens a detail view - routing, event log and per-line health.
   */
  RENDERERS.numbers = function (node) {
    loading(node, 'Loading numbers…');

    api('/v1/phone-numbers?limit=100').then(function (res) {
      var numbers = res.data || [];
      if (!numbers.length) {
        node.innerHTML = emptyState(
          'No numbers yet',
          'Import a number from your carrier, or bring your own SIP trunk, then point it at an agent to start taking inbound calls.',
          '+ Add a number', 'firstNumber');
        var b = $('firstNumber');
        if (b) b.addEventListener('click', openNumberForm);
        return;
      }

      node.innerHTML =
        '<div class="card" style="margin-bottom:14px">' +
          '<div class="card-head"><h3>Numbers</h3>' +
            '<span class="meta">' + numbers.length + ' provisioned</span></div>' +
          '<table><thead><tr>' +
            '<th>Number</th><th>Label</th><th>Provider</th><th>Routes to</th><th>Calls · 24h</th><th></th>' +
          '</tr></thead><tbody>' +
          numbers.map(function (n) {
            return '<tr class="clickable" data-number="' + esc(n.id) + '">' +
              '<td class="mono" style="color:var(--txt)">' + esc(n.number || n.id.slice(0, 16)) + '</td>' +
              '<td>' + esc(n.name || '-') + '</td>' +
              '<td>' + esc(n.provider || '-') + '</td>' +
              '<td>' + (n.assistantId
                ? '<span class="chip amber">' + esc(agentNameFor(n.assistantId)) + '</span>'
                : '<span class="chip dim">unassigned</span>') + '</td>' +
              '<td class="mono" data-health="' + esc(n.id) + '">-</td>' +
              '<td style="text-align:right"><button class="btn btn-line btn-sm">Open ▸</button></td>' +
              '</tr>';
          }).join('') +
          '</tbody></table>' +
        '</div>';

      els('[data-number]', node).forEach(function (row) {
        row.addEventListener('click', function () {
          openNumberDetail(row.getAttribute('data-number'));
        });
      });

      // Health per row, fetched after the table paints so the list is not held
      // up by one aggregate per number.
      numbers.slice(0, 25).forEach(function (n) {
        api('/v1/phone-numbers/' + encodeURIComponent(n.id) + '/health').then(function (h) {
          var cell = el('[data-health="' + n.id.replace(/"/g, '') + '"]', node);
          if (cell) {
            cell.textContent = h.calls.total === 0 ? 'no traffic' : h.calls.total + ' calls';
          }
        }).catch(function () { /* health is supplementary */ });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load numbers', err.message);
    });
  };

  // ---------------------------------------------------------------------------
  // Number provisioning
  //
  // Each source needs different credentials - an imported Twilio number needs
  // that account's SID and token, a BYO SIP trunk needs a gateway and
  // credentials, a platform number needs neither. One flat form asking for all
  // of them would ask most people for fields they must leave blank, so the
  // source picks the fields.
  // ---------------------------------------------------------------------------

  var NUMBER_SOURCES = [
    {
      id: 'byo',
      label: 'Bring your own',
      hint: 'A number you already own',
      provider: 'byo-phone-number',
      blurb: 'Point a number you already control at VoiceKernel. Nothing is provisioned; you keep the carrier relationship.',
      fields: ['number', 'credentialId']
    },
    {
      id: 'twilio',
      label: 'Import Twilio',
      hint: 'Existing Twilio number',
      provider: 'twilio',
      blurb: 'Import a number from your Twilio account. Credentials are encrypted at rest and never logged.',
      fields: ['number', 'twilioSid', 'twilioToken']
    },
    {
      id: 'vonage',
      label: 'Import Vonage',
      hint: 'Existing Vonage number',
      provider: 'vonage',
      blurb: 'Import a number from your Vonage account.',
      fields: ['number', 'credentialId']
    },
    {
      id: 'telnyx',
      label: 'Import Telnyx',
      hint: 'Existing Telnyx number',
      provider: 'telnyx',
      blurb: 'Import a number from your Telnyx account.',
      fields: ['number', 'credentialId']
    },
    {
      id: 'sip',
      label: 'BYO SIP trunk',
      hint: 'Connect a trunk',
      provider: 'byo-sip-trunk',
      blurb: 'Terminate to your own SIP trunk - a PBX, a contact centre, or a carrier you already have a contract with.',
      fields: ['number', 'sipUri', 'credentialId']
    }
  ];

  var REGIONS = [
    { id: 'au-syd', label: 'Australia', sub: 'au-syd' },
    { id: 'eu-fra', label: 'Europe', sub: 'eu-fra' },
    { id: 'us-east', label: 'United States', sub: 'us-east' }
  ];

  function openNumberForm() {
    var source = NUMBER_SOURCES[0];
    var region = (state.org && state.org.region) || 'au-syd';

    var agentOptions = state.agents.map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.name || a.id) + '</option>';
    }).join('');

    function fieldsFor(src) {
      var f = {
        number:
          '<div class="field"><label for="pnNumber">Number (E.164)</label>' +
            '<input id="pnNumber" placeholder="+61280000000">' +
            '<div class="hint">Include the country code. Validated before anything is created.</div></div>',
        credentialId:
          '<div class="field"><label for="pnCred">Credential ID <span class="muted">(optional)</span></label>' +
            '<input id="pnCred" placeholder="Provider credential already stored on your account">' +
            '<div class="hint">Leave blank if this number needs no separate carrier credential.</div></div>',
        twilioSid:
          '<div class="field"><label for="pnSid">Twilio Account SID</label>' +
            '<input id="pnSid" placeholder="AC••••••••••••••••••••••••"></div>',
        twilioToken:
          '<div class="field"><label for="pnToken">Twilio Auth Token</label>' +
            '<input id="pnToken" type="password" placeholder="••••••••••••••••">' +
            '<div class="hint">Encrypted at rest and redacted from every log line.</div></div>',
        sipUri:
          '<div class="field"><label for="pnSip">SIP URI</label>' +
            '<input id="pnSip" placeholder="sip:queue@pbx.example.com"></div>'
      };
      return src.fields.map(function (name) { return f[name]; }).join('');
    }

    function render() {
      var veil = $('numberVeil');
      veil.innerHTML =
        '<div class="modal" role="dialog" aria-labelledby="pnTitle" aria-modal="true">' +
          '<div class="modal-side">' +
            '<h3 id="pnTitle">Add a number</h3>' +
            NUMBER_SOURCES.map(function (s) {
              return '<button class="msrc' + (s.id === source.id ? ' on' : '') + '" data-src="' + s.id + '">' +
                esc(s.label) + '<small>' + esc(s.hint) + '</small></button>';
            }).join('') +
          '</div>' +

          '<div class="modal-main">' +
            '<div class="modal-head">' +
              '<div><h4>' + esc(source.label) + '</h4><p>' + esc(source.blurb) + '</p></div>' +
              '<button class="x" id="pnClose" aria-label="Close">✕</button>' +
            '</div>' +

            '<div class="modal-body">' +
              '<div class="field"><label>Region</label>' +
                '<div class="regions">' + REGIONS.map(function (r) {
                  return '<button type="button" class="region' + (r.id === region ? ' on' : '') +
                    '" data-region="' + r.id + '">' + esc(r.label) +
                    ' <span class="mono" style="font-size:.7em;opacity:.7">' + esc(r.sub) + '</span></button>';
                }).join('') + '</div>' +
                '<div class="hint">Media and storage stay in this region. Defaults to your organisation\'s.</div></div>' +

              fieldsFor(source) +

              '<div class="field"><label for="pnLabel">Label</label>' +
                '<input id="pnLabel" placeholder="e.g. Disputes main"></div>' +

              '<div class="field"><label for="pnAgent">Route inbound calls to</label>' +
                '<select id="pnAgent"><option value="">No agent - handle via webhook</option>' + agentOptions + '</select>' +
                '<div class="hint">You can change this any time from the number\'s detail view.</div></div>' +

              '<div class="info"><span class="ic">i</span><p>' +
                '<b>Two-way from the first minute.</b> Every number answers inbound and can dial out. ' +
                'Events route to your webhook endpoints, signed and retried.</p></div>' +

              (source.id === 'byo' || source.id === 'sip'
                ? '<div class="info"><span class="ic">i</span><p><b>No number is purchased.</b> ' +
                  'VoiceKernel registers the number you already control - your carrier contract is unchanged.</p></div>'
                : '') +

              '<div id="pnError"></div>' +
            '</div>' +

            '<div class="modal-foot">' +
              '<span class="note">Credentials are encrypted at rest · never logged</span>' +
              '<button class="btn btn-line" id="pnCancel">Cancel</button>' +
              '<button class="btn btn-amber" id="pnSubmit">Add number</button>' +
            '</div>' +
          '</div>' +
        '</div>';

      veil.classList.add('open');

      els('[data-src]', veil).forEach(function (b) {
        b.addEventListener('click', function () {
          source = NUMBER_SOURCES.filter(function (s) { return s.id === b.getAttribute('data-src'); })[0];
          render();
        });
      });
      els('[data-region]', veil).forEach(function (b) {
        b.addEventListener('click', function () {
          region = b.getAttribute('data-region');
          els('[data-region]', veil).forEach(function (x) { x.classList.toggle('on', x === b); });
        });
      });

      $('pnClose').addEventListener('click', closeNumberForm);
      $('pnCancel').addEventListener('click', closeNumberForm);
      $('pnSubmit').addEventListener('click', submit);
    }

    function submit() {
      var number = $('pnNumber') ? $('pnNumber').value.replace(/[\s()-]/g, '') : '';
      var out = $('pnError');
      out.innerHTML = '';

      // Validate before calling out, so an obvious typo does not become an
      // opaque upstream rejection.
      if (!/^\+[1-9]\d{6,14}$/.test(number)) {
        out.innerHTML = '<div class="info warn"><span class="ic">!</span><p>' +
          '<b>That is not a valid E.164 number.</b> It must start with + and the country code, ' +
          'for example +61280000000.</p></div>';
        return;
      }

      var body = { provider: source.provider, number: number };
      var label = $('pnLabel').value.trim();
      if (label) body.name = label;
      var agent = $('pnAgent').value;
      if (agent) body.assistantId = agent;

      if ($('pnCred') && $('pnCred').value.trim()) body.credentialId = $('pnCred').value.trim();
      if ($('pnSid') && $('pnSid').value.trim()) body.twilioAccountSid = $('pnSid').value.trim();
      if ($('pnToken') && $('pnToken').value) body.twilioAuthToken = $('pnToken').value;
      if ($('pnSip') && $('pnSip').value.trim()) {
        body.credentialId = body.credentialId || undefined;
        body.numberE164CheckEnabled = false;
        body.sipUri = $('pnSip').value.trim();
      }

      var btn = $('pnSubmit');
      btn.disabled = true;
      btn.textContent = 'Adding…';

      api('/v1/phone-numbers', { method: 'POST', body: body, idempotencyKey: 'pn-' + number + '-' + Date.now() })
        .then(function (created) {
          closeNumberForm();
          toast('Number added', number);
          loadCounts();
          // Straight into the detail view: routing and health are what they
          // came to configure, and the list would only make them click again.
          if (created && created.id) openNumberDetail(created.id);
          else renderView('numbers');
        })
        .catch(function (err) {
          out.innerHTML = '<div class="info warn"><span class="ic">!</span><p><b>Could not add the number.</b> ' +
            esc(err.message) + '</p></div>';
          btn.disabled = false;
          btn.textContent = 'Add number';
        });
    }

    render();
  }

  function closeNumberForm() {
    var veil = $('numberVeil');
    if (veil) {
      veil.classList.remove('open');
      veil.innerHTML = '';
    }
  }

  RENDERERS.campaigns = resourceView({
    endpoint: '/v1/campaigns', title: 'Campaigns', plural: 'campaigns', singular: 'campaign',
    emptyTitle: 'No campaigns yet',
    emptyBody: 'A campaign dials a list with one agent, respecting your calling windows and consent rules.',
    createLabel: '+ New campaign',
    onCreate: function () { openCampaignForm(); },
    columns: [
      { label: 'Name', render: function (c) { return '<b>' + esc(c.name || c.id) + '</b>'; } },
      { label: 'Status', render: function (c) { return '<span class="status ' + (c.status === 'in-progress' ? 'live' : 'wrap') + '">' + esc(c.status || '-') + '</span>'; } },
      { label: 'Agent', render: function (c) { return esc(agentNameFor(c.assistantId)); } },
      { label: 'Created', render: function (c) { return '<span class="mono" style="font-size:.7rem">' + esc(fmtDate(c.createdAt)) + '</span>'; } }
    ]
  });

  /**
   * Campaign builder with a compliance pre-flight.
   *
   * Dialling a list is the one operation here that can produce a regulatory
   * breach at scale, so the checks run before launch and a hard failure blocks
   * the button. Checks that need an integration this deployment lacks report
   * "not available" rather than passing.
   */
  // ---------------------------------------------------------------------------
  // Campaign builder
  //
  // A full view rather than a drawer. Launching outbound is the one action here
  // that can produce a regulatory breach at scale, so the audience, the calling
  // window and the compliance pre-flight need to be visible together - not
  // stacked in a narrow panel where the failing check scrolls out of sight.
  //
  // Draft state lives in `state.campaign` so switching away to check an agent
  // does not discard a pasted list of several thousand numbers.
  // ---------------------------------------------------------------------------

  function blankCampaign() {
    return {
      name: '',
      agentId: '',
      phoneNumberId: '',
      numbers: [],
      rawList: '',
      windowStart: '09:00',
      windowEnd: '19:30',
      maxAttempts: 3,
      concurrency: 40,
      suppression: '',
      preflight: null,
      sourceLabel: ''
    };
  }

  function openCampaignForm() {
    state.campaign = state.campaign || blankCampaign();
    navigate('campaignNew');
  }

  RENDERERS.campaignNew = function (node) {
    var c = (state.campaign = state.campaign || blankCampaign());

    var agentOptions = state.agents.map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (a.id === c.agentId ? ' selected' : '') + '>' +
        esc(a.name || a.id) + '</option>';
    }).join('');

    var pf = c.preflight;
    var audienceDone = c.numbers.length > 0;
    var targetingDone = Boolean(c.agentId);

    node.innerHTML =
      '<div class="row" style="margin-bottom:14px;flex-wrap:wrap">' +
        '<button class="btn btn-line btn-sm" data-go="campaigns">← All campaigns</button>' +
        '<span class="mono" style="font-size:.72rem;color:var(--txt-dim)">draft</span>' +
      '</div>' +

      '<div class="wizard">' +
        '<div class="card">' +
          '<div class="card-head"><h3>New campaign</h3>' +
            '<span class="meta">nothing is dialled until pre-flight passes</span></div>' +

          '<div class="wstep ' + (c.name ? 'done' : 'active') + '">' +
            '<div class="wstep-n">' + (c.name ? '✓' : '1') + '</div>' +
            '<div class="body">' +
              '<h4>Name</h4>' +
              '<p>How this campaign appears in reporting and on every call record it creates.</p>' +
              '<input id="cpName" value="' + esc(c.name) + '" placeholder="Renewals - August">' +
            '</div>' +
          '</div>' +

          '<div class="wstep ' + (audienceDone ? 'done' : '') + '">' +
            '<div class="wstep-n">' + (audienceDone ? '✓' : '2') + '</div>' +
            '<div class="body">' +
              '<h4>Audience</h4>' +
              '<p>Upload a CSV or paste numbers. They are validated, deduplicated and washed against your suppression list before anything is dialled.</p>' +
              '<div class="dropzone' + (audienceDone ? ' filled' : '') + '" id="cpDrop">' +
                (audienceDone
                  ? '<b>' + fmtNum(c.numbers.length) + ' number' + (c.numbers.length === 1 ? '' : 's') + '</b>' +
                    (c.sourceLabel ? ' from ' + esc(c.sourceLabel) : '') + ' - click to replace'
                  : 'Drop a CSV here, or click to choose a file') +
              '</div>' +
              '<input type="file" id="cpFile" accept=".csv,.txt" style="display:none">' +
              '<div class="field" style="margin:12px 0 0"><label for="cpList">Or paste one number per line</label>' +
                '<textarea id="cpList" style="min-height:110px;font-family:\'IBM Plex Mono\';font-size:.74rem" ' +
                  'placeholder="+61400000001&#10;+61400000002">' + esc(c.rawList) + '</textarea></div>' +
              '<div class="field" style="margin:12px 0 0"><label for="cpSupp">Suppression list <span class="muted">(optional)</span></label>' +
                '<textarea id="cpSupp" style="min-height:60px;font-family:\'IBM Plex Mono\';font-size:.74rem" ' +
                  'placeholder="Numbers that have opted out">' + esc(c.suppression) + '</textarea>' +
                '<div class="hint">Anything here is removed from the audience and reported in the pre-flight.</div></div>' +
            '</div>' +
          '</div>' +

          '<div class="wstep ' + (targetingDone ? 'done' : '') + '">' +
            '<div class="wstep-n">' + (targetingDone ? '✓' : '3') + '</div>' +
            '<div class="body">' +
              '<h4>Agent &amp; number</h4>' +
              '<p>Who makes the call, and which line it comes from. The agent\'s opening line is what the disclosure check reads.</p>' +
              '<div class="field-row">' +
                '<div class="field"><label for="cpAgent">Agent</label>' +
                  '<select id="cpAgent"><option value="">Choose an agent</option>' + agentOptions + '</select></div>' +
                '<div class="field"><label for="cpNumber">From (phone number ID)</label>' +
                  '<input id="cpNumber" value="' + esc(c.phoneNumberId) + '" placeholder="pn_…"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="wstep">' +
            '<div class="wstep-n">4</div>' +
            '<div class="body">' +
              '<h4>Schedule &amp; pacing</h4>' +
              '<p>Calls are placed only inside this window. Concurrency and attempt caps protect number reputation and stay inside contact-frequency rules.</p>' +
              '<div class="field-row">' +
                '<div class="field"><label for="cpStart">Window opens</label>' +
                  '<input id="cpStart" value="' + esc(c.windowStart) + '" placeholder="09:00"></div>' +
                '<div class="field"><label for="cpEnd">Window closes</label>' +
                  '<input id="cpEnd" value="' + esc(c.windowEnd) + '" placeholder="19:30"></div>' +
              '</div>' +
              '<div class="field-row">' +
                '<div class="field"><label for="cpAttempts">Max attempts per customer</label>' +
                  '<input id="cpAttempts" type="number" min="1" max="10" value="' + esc(c.maxAttempts) + '"></div>' +
                '<div class="field"><label for="cpConc">Concurrent calls</label>' +
                  '<input id="cpConc" type="number" min="1" max="1000" value="' + esc(c.concurrency) + '"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div>' +
          '<div class="card" style="margin-bottom:12px">' +
            '<div class="card-head"><h3>Compliance pre-flight</h3>' +
              '<span class="meta">blocks launch on failure</span></div>' +
            '<div id="cpPreflight">' +
              (pf
                ? preflightMarkup(pf)
                : '<div class="empty"><p>Run pre-flight to validate the audience, calling window and disclosure before anything is dialled.</p></div>') +
            '</div>' +
            '<div style="padding:13px 16px;display:flex;gap:8px">' +
              '<button class="btn btn-line" id="cpCheck" style="flex:1">Run pre-flight</button>' +
              '<button class="btn ' + (pf && pf.canLaunch ? 'btn-amber' : 'btn-line') + '" id="cpLaunch" style="flex:1"' +
                (pf && pf.canLaunch ? '' : ' disabled') + '>Launch</button>' +
            '</div>' +
          '</div>' +

          (pf
            ? '<div class="card">' +
                '<div class="card-head"><h3>Projection</h3></div>' +
                kvRow('Callable customers', fmtNum(pf.audience.callable)) +
                kvRow('Estimated calls', fmtNum(pf.projection.estimatedCalls)) +
                kvRow('Estimated minutes', pf.projection.estimatedMinutes === null
                  ? 'not enough history' : fmtNum(pf.projection.estimatedMinutes, 1)) +
                kvRow('Estimated cost', pf.projection.estimatedCostRange
                  ? fmtMoney(pf.projection.estimatedCostRange[0]) + ' - ' + fmtMoney(pf.projection.estimatedCostRange[1])
                  : 'not enough history') +
                kvRow('Based on', pf.projection.basedOn) +
              '</div>'
            : '') +
        '</div>' +
      '</div>';

    // ---- wiring ------------------------------------------------------------

    els('[data-go]', node).forEach(function (b) {
      b.addEventListener('click', function () { navigate(b.getAttribute('data-go')); });
    });

    function capture() {
      c.name = $('cpName').value.trim();
      c.agentId = $('cpAgent').value;
      c.phoneNumberId = $('cpNumber').value.trim();
      c.rawList = $('cpList').value;
      c.suppression = $('cpSupp').value;
      c.windowStart = $('cpStart').value.trim();
      c.windowEnd = $('cpEnd').value.trim();
      c.maxAttempts = Number($('cpAttempts').value) || 1;
      c.concurrency = Number($('cpConc').value) || 10;

      // A pasted list wins over a previously uploaded file, since it is the
      // thing the operator most recently touched.
      var pasted = c.rawList.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      if (pasted.length) {
        c.numbers = pasted;
        c.sourceLabel = 'pasted list';
      }
      return c;
    }

    ['cpName', 'cpList', 'cpSupp', 'cpAgent', 'cpNumber', 'cpStart', 'cpEnd', 'cpAttempts', 'cpConc']
      .forEach(function (id) {
        var node2 = $(id);
        if (node2) node2.addEventListener('change', function () { capture(); });
      });

    $('cpDrop').addEventListener('click', function () { $('cpFile').click(); });
    $('cpFile').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        // Accepts a bare list or a CSV; takes the first column that looks like
        // a phone number so an exported CRM file works without reshaping.
        var rows = String(reader.result).split(/\r?\n/);
        var found = [];
        rows.forEach(function (row) {
          if (!row.trim()) return;
          var cells = row.split(/[,;\t]/);
          for (var i = 0; i < cells.length; i++) {
            var cell = cells[i].trim().replace(/^["']|["']$/g, '');
            if (/^\+?[\d\s()-]{7,}$/.test(cell)) { found.push(cell); break; }
          }
        });
        if (!found.length) {
          toast('No numbers found', 'That file had no column that looks like a phone number.', 'err');
          return;
        }
        c.numbers = found;
        c.rawList = '';
        c.sourceLabel = file.name;
        c.preflight = null;
        renderView('campaignNew');
        toast('Audience loaded', found.length + ' number(s) from ' + file.name);
      };
      reader.readAsText(file);
    });

    $('cpCheck').addEventListener('click', function () {
      capture();
      if (!c.numbers.length) return toast('No audience', 'Upload a file or paste numbers first.', 'err');

      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Checking…';
      $('cpPreflight').innerHTML = '<div class="empty"><span class="spinner"></span></div>';

      api('/v1/campaigns/preflight', {
        method: 'POST',
        body: {
          numbers: c.numbers,
          window: { start: c.windowStart, end: c.windowEnd },
          agentId: c.agentId || undefined,
          maxAttempts: c.maxAttempts,
          concurrency: c.concurrency,
          suppressionList: c.suppression.split('\n').map(function (s) { return s.trim(); }).filter(Boolean)
        }
      }).then(function (result) {
        c.preflight = result;
        renderView('campaignNew');
        toast(result.canLaunch ? 'Pre-flight passed' : 'Pre-flight failed',
          result.canLaunch ? 'Ready to launch.' : 'Resolve the failing checks first.',
          result.canLaunch ? undefined : 'err');
      }).catch(function (err) {
        fail(err);
        btn.disabled = false;
        btn.textContent = 'Run pre-flight';
      });
    });

    $('cpLaunch').addEventListener('click', function () {
      capture();
      if (!c.preflight || !c.preflight.canLaunch) return;
      if (!c.name) return toast('Name required', 'Name the campaign before launching.', 'err');
      if (!c.agentId) return toast('Agent required', 'Choose which agent makes these calls.', 'err');

      if (!confirm('Launch "' + c.name + '" to ' + c.preflight.audience.callable + ' customers?')) return;

      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Launching…';

      api('/v1/campaigns', {
        method: 'POST',
        idempotencyKey: 'campaign-' + c.name + '-' + c.preflight.audience.callable,
        body: {
          name: c.name,
          assistantId: c.agentId,
          phoneNumberId: c.phoneNumberId || undefined,
          customers: c.numbers
            .map(function (n) { return n.replace(/[\s()-]/g, ''); })
            .filter(function (n) { return /^\+[1-9]\d{6,14}$/.test(n); })
            .map(function (n) { return { number: n }; })
        }
      }).then(function () {
        toast('Campaign launched', c.name);
        state.campaign = null;
        loadCounts();
        navigate('campaigns');
      }).catch(function (err) {
        fail(err);
        btn.disabled = false;
        btn.textContent = 'Launch';
      });
    });
  };

  /** Pre-flight checks, with the enforcement state of each made explicit. */
  function preflightMarkup(pf) {
    var a = pf.audience;
    var icons = { pass: 'ok', warn: 'warn', fail: 'fail', not_available: 'na' };
    var marks = { pass: '✓', warn: '!', fail: '✕', not_available: '-' };

    return '<div class="audience-stats" style="margin:14px 16px">' +
        '<div class="aud"><div class="n">' + fmtNum(a.uploaded) + '</div><div class="l">Uploaded</div></div>' +
        '<div class="aud' + (a.invalid ? ' drop' : '') + '"><div class="n">' +
          (a.invalid ? '−' + a.invalid : '0') + '</div><div class="l">Invalid</div></div>' +
        '<div class="aud' + (a.duplicates ? ' drop' : '') + '"><div class="n">' +
          (a.duplicates ? '−' + a.duplicates : '0') + '</div><div class="l">Dupes</div></div>' +
        '<div class="aud' + (a.suppressed ? ' drop' : '') + '"><div class="n">' +
          (a.suppressed ? '−' + a.suppressed : '0') + '</div><div class="l">Suppressed</div></div>' +
        '<div class="aud"><div class="n">' + fmtNum(a.callable) + '</div><div class="l">Callable</div></div>' +
      '</div>' +
      pf.checks.map(function (check) {
        return '<div class="preflight-row">' +
          '<div class="pf-ico ' + (icons[check.status] || 'na') + '">' + (marks[check.status] || '-') + '</div>' +
          '<p><b>' + esc(check.label) + '</b> - ' + esc(check.detail) + '</p></div>';
      }).join('');
  }

  function openUpload() {
    openDrawer('Upload a document',
      '<div class="field"><label for="upFile">Document</label>' +
        '<input id="upFile" type="file" accept=".pdf,.txt,.md,.doc,.docx,.csv,.json">' +
        '<div class="hint">PDF, Word, Markdown, CSV or plain text. Up to 25 MB.</div></div>' +
      '<div class="field"><label for="upName">Display name</label>' +
        '<input id="upName" placeholder="Card Disputes Policy v3.2"></div>',
      '<button class="btn btn-line" data-close>Cancel</button>' +
      '<button class="btn btn-amber" id="upSubmit">Upload</button>');

    $('upSubmit').addEventListener('click', function () {
      var input = $('upFile');
      if (!input.files || !input.files[0]) return toast('No file', 'Choose a document to upload.', 'err');

      var form = new FormData();
      form.append('file', input.files[0]);
      var name = $('upName').value.trim();
      if (name) form.append('name', name);

      this.disabled = true;
      api('/v1/files', { method: 'POST', body: form })
        .then(function () { closeDrawer(); toast('Document uploaded'); loadCounts(); renderView('knowledge'); })
        .catch(function (err) { fail(err); $('upSubmit').disabled = false; });
    });
  }

  // ---- Webhooks ------------------------------------------------------------

  RENDERERS.webhooks = function (node) {
    loading(node, 'Loading endpoints…');

    api('/v1/webhook-endpoints').then(function (res) {
      var endpoints = res.data || [];
      node.innerHTML =
        '<div class="card" style="margin-bottom:14px">' +
          '<div class="card-head"><h3>Where your events go</h3>' +
            '<span class="meta">' + endpoints.length + ' endpoint(s)</span></div>' +
          (endpoints.length
            ? '<table><thead><tr><th>URL</th><th>Events</th><th>Status</th><th></th></tr></thead><tbody>' +
              endpoints.map(function (e) {
                return '<tr>' +
                  '<td><b>' + esc(e.url) + '</b>' +
                    (e.description ? '<div style="font-size:.72rem;color:var(--txt-dim)">' + esc(e.description) + '</div>' : '') + '</td>' +
                  '<td><span class="mono" style="font-size:.68rem">' + esc(e.events.join(', ')) + '</span></td>' +
                  '<td><span class="health ' + (e.enabled ? 'ok' : 'warn') + '">' + (e.enabled ? 'enabled' : 'disabled') + '</span></td>' +
                  '<td style="text-align:right;white-space:nowrap">' +
                    '<button class="btn btn-line btn-sm" data-test="' + esc(e.id) + '">Test</button> ' +
                    '<button class="btn btn-line btn-sm" data-secret="' + esc(e.id) + '">Secret</button> ' +
                    '<button class="btn btn-line btn-sm" data-delhook="' + esc(e.id) + '">Delete</button>' +
                  '</td></tr>';
              }).join('') + '</tbody></table>'
            : '<div class="empty"><h4>No endpoints yet</h4>' +
              '<p>Register a URL and VoiceKernel will POST every call event to it, signed and retried until you acknowledge.</p></div>') +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><h3>Recent deliveries</h3></div>' +
          '<div id="deliveries"><div class="empty"><p>Select an endpoint to see its delivery log.</p></div></div>' +
        '</div>' +

        '<div class="card" style="margin-top:14px">' +
          '<div class="card-head"><h3>Verifying signatures</h3></div>' +
          '<div class="card-body">' +
            '<p class="muted" style="font-size:.8rem;margin-bottom:10px">Every request carries <span class="mono">X-VoiceKernel-Signature</span>. Recompute it over the raw body and reject anything older than five minutes.</p>' +
            '<div class="code">' + esc(
              'const [t, v1] = header.split(\',\').map(p => p.split(\'=\')[1]);\n' +
              'const expected = crypto\n' +
              '  .createHmac(\'sha256\', process.env.VK_WEBHOOK_SECRET)\n' +
              '  .update(`${t}.${rawBody}`)\n' +
              '  .digest(\'hex\');\n\n' +
              'if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) {\n' +
              '  return res.status(401).end();\n' +
              '}\n' +
              'if (Math.abs(Date.now() / 1000 - Number(t)) > 300) {\n' +
              '  return res.status(401).end();  // replay\n' +
              '}'
            ) + '</div>' +
          '</div>' +
        '</div>';

      els('[data-test]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          b.disabled = true;
          api('/v1/webhook-endpoints/' + b.getAttribute('data-test') + '/test', { method: 'POST' })
            .then(function (out) {
              toast(out.delivered ? 'Test delivered' : 'Test failed',
                out.delivered ? 'Endpoint returned ' + out.responseStatus : (out.error || 'Status ' + out.responseStatus),
                out.delivered ? undefined : 'err');
            })
            .catch(fail).then(function () { b.disabled = false; });
        });
      });

      els('[data-secret]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          api('/v1/webhook-endpoints/' + b.getAttribute('data-secret') + '/secret')
            .then(function (out) {
              openDrawer('Signing secret',
                '<p class="muted" style="font-size:.8rem;margin-bottom:12px">Use this to verify the signature on every delivery.</p>' +
                '<div class="code">' + esc(out.secret) + '</div>',
                '<button class="btn btn-line" data-close>Close</button>');
            })
            .catch(fail);
        });
      });

      els('[data-delhook]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Delete this endpoint? Events will stop being delivered.')) return;
          api('/v1/webhook-endpoints/' + b.getAttribute('data-delhook'), { method: 'DELETE' })
            .then(function () { toast('Endpoint deleted'); renderView('webhooks'); })
            .catch(fail);
        });
      });

      if (endpoints.length) loadDeliveries(endpoints[0].id);
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load webhooks', err.message);
    });
  };

  function loadDeliveries(endpointId) {
    api('/v1/webhook-endpoints/' + endpointId + '/deliveries?limit=25').then(function (res) {
      var items = res.data || [];
      var box = $('deliveries');
      if (!box) return;
      box.innerHTML = items.length
        ? '<table><thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Response</th><th>When</th><th></th></tr></thead><tbody>' +
          items.map(function (d) {
            return '<tr>' +
              '<td><b>' + esc(d.eventType) + '</b></td>' +
              '<td><span class="health ' + (d.status === 'succeeded' ? 'ok' : d.status === 'dead' ? 'bad' : 'warn') + '">' + esc(d.status) + '</span></td>' +
              '<td class="mono">' + esc(d.attempts) + '</td>' +
              '<td class="mono">' + esc(d.responseStatus || d.error || '-') + '</td>' +
              '<td class="mono" style="font-size:.7rem">' + esc(timeAgo(d.createdAt)) + '</td>' +
              '<td style="text-align:right">' + (d.status !== 'succeeded'
                ? '<button class="btn btn-line btn-sm" data-replay="' + esc(d.id) + '">Replay</button>' : '') + '</td>' +
              '</tr>';
          }).join('') + '</tbody></table>'
        : '<div class="empty"><p>No deliveries yet.</p></div>';

      els('[data-replay]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          api('/v1/webhook-endpoints/deliveries/' + b.getAttribute('data-replay') + '/replay', { method: 'POST' })
            .then(function () { toast('Queued for replay'); loadDeliveries(endpointId); })
            .catch(fail);
        });
      });
    }).catch(function () { /* delivery log is supplementary */ });
  }

  function openWebhookForm() {
    var eventOptions = [
      'call.started', 'call.ended', 'call.transcript', 'call.status-update',
      'tool.called', 'agent.created', 'agent.updated', 'agent.deleted'
    ];

    openDrawer('Add a webhook endpoint',
      '<div class="field"><label for="whUrl">Endpoint URL</label>' +
        '<input id="whUrl" placeholder="https://crm.example.com/hooks/voicekernel">' +
        '<div class="hint">Must be https in production and respond 2xx within 10 seconds.</div></div>' +
      '<div class="field"><label for="whDesc">Description</label>' +
        '<input id="whDesc" placeholder="CRM ticket sync"></div>' +
      '<div class="field"><label>Events</label>' +
        '<div class="check-row"><input type="checkbox" id="whAll" checked>' +
          '<label for="whAll" style="margin:0">All events</label></div>' +
        '<div id="whEvents" style="display:none">' + eventOptions.map(function (e) {
          return '<div class="check-row"><input type="checkbox" value="' + esc(e) + '" class="whEvt">' +
            '<label style="margin:0">' + esc(e) + '</label></div>';
        }).join('') + '</div></div>',
      '<button class="btn btn-line" data-close>Cancel</button>' +
      '<button class="btn btn-amber" id="whSubmit">Add endpoint</button>');

    $('whAll').addEventListener('change', function () {
      $('whEvents').style.display = this.checked ? 'none' : 'block';
    });

    $('whSubmit').addEventListener('click', function () {
      var url = $('whUrl').value.trim();
      if (!url) return toast('URL required', 'Enter the endpoint URL.', 'err');

      var events = $('whAll').checked
        ? ['*']
        : els('.whEvt').filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
      if (!events.length) return toast('No events selected', 'Pick at least one event.', 'err');

      this.disabled = true;
      api('/v1/webhook-endpoints', {
        method: 'POST',
        body: { url: url, description: $('whDesc').value.trim() || undefined, events: events }
      }).then(function (created) {
        openDrawer('Endpoint created - save your secret',
          '<p class="muted" style="font-size:.8rem;margin-bottom:12px">This secret signs every delivery. It is shown here and retrievable later from the endpoint list.</p>' +
          '<div class="code">' + esc(created.secret) + '</div>' +
          '<div class="hint" style="margin-top:12px">' + esc(created.signatureFormat) + '</div>',
          '<button class="btn btn-amber" data-close>Done</button>');
        renderView('webhooks');
      }).catch(function (err) { fail(err); $('whSubmit').disabled = false; });
    });
  }

  // ---- API keys ------------------------------------------------------------

  RENDERERS.keys = function (node) {
    loading(node, 'Loading keys…');

    api('/v1/api-keys').then(function (res) {
      var keys = res.data || [];
      node.innerHTML =
        '<div class="card">' +
          '<div class="card-head"><h3>API keys</h3><span class="meta">' + keys.length + '</span></div>' +
          (keys.length
            ? '<table><thead><tr><th>Name</th><th>Key</th><th>Environment</th><th>Scopes</th><th>Last used</th><th></th></tr></thead><tbody>' +
              keys.map(function (k) {
                var revoked = Boolean(k.revokedAt);
                return '<tr style="' + (revoked ? 'opacity:.5' : '') + '">' +
                  '<td><b>' + esc(k.name) + '</b></td>' +
                  '<td><span class="mono" style="font-size:.68rem">' + esc(k.masked) + '</span></td>' +
                  '<td><span class="chip ' + (k.environment === 'live' ? 'teal' : 'dim') + '">' + esc(k.environment) + '</span></td>' +
                  '<td><span class="mono" style="font-size:.66rem">' + esc(k.scopes.join(', ')) + '</span></td>' +
                  '<td class="mono" style="font-size:.7rem">' + esc(k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never') + '</td>' +
                  '<td style="text-align:right">' + (revoked
                    ? '<span class="chip red">revoked</span>'
                    : '<button class="btn btn-line btn-sm" data-revoke="' + esc(k.id) + '">Revoke</button>') + '</td>' +
                  '</tr>';
              }).join('') + '</tbody></table>'
            : '<div class="empty"><h4>No API keys</h4><p>Create a key to call the VoiceKernel API from your own services.</p></div>') +
        '</div>' +

        '<div class="card" style="margin-top:14px">' +
          '<div class="card-head"><h3>Using your key</h3></div>' +
          '<div class="card-body"><div class="code">' + esc(
            'curl ' + location.origin + '/v1/agents \\\n' +
            '  -H "Authorization: Bearer vk_live_…"\n\n' +
            '# Place a call\n' +
            'curl -X POST ' + location.origin + '/v1/calls \\\n' +
            '  -H "Authorization: Bearer vk_live_…" \\\n' +
            '  -H "Content-Type: application/json" \\\n' +
            '  -H "Idempotency-Key: $(uuidgen)" \\\n' +
            '  -d \'{ "to": "+61400000000", "agentId": "asst_…" }\''
          ) + '</div></div>' +
        '</div>';

      els('[data-revoke]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Revoke this key? Any service using it will start receiving 401s immediately.')) return;
          api('/v1/api-keys/' + b.getAttribute('data-revoke'), { method: 'DELETE' })
            .then(function () { toast('Key revoked'); renderView('keys'); })
            .catch(fail);
        });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load keys', err.message);
    });
  };

  function openKeyForm() {
    openDrawer('Create an API key',
      '<div class="field"><label for="kyName">Name</label>' +
        '<input id="kyName" placeholder="Production - CRM integration"></div>' +
      '<div class="field"><label for="kyEnv">Environment</label>' +
        '<select id="kyEnv"><option value="live">Live</option><option value="test">Test</option></select></div>' +
      '<div class="field"><label for="kyScope">Scope</label>' +
        '<select id="kyScope">' +
          '<option value="*">Full access</option>' +
          '<option value="read">Read only</option>' +
          '<option value="calls">Calls only</option>' +
        '</select>' +
        '<div class="hint">Narrow scopes limit the blast radius if a key leaks.</div></div>',
      '<button class="btn btn-line" data-close>Cancel</button>' +
      '<button class="btn btn-amber" id="kySubmit">Create key</button>');

    $('kySubmit').addEventListener('click', function () {
      var name = $('kyName').value.trim();
      if (!name) return toast('Name required', 'Name the key so you can recognise it later.', 'err');

      var preset = $('kyScope').value;
      var scopes = preset === '*' ? ['*']
        : preset === 'read'
          ? ['agents:read', 'calls:read', 'analytics:read', 'webhooks:read']
          : ['calls:read', 'calls:write', 'agents:read'];

      this.disabled = true;
      api('/v1/api-keys', {
        method: 'POST',
        body: { name: name, environment: $('kyEnv').value, scopes: scopes }
      }).then(function (created) {
        openDrawer('Key created - copy it now',
          '<p class="muted" style="font-size:.8rem;margin-bottom:12px">' + esc(created.warning) + '</p>' +
          '<div class="code">' + esc(created.key) + '</div>',
          '<button class="btn btn-amber" data-close>Done</button>');
        renderView('keys');
      }).catch(function (err) { fail(err); $('kySubmit').disabled = false; });
    });
  }

  // ---- Analytics -----------------------------------------------------------

  RENDERERS.analytics = function (node) {
    loading(node, 'Loading analytics…');

    Promise.all([
      api('/v1/analytics/overview'),
      api('/v1/analytics/agents'),
      api('/v1/analytics/ended-reasons')
    ]).then(function (r) {
      var ov = r[0], agents = r[1].data || [], reasons = r[2].data || [];

      node.innerHTML =
        '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">' +
          kpi('Calls', fmtNum(ov.calls.total), 'last 30 days', 'flat') +
          kpi('Completed', fmtNum(ov.calls.completed), fmtNum(ov.calls.failed) + ' failed', 'flat') +
          kpi('Minutes', fmtNum(ov.minutes.total, 1), 'total talk time', 'flat') +
          kpi('Spend', fmtMoney(ov.cost.total), fmtMoney(ov.cost.perCall) + ' per call', 'flat') +
        '</div>' +

        '<div class="grid-2">' +
          '<div class="card"><div class="card-head"><h3>By agent</h3></div>' +
            (agents.length
              ? '<table><thead><tr><th>Agent</th><th>Calls</th><th>Minutes</th><th>Containment</th><th>Cost</th></tr></thead><tbody>' +
                agents.map(function (a) {
                  return '<tr><td><b>' + esc(a.name || agentNameFor(a.assistantId)) + '</b></td>' +
                    '<td class="mono">' + fmtNum(a.calls) + '</td>' +
                    '<td class="mono">' + fmtNum(a.minutes, 1) + '</td>' +
                    '<td class="mono">' + esc(fmtPct(a.containmentRate)) + '</td>' +
                    '<td class="mono">' + esc(fmtMoney(a.cost)) + '</td></tr>';
                }).join('') + '</tbody></table>'
              : '<div class="empty"><p>No call data yet.</p></div>') +
          '</div>' +

          '<div class="card"><div class="card-head"><h3>Why calls ended</h3></div>' +
            (reasons.length
              ? '<table><thead><tr><th>Reason</th><th>Count</th></tr></thead><tbody>' +
                reasons.map(function (x) {
                  return '<tr><td>' + esc(x.reason) + '</td><td class="mono">' + fmtNum(x.count) + '</td></tr>';
                }).join('') + '</tbody></table>'
              : '<div class="empty"><p>No completed calls yet.</p></div>') +
          '</div>' +
        '</div>';
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load analytics', err.message);
    });
  };

  // ---- Compliance / audit --------------------------------------------------

  RENDERERS.audit = function (node) {
    loading(node, 'Loading audit trail…');

    api('/v1/events/audit?limit=150').then(function (res) {
      var rows = res.data || [];
      node.innerHTML =
        '<div class="card">' +
          '<div class="card-head"><h3>Compliance log</h3>' +
            '<span class="meta">every change, who made it, and when</span></div>' +
          (rows.length
            ? '<table><thead><tr><th>Action</th><th>Actor</th><th>Resource</th><th>Status</th><th>IP</th><th>When</th></tr></thead><tbody>' +
              rows.map(function (r) {
                return '<tr>' +
                  '<td><b>' + esc(r.action) + '</b></td>' +
                  '<td>' + esc(r.actor.label || r.actor.id || '-') +
                    ' <span class="chip dim">' + esc(r.actor.type) + '</span></td>' +
                  '<td class="mono" style="font-size:.68rem">' + esc(r.resource ? r.resource.kind + ' ' + (r.resource.id || '') : '-') + '</td>' +
                  '<td class="mono">' + esc(r.status || '-') + '</td>' +
                  '<td class="mono" style="font-size:.68rem">' + esc(r.ip || '-') + '</td>' +
                  '<td class="mono" style="font-size:.7rem">' + esc(fmtDate(r.createdAt)) + '</td>' +
                  '</tr>';
              }).join('') + '</tbody></table>'
            : '<div class="empty"><p>No changes recorded yet.</p></div>') +
        '</div>';
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load audit trail', err.message);
    });
  };

  // ---- API explorer --------------------------------------------------------

  RENDERERS.api = function (node) {
    loading(node, 'Loading API surface…');

    Promise.all([
      api('/docs').catch(function () { return null; }),
      api('/v1/provider/_operations').catch(function () { return null; })
    ]).then(function (r) {
      var docs = r[0] || {};
      var ops = r[1];
      var grouped = {};

      if (ops) {
        (ops.data || []).forEach(function (o) {
          (grouped[o.tag] = grouped[o.tag] || []).push(o);
        });
      }

      node.innerHTML =
        '<div class="card" style="margin-bottom:14px">' +
          '<div class="card-head"><h3>Your API</h3>' +
            '<span class="meta">' + esc(docs.baseUrl || location.origin) + '</span></div>' +
          '<div class="card-body">' +
            '<p class="muted" style="font-size:.82rem;margin-bottom:12px">Native routes give you the ergonomic surface. <span class="mono">/v1/provider/*</span> covers every upstream operation with the same auth, isolation and audit.</p>' +
            '<div class="row" style="flex-wrap:wrap;gap:8px">' +
              '<a class="btn btn-line" href="/docs" target="_blank">API reference</a>' +
              '<a class="btn btn-line" href="/docs/openapi.json" target="_blank">OpenAPI spec</a>' +
              '<a class="btn btn-line" href="/docs/operations" target="_blank">Operation map</a>' +
            '</div>' +
          '</div>' +
        '</div>' +

        (ops
          ? '<div class="card">' +
              '<div class="card-head"><h3>Provider operations</h3>' +
                '<span class="meta">' + ops.availableOperations + ' of ' + ops.totalOperations +
                ' available · mode: ' + esc(ops.mode) + '</span></div>' +
              '<div class="card-body">' +
                Object.keys(grouped).sort().map(function (tag) {
                  return '<div class="sec-label">' + esc(tag) + '</div>' +
                    '<table><tbody>' + grouped[tag].map(function (o) {
                      return '<tr><td style="width:70px"><span class="chip ' +
                          (o.method === 'GET' ? 'teal' : o.method === 'DELETE' ? 'red' : 'amber') + '">' +
                          esc(o.method) + '</span></td>' +
                        '<td class="mono" style="font-size:.72rem">' + esc(o.voicekernelPath) + '</td>' +
                        '<td>' + esc(o.summary || '') + '</td>' +
                        '<td style="text-align:right">' + (o.available
                          ? '<span class="health ok">available</span>'
                          : '<span class="health warn" title="' + esc(o.unavailableReason || '') + '">platform-restricted</span>') +
                        '</td></tr>';
                    }).join('') + '</tbody></table>';
                }).join('') +
              '</div>' +
            '</div>'
          : emptyState('Operation map unavailable', 'Your credential may lack the provider:passthrough scope.'));
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load API surface', err.message);
    });
  };

  // ---- Settings ------------------------------------------------------------

  var SETTINGS_TABS = [
    { id: 'general', label: 'General' },
    // The key lives here. It used to be reachable only by deep link from
    // Providers, which meant clicking any other tab lost the panel with no way
    // back to it - a bad place to hide the one field that decides whether the
    // account can place a call at all.
    { id: 'provider', label: 'Voice provider' },
    { id: 'residency', label: 'Data & residency' },
    { id: 'billing', label: 'Billing & usage' },
    { id: 'catalog', label: 'Provider catalog' },
    { id: 'members', label: 'Members' }
  ];

  RENDERERS.settings = function (node) {
    $('subnav').innerHTML = SETTINGS_TABS.map(function (t) {
      return '<button data-stab="' + t.id + '"' +
        (state.settingsTab === t.id ? ' class="on"' : '') + '>' + esc(t.label) + '</button>';
    }).join('');

    els('[data-stab]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.settingsTab = b.getAttribute('data-stab');
        RENDERERS.settings(node);
      });
    });

    var renderers = {
      general: settingsGeneral,
      residency: settingsResidency,
      billing: settingsBilling,
      catalog: settingsCatalog,
      members: settingsMembers,
      // Kept reachable: Providers & routing deep-links here to change the key.
      provider: settingsProvider
    };
    (renderers[state.settingsTab] || settingsGeneral)(node);
  };

  function settingsGeneral(node) {
    var org = state.org || {};
    loading(node, 'Loading settings…');

    api('/v1/governance/change-control').then(function (cc) {
      var s = cc.settings;

      node.innerHTML =
        '<div class="card" style="max-width:820px">' +
          '<div class="card-head"><h3>Organisation</h3></div>' +
          '<div class="kv"><span class="k">Organisation name</span>' +
            '<span style="max-width:320px;width:100%"><input id="stName" value="' + esc(org.name || '') + '"></span></div>' +
          '<div class="kv"><span class="k">Environments' +
            '<small>API keys are issued per environment; test keys never touch live data</small></span>' +
            '<span class="v">live · test</span></div>' +
          '<div class="kv"><span class="k">Processing region' +
            '<small>media, inference and storage are pinned here</small></span>' +
            '<span style="max-width:220px;width:100%"><select id="stRegion">' +
              ['au-syd', 'eu-fra', 'us-east'].map(function (r) {
                return '<option value="' + r + '"' + (org.region === r ? ' selected' : '') + '>' + r + '</option>';
              }).join('') + '</select></span></div>' +
          '<div class="kv"><span class="k">Emergency bypass' +
            '<small>route inbound to a human queue if the platform degrades</small></span>' +
            '<span class="v"><span class="chip dim">NOT CONFIGURED</span></span></div>' +
          '<div style="padding:13px 16px"><button class="btn btn-amber" id="stSave">Save changes</button></div>' +
        '</div>' +

        '<div class="card" style="max-width:820px;margin-top:14px">' +
          '<div class="card-head"><h3>Change control</h3>' +
            '<span class="meta">how promotions happen</span></div>' +
          changeControlRow('ccGate', 'Production promotion gate',
            'Eval suites must pass before an agent is promoted.',
            s.requireEvalGateForProduction, cc.enforced.requireEvalGateForProduction) +
          changeControlRow('ccDual', 'Dual approval for gate waivers',
            'A single admin cannot waive a failing compliance eval.',
            s.requireDualApprovalForWaivers, cc.enforced.requireDualApprovalForWaivers) +
          changeControlRow('ccNotify', 'Prompt change notifications',
            'Every agent change emits agent.updated to your webhook endpoints.',
            s.notifyPromptChanges, cc.enforced.notifyPromptChanges) +
          '<div style="padding:13px 16px"><button class="btn btn-line" id="ccSave">Save change control</button></div>' +
        '</div>' +

        '<div class="card" style="max-width:820px;margin-top:14px">' +
          '<div class="card-head"><h3>Identifiers</h3></div>' +
          kvRow('Organisation ID', org.id || '-') +
          kvRow('Slug', org.slug || '-') +
          kvRow('Plan', org.plan || '-') +
          kvRow('Inbound webhook URL', location.origin + '/webhooks/provider/' + (org.id || '')) +
        '</div>';

      els('.toggle', node).forEach(function (t) {
        t.addEventListener('click', function () { t.classList.toggle('on'); });
      });

      $('stSave').addEventListener('click', function () {
        this.disabled = true;
        api('/v1/organization', {
          method: 'PATCH',
          body: { name: $('stName').value.trim(), region: $('stRegion').value }
        }).then(function (updated) {
          state.org = updated;
          renderOrgChrome();
          toast('Settings saved');
        }).catch(fail).then(function () { $('stSave').disabled = false; });
      });

      $('ccSave').addEventListener('click', function () {
        this.disabled = true;
        api('/v1/governance/change-control', {
          method: 'PUT',
          body: {
            requireEvalGateForProduction: $('ccGate').classList.contains('on'),
            requireDualApprovalForWaivers: $('ccDual').classList.contains('on'),
            notifyPromptChanges: $('ccNotify').classList.contains('on')
          }
        }).then(function () { toast('Change control saved'); })
          .catch(fail).then(function () { $('ccSave').disabled = false; });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load settings', err.message);
    });
  }

  /**
   * A policy toggle, labelled with whether the platform actually enforces it.
   * A control that only records an intention must not look like one that acts.
   */
  function changeControlRow(id, title, body, on, enforcement) {
    var enforced = /^Enforced/.test(enforcement || '');
    return '<div class="kv"><span class="k">' + esc(title) +
      '<small>' + esc(body) + '</small>' +
      '<small style="color:' + (enforced ? 'var(--teal)' : 'var(--amber)') + '">' +
        esc(enforcement || '') + '</small></span>' +
      '<button class="toggle' + (on ? ' on' : '') + '" id="' + id + '" aria-label="' + esc(title) + '"></button>' +
      '</div>';
  }

  function settingsResidency(node) {
    loading(node, 'Loading residency…');

    api('/v1/governance/residency').then(function (r) {
      var att = r.attestations;
      var attRow = function (key, label) {
        var value = att[key];
        return '<div class="kv"><span class="k">' + esc(label) + '</span>' +
          '<span style="max-width:280px;width:100%"><input data-att="' + key + '" value="' +
            esc(value || '') + '" placeholder="not recorded"></span></div>';
      };

      node.innerHTML =
        '<div class="card" style="max-width:880px">' +
          '<div class="card-head"><h3>Residency</h3>' +
            '<span class="meta">the answer to your risk team\'s first question</span></div>' +
          '<div class="kv"><span class="k">Processing region' +
            '<small>media, inference and storage pinned - nothing transits other regions</small></span>' +
            '<span class="v"><span class="chip teal">' + esc(r.residency.processingRegion) + '</span></span></div>' +
          kvRow('Deployment model', r.residency.deploymentModel) +
          '<div class="kv"><span class="k">Model inference<small>' + esc(r.residency.modelInference) +
            '</small></span><span class="v">' + esc(r.residency.providerMode) + '</span></div>' +
        '</div>' +

        '<div class="card" style="max-width:880px;margin-top:14px">' +
          '<div class="card-head"><h3>Encryption</h3></div>' +
          '<div class="kv"><span class="k">In transit</span><span class="v">' + esc(r.encryption.inTransit) + '</span></div>' +
          '<div class="kv"><span class="k">Tenant secrets at rest</span><span class="v" style="max-width:420px">' +
            esc(r.encryption.atRest) + '</span></div>' +
          kvRow('Passwords', r.encryption.passwords) +
          kvRow('API keys', r.encryption.apiKeys) +
        '</div>' +

        '<div class="card" style="max-width:880px;margin-top:14px">' +
          '<div class="card-head"><h3>Retention &amp; redaction</h3></div>' +
          '<div class="kv"><span class="k">Call recordings</span>' +
            '<span style="max-width:240px;width:100%"><input id="reRec" value="' +
              esc(r.retention.recordings) + '" placeholder="90 days"></span></div>' +
          '<div class="kv"><span class="k">Transcripts &amp; reasoning logs</span>' +
            '<span style="max-width:240px;width:100%"><input id="reTx" value="' +
              esc(r.retention.transcripts) + '" placeholder="7 years, redacted"></span></div>' +
          kvRow('Audit logs', r.retention.auditLogs) +
          '<div class="kv"><span class="k">Enforcement</span>' +
            '<span class="v" style="max-width:440px;color:var(--amber)">' + esc(r.retention.enforced) + '</span></div>' +
          '<div class="kv"><span class="k">PCI redaction' +
            '<small>set per agent under Guardrails; writes compliancePlan.pciEnabled</small></span>' +
            '<span class="v"><span class="chip dim">PER AGENT</span></span></div>' +
        '</div>' +

        '<div class="card" style="max-width:880px;margin-top:14px">' +
          '<div class="card-head"><h3>Right to erasure</h3>' +
            '<span class="chip teal">ENFORCED</span></div>' +
          '<div class="kv"><span class="k">Endpoint<small>' + esc(r.erasure.enforced) + '</small></span>' +
            '<span class="v">' + esc(r.erasure.endpoint) + '</span></div>' +
          '<div class="card-body" style="border-top:1px solid var(--line-soft)">' +
            '<div class="field"><label for="erSubject">Erase a caller</label>' +
              '<input id="erSubject" placeholder="+61400000000"></div>' +
            '<div class="row">' +
              '<button class="btn btn-line" id="erPreview">Preview</button>' +
              '<button class="btn btn-red" id="erRun">Erase</button>' +
            '</div>' +
            '<div id="erOut" style="margin-top:12px"></div>' +
          '</div>' +
        '</div>' +

        '<div class="card" style="max-width:880px;margin-top:14px">' +
          '<div class="card-head"><h3>Attestations</h3>' +
            '<span class="meta">records you maintain - not claims this software verifies</span></div>' +
          attRow('soc2', 'SOC 2 Type II') +
          attRow('iso27001', 'ISO 27001') +
          attRow('pciDss', 'PCI-DSS') +
          attRow('irap', 'IRAP') +
          '<div style="padding:13px 16px"><button class="btn btn-amber" id="reSave">Save</button></div>' +
        '</div>';

      $('reSave').addEventListener('click', function () {
        var attestations = {};
        els('[data-att]', node).forEach(function (i) {
          attestations[i.getAttribute('data-att')] = i.value.trim() || null;
        });
        this.disabled = true;
        api('/v1/governance/residency', {
          method: 'PUT',
          body: {
            retention: { recordings: $('reRec').value.trim(), transcripts: $('reTx').value.trim() },
            attestations: attestations
          }
        }).then(function () { toast('Saved'); })
          .catch(fail).then(function () { $('reSave').disabled = false; });
      });

      $('erPreview').addEventListener('click', function () {
        var subject = $('erSubject').value.trim();
        if (!subject) return toast('Number required', 'Enter the caller number.', 'err');
        api('/v1/subjects/' + encodeURIComponent(subject)).then(function (p) {
          $('erOut').innerHTML = '<div class="info"><span class="ic">i</span><p>' +
            '<b>' + p.calls + ' call' + (p.calls === 1 ? '' : 's') + '</b> would be redacted' +
            (p.earliest ? ', from ' + esc(fmtDate(p.earliest)) + ' to ' + esc(fmtDate(p.latest)) : '') +
            '.</p></div>';
        }).catch(fail);
      });

      $('erRun').addEventListener('click', function () {
        var subject = $('erSubject').value.trim();
        if (!subject) return toast('Number required', 'Enter the caller number.', 'err');
        if (!confirm('Erase ' + subject + '? Transcripts, recordings and identifiers are removed permanently.')) return;

        this.disabled = true;
        api('/v1/subjects/' + encodeURIComponent(subject), { method: 'DELETE' })
          .then(function (receipt) {
            $('erOut').innerHTML = '<div class="info ' + (receipt.complete ? 'good' : 'warn') + '">' +
              '<span class="ic">' + (receipt.complete ? '✓' : '!') + '</span><p>' +
              '<b>' + receipt.callsRedacted + ' call(s) redacted</b>, ' + receipt.eventsRedacted +
              ' event(s) scrubbed, ' + receipt.upstream.deleted + ' deleted upstream. ' +
              esc(receipt.note) + '</p></div>';
            toast(receipt.complete ? 'Erasure complete' : 'Erasure partial',
              receipt.note, receipt.complete ? undefined : 'warn');
          }).catch(fail).then(function () { $('erRun').disabled = false; });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load residency', err.message);
    });
  }

  function settingsBilling(node) {
    loading(node, 'Loading usage…');

    api('/v1/governance/workloads').then(function (w) {
      var t = w.totals;
      var peak = w.data.reduce(function (m, x) { return Math.max(m, x.cost); }, 0.0001);

      node.innerHTML =
        '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">' +
          kpi('Plan', (state.org && state.org.plan) || '-', 'organisation plan', 'flat') +
          kpi('Provider cost · 30d', fmtMoney(t.cost), 'measured from your calls', 'flat') +
          kpi('Minutes · 30d', fmtNum(t.minutes, 1),
              t.blendedCostPerMinute === null ? 'no usage yet' : 'blended $' + t.blendedCostPerMinute + '/min', 'flat') +
          kpi('Cost per call', t.costPerCall === null ? '-' : fmtMoney(t.costPerCall),
              fmtNum(t.calls) + ' calls', 'flat') +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><h3>Usage by workload · 30d</h3>' +
            '<span class="meta">per agent · set a budget to track against it</span></div>' +
          (w.data.length
            ? w.data.map(function (x) {
                var pct = x.budget && x.budget > 0
                  ? Math.min(100, (x.cost / x.budget) * 100)
                  : (x.cost / peak) * 100;
                var warn = x.budget && x.budget > 0 && pct > 80;
                return '<div class="usage-line">' +
                  '<span class="lab">' + esc(x.name || 'unattributed') + '</span>' +
                  '<div class="ubar"><i class="' + (warn ? 'warn' : '') + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
                  '<span class="n">' + fmtNum(x.minutes, 1) + ' min · ' + fmtMoney(x.cost) +
                    (x.budget ? ' · ' + Math.round(pct) + '% of budget' : '') + '</span>' +
                  '</div>';
              }).join('')
            : '<div class="empty"><p>No calls in this period, so there is nothing to attribute.</p></div>') +
        '</div>' +

        '<div class="card" style="margin-top:14px">' +
          '<div class="card-head"><h3>Invoices</h3></div>' +
          '<div class="card-body">' +
            '<div class="info warn"><span class="ic">i</span><p>' + esc(w.billing.note) + '</p></div>' +
          '</div>' +
        '</div>';
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load usage', err.message);
    });
  }

  function settingsProvider(node) {
    var org = state.org || {};
    var provider = org.provider || {};
    var isByo = provider.mode === 'byo';

    node.innerHTML =
      '<div class="card" style="max-width:720px">' +
        '<div class="card-head"><h3>Voice provider</h3>' +
          '<span class="chip ' + (isByo ? 'teal' : 'dim') + '">' + esc(provider.mode || 'platform') + '</span></div>' +
        '<div class="card-body">' +
          '<p class="muted" style="font-size:.82rem;margin-bottom:14px">' +
            (isByo
              ? 'This organisation runs on its own provider account. Every operation is available, including account-wide analytics, and isolation is enforced by your own credential.'
              : 'This organisation runs on the shared VoiceKernel platform account. Tenant isolation is enforced by VoiceKernel; a small number of account-wide operations are unavailable. Add your own provider key to lift that restriction.') +
          '</p>' +
          (isByo
            ? kvRow('Key', '••••••••' + esc(provider.keyLast4 || '')) +
              kvRow('Configured', fmtDate(provider.keySetAt)) +
              '<div style="padding:16px 0 0"><button class="btn btn-red" id="prClear">Remove key and return to platform mode</button></div>'
            : '<div class="field"><label for="prKey">Your voice provider API key</label>' +
                '<input id="prKey" type="password" placeholder="Paste your provider private key">' +
                '<div class="hint">Verified against the provider before it is stored, then encrypted at rest.</div></div>' +
              '<button class="btn btn-amber" id="prSave">Verify and save</button>') +
          (provider.platformKeyAvailable === false && !isByo
            ? '<p style="margin-top:14px;font-size:.8rem;color:var(--amber)">No platform key is configured on this deployment, so calls will fail until you add your own.</p>'
            : '') +
        '</div>' +
      '</div>';

    if ($('prSave')) {
      $('prSave').addEventListener('click', function () {
        var key = $('prKey').value.trim();
        if (!key) return toast('Key required', 'Paste your provider private key.', 'err');
        this.disabled = true;
        api('/v1/organization/provider', { method: 'PUT', body: { apiKey: key } })
          .then(function (updated) {
            state.org = updated;
            renderOrgChrome();
            toast('provider key verified', updated.message);
            RENDERERS.settings(node);
          }).catch(function (err) { fail(err); $('prSave').disabled = false; });
      });
    }

    if ($('prClear')) {
      $('prClear').addEventListener('click', function () {
        if (!confirm('Remove your provider key? Agents and calls created under it will no longer be reachable.')) return;
        api('/v1/organization/provider', { method: 'DELETE' })
          .then(function (updated) {
            state.org = updated;
            renderOrgChrome();
            toast('Key removed', updated.message);
            RENDERERS.settings(node);
          }).catch(fail);
      });
    }
  }

  function settingsData(node) {
    var org = state.org || {};
    node.innerHTML =
      '<div class="card" style="max-width:820px">' +
        '<div class="card-head"><h3>Data &amp; residency</h3></div>' +
        kvRow('Processing region', org.region || '-') +
        kvRow('Transcript retention', '90 days') +
        kvRow('Recording retention', '90 days') +
        kvRow('PCI redaction', 'Enabled in-stream') +
        kvRow('Audit retention', 'Indefinite') +
      '</div>' +
      '<div class="card" style="max-width:820px;margin-top:14px">' +
        '<div class="card-head"><h3>What leaves your boundary</h3></div>' +
        '<div class="card-body">' +
          '<p class="muted" style="font-size:.82rem">Audio and transcripts are processed in ' + esc(org.region || 'your region') +
          ' and stored against this organisation only. VoiceKernel proxies to your voice provider using the credential configured under Voice provider; no other tenant can read your objects, because every request is checked against an ownership registry before it reaches the upstream.</p>' +
        '</div>' +
      '</div>';
  }

  function settingsUsage(node) {
    loading(node, 'Loading usage…');
    api('/v1/analytics/overview').then(function (ov) {
      var minutes = ov.minutes.total;
      var quota = 120000;
      var pct = Math.min(100, (minutes / quota) * 100);

      node.innerHTML =
        '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">' +
          kpi('Minutes', fmtNum(minutes, 1), 'this period', 'flat') +
          kpi('Calls', fmtNum(ov.calls.total), 'this period', 'flat') +
          kpi('Spend', fmtMoney(ov.cost.total), 'provider cost', 'flat') +
          kpi('Avg call', fmtNum(ov.minutes.average, 1) + ' min', 'per conversation', 'flat') +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><h3>Against your commitment</h3></div>' +
          '<div class="usage-line"><span class="lab">Voice minutes</span>' +
            '<div class="ubar"><i class="' + (pct > 80 ? 'warn' : '') + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
            '<span class="n">' + fmtNum(minutes, 0) + ' / ' + fmtNum(quota) + '</span></div>' +
          '<div class="usage-line"><span class="lab">Calls</span>' +
            '<div class="ubar"><i style="width:' + Math.min(100, (ov.calls.total / 5000) * 100).toFixed(1) + '%"></i></div>' +
            '<span class="n">' + fmtNum(ov.calls.total) + ' / 5,000</span></div>' +
        '</div>';
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load usage', err.message);
    });
  }

  var catalogFilter = 'all';

  /**
   * The provider catalog, grouped the way the pipeline is: reasoning, voice and
   * transcription, telephony and sinks.
   *
   * "Connected" is derived from what this org's agents actually reference - * the honest signal - rather than from a static list of vendors we integrate
   * with. A provider nobody uses is available, not connected.
   */
  function settingsCatalog(node) {
    loading(node, 'Loading provider catalog…');

    Promise.all([
      api('/v1/catalog'),
      api('/v1/observe/providers').catch(function () { return { routing: {} }; }),
      api('/v1/catalog/actions').catch(function () { return { groups: [] }; })
    ]).then(function (r) {
      var cat = r[0];
      var routing = r[1].routing || {};
      var actions = r[2];
      state.catalog = cat;

      // Providers this org is genuinely using, by stage.
      var connected = {};
      ['model', 'voice', 'transcriber'].forEach(function (stage) {
        (routing[stage] || []).forEach(function (e) {
          connected[stage + ':' + e.provider] = e.agents;
        });
      });

      var sections = [
        { id: 'reasoning', label: 'Reasoning', stage: 'model', data: cat.models },
        { id: 'voice', label: 'Voice & transcription', stage: 'voice', data: cat.voices },
        { id: 'transcription', label: 'Voice & transcription', stage: 'transcriber', data: cat.transcribers }
      ];

      var filters = [
        { id: 'all', label: 'All' },
        { id: 'reasoning', label: 'Reasoning' },
        { id: 'voice', label: 'Voice' },
        { id: 'transcription', label: 'Transcription' },
        { id: 'telephony', label: 'Telephony & sinks' },
        { id: 'connected', label: 'Connected only' }
      ];

      function card(p, stage) {
        var agents = connected[stage + ':' + p.provider];
        var isConnected = Boolean(agents);
        return '<div class="prov-card">' +
          '<div class="prov-top"><div><h4>' + esc(p.label) + '</h4>' +
            '<div class="cat">' + esc(stage.toUpperCase()) + '</div></div>' +
            '<span class="chip ' + (isConnected ? 'teal' : 'dim') + '">' +
            (isConnected ? 'CONNECTED' : 'AVAILABLE') + '</span></div>' +
          '<p>' + esc(isConnected
            ? 'In use by ' + agents + ' agent' + (agents === 1 ? '' : 's') + '.'
            : (p.options.length
                ? p.options.length + ' option(s) available. Select it on an agent to start using it.'
                : 'Accepts any provider-specific identifier.')) + '</p>' +
          '<div class="prov-foot"><div class="badges">' +
            p.options.slice(0, 3).map(function (o) {
              return '<span class="chip dim">' + esc(shortModel(o)) + '</span>';
            }).join('') +
            (p.options.length > 3 ? '<span class="chip dim">+' + (p.options.length - 3) + '</span>' : '') +
          '</div></div></div>';
      }

      var body = '';

      sections.forEach(function (s, i) {
        if (catalogFilter !== 'all' && catalogFilter !== s.id && catalogFilter !== 'connected') return;
        var items = s.data.filter(function (p) {
          return catalogFilter !== 'connected' || connected[s.stage + ':' + p.provider];
        });
        if (!items.length) return;
        // Voice and transcription share a heading in the design; print it once.
        var heading = s.id === 'transcription' && catalogFilter === 'all' ? '' :
          '<div class="sec-label">' + esc(s.label) + '</div>';
        body += heading + '<div class="prov-grid">' +
          items.map(function (p) { return card(p, s.stage); }).join('') + '</div>';
      });

      if (catalogFilter === 'all' || catalogFilter === 'telephony') {
        var telephony = (actions.groups || []).filter(function (g) {
          return g.group === 'Telephony' || g.group === 'Integrations';
        });
        body += telephony.map(function (g) {
          return '<div class="sec-label">' + esc(g.group === 'Telephony' ? 'Telephony' : 'Sinks & integrations') + '</div>' +
            '<div class="prov-grid">' + g.tools.slice(0, 9).map(function (t) {
              return '<div class="prov-card">' +
                '<div class="prov-top"><div><h4>' + esc(t.label) + '</h4>' +
                  '<div class="cat">' + esc(t.type) + '</div></div>' +
                  '<span class="chip ' + (t.custom ? 'blue' : 'teal') + '">' +
                  (t.custom ? 'CONFIGURE' : 'BUILT-IN') + '</span></div>' +
                '<p>' + esc(t.description || 'Supported action type.') + '</p>' +
                '<div class="prov-foot"><div class="badges"></div>' +
                  '<button class="btn btn-line btn-sm" data-go-actions="1">Add under Actions</button></div>' +
                '</div>';
            }).join('') + '</div>';
        }).join('');
      }

      node.innerHTML =
        '<div class="cat-filter">' + filters.map(function (f) {
          return '<button class="fpill' + (catalogFilter === f.id ? ' on' : '') +
            '" data-filter="' + f.id + '">' + esc(f.label) + '</button>';
        }).join('') + '</div>' +

        '<p class="muted" style="font-size:.82rem;margin-bottom:16px">' +
          cat.counts.modelProviders + ' model providers · ' + cat.counts.models + ' models · ' +
          cat.counts.voiceProviders + ' voice · ' + cat.counts.transcriberProviders + ' transcription · ' +
          actions.total + ' action types. Any agent can switch between them without touching its prompt.</p>' +

        (body || '<div class="card"><div class="empty"><p>Nothing matches this filter.</p></div></div>') +

        '<p class="mono" style="font-size:.64rem;color:var(--txt-dim);margin-top:14px">' +
          'Connecting a provider never exposes it to agents directly - it is selected per agent, ' +
          'validated against the catalog at save time, and inherits your region pinning.</p>';

      els('[data-filter]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          catalogFilter = b.getAttribute('data-filter');
          settingsCatalog(node);
        });
      });
      els('[data-go-actions]', node).forEach(function (b) {
        b.addEventListener('click', function () { navigate('actions'); });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load catalog', err.message);
    });
  }

  function settingsMembers(node) {
    loading(node, 'Loading members…');
    api('/v1/organization/members').then(function (res) {
      node.innerHTML =
        '<div class="card" style="max-width:820px">' +
          '<div class="card-head"><h3>Members</h3><span class="meta">' + (res.data || []).length + '</span></div>' +
          '<table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Joined</th></tr></thead><tbody>' +
          (res.data || []).map(function (m) {
            return '<tr><td><b>' + esc(m.email) + '</b></td>' +
              '<td>' + esc(m.name || '-') + '</td>' +
              '<td><span class="chip ' + (m.role === 'owner' ? 'amber' : 'dim') + '">' + esc(m.role) + '</span></td>' +
              '<td class="mono" style="font-size:.7rem">' + esc(fmtDate(m.joinedAt)) + '</td></tr>';
          }).join('') + '</tbody></table>' +
        '</div>';
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load members', err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // Monitoring
  //
  // Monitors are evaluated server-side from the call mirror. A monitor with no
  // data reports "unknown" and is rendered as such - never as healthy, because
  // "not measured" and "fine" are different answers.
  // ---------------------------------------------------------------------------

  RENDERERS.monitoring = function (node) {
    loading(node, 'Evaluating monitors…');

    api('/v1/observe/monitors').then(function (m) {
      state.counts.issues = m.issues.length;
      updateCounts();

      var slo = m.slo || {};
      node.innerHTML =
        '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">' +
          kpi('Active issues', String(m.issues.length),
              m.summary.firing + ' firing · ' + m.summary.unknown + ' unmeasured',
              m.issues.length ? 'down' : 'up') +
          kpi('Monitors', String(m.summary.total), m.summary.total - m.summary.unknown + ' reporting', 'flat') +
          kpi('SLO · p95', slo.p95 === null ? '-' : slo.p95 + '<span style="font-size:.9rem;color:var(--txt-dim)">ms</span>',
              'target ' + slo.sla + 'ms', slo.p95 !== null && slo.p95 <= slo.sla ? 'up' : 'flat') +
          kpi('Error budget', slo.errorBudgetRemaining === null ? '-' : fmtPct(slo.errorBudgetRemaining),
              'remaining against SLO', 'flat') +
        '</div>' +

        '<div class="grid-2">' +
          '<div class="card">' +
            '<div class="card-head"><h3>Issues</h3>' +
              '<span class="meta">opened automatically by a firing monitor</span></div>' +
            (m.issues.length
              ? m.issues.map(function (i) {
                  return '<div class="inc">' +
                    '<div class="sev ' + (i.severity === 'critical' ? 'crit' : 'warn') + '"></div>' +
                    '<div class="body"><h4>' + esc(i.title) +
                      ' <span class="chip ' + (i.severity === 'critical' ? 'red' : 'amber') + '">' +
                      esc(i.severity.toUpperCase()) + '</span></h4>' +
                      '<p>' + esc(i.summary) + '</p></div>' +
                    '</div>';
                }).join('')
              : '<div class="empty"><h4>No open issues</h4>' +
                '<p>Every monitor that has data is within threshold.</p></div>') +
          '</div>' +

          '<div class="card">' +
            '<div class="card-head"><h3>Coverage</h3><span class="meta">what is being measured</span></div>' +
            m.monitors.map(function (mon) {
              return kvRow(mon.name, mon.state === 'unknown' ? 'not measured' : mon.state);
            }).join('') +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><h3>Monitors</h3>' +
            '<span class="meta">infrastructure · effectiveness · compliance</span></div>' +
          m.monitors.map(function (mon) {
            var dot = mon.state === 'firing' ? 'warn' : mon.state === 'unknown' ? 'unk' : 'ok';
            var chip = mon.state === 'firing' ? 'amber' : mon.state === 'unknown' ? 'dim' : 'teal';
            var label = mon.state === 'firing' ? 'FIRING' : mon.state === 'unknown' ? 'NO DATA' : 'OK';
            var peak = (mon.sparkline || []).reduce(function (a, b) { return Math.max(a, b); }, 1);
            return '<div class="mon-row">' +
              '<span class="dot ' + dot + '"></span>' +
              '<span class="nm">' + esc(mon.name) + '</span>' +
              '<span class="cond">' + esc(mon.condition) + '</span>' +
              '<div class="spark ' + (mon.state === 'firing' ? 'warn' : '') +
                (mon.sparkline && mon.sparkline.length ? '' : ' empty') + '">' +
                ((mon.sparkline && mon.sparkline.length ? mon.sparkline : [0, 0, 0, 0, 0, 0])
                  .map(function (v) {
                    return '<i style="height:' + Math.max(6, Math.round((v / peak) * 100)) + '%"></i>';
                  }).join('')) +
              '</div>' +
              '<span class="chip ' + chip + '" title="' + esc(mon.detail) + '">' + label +
                (mon.value !== null ? ' · ' + esc(mon.value) + esc(mon.unit) : '') + '</span>' +
              '</div>';
          }).join('') +
        '</div>';
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not evaluate monitors', err.message);
    });
  };

  // ---------------------------------------------------------------------------
  // Evals - suites, regression matrix, deploy gate
  // ---------------------------------------------------------------------------

  RENDERERS.evals = function (node) {
    loading(node, 'Loading eval suites…');

    api('/v1/observe/evals/summary').then(function (e) {
      state.counts.eval = e.totals.suites;
      updateCounts();

      if (!e.totals.suites) {
        node.innerHTML = emptyState(
          'No eval suites yet',
          'An eval suite is a set of scripted scenarios your agent must pass - resolution flows, compliance probes, opt-out handling. Suites gate promotion to production.',
          '+ Create your first suite', 'firstEval');
        var b = $('firstEval');
        if (b) b.addEventListener('click', openEvalForm);
        return;
      }

      node.innerHTML =
        '<div class="eval-grid">' +
          '<div>' +
            '<div class="card" style="margin-bottom:14px">' +
              '<div class="card-head"><h3>Suites</h3>' +
                '<span class="meta">' + e.totals.passing + ' passing · ' + e.totals.failing +
                ' failing · ' + e.totals.neverRun + ' never run</span></div>' +
              e.data.map(function (s) {
                var run = s.lastRun;
                var pct = run && run.passRate !== null ? Math.round(run.passRate * 100) : 0;
                var cls = s.status === 'passing' ? '' : s.status === 'failing' ? ' warn' : ' bad';
                var colour = s.status === 'passing' ? 'var(--teal)'
                  : s.status === 'failing' ? 'var(--amber)' : 'var(--txt-dim)';
                return '<div class="suite-row">' +
                  '<span class="nm">' + esc(s.name) + '</span>' +
                  '<span class="desc">' + esc(s.type || 'eval suite') +
                    (run && run.createdAt ? ' · last run ' + esc(timeAgo(run.createdAt)) : ' · never run') +
                  '</span>' +
                  '<div class="passbar' + cls + '"><i style="width:' + (s.status === 'never_run' ? 0 : pct) + '%"></i></div>' +
                  '<span class="score" style="color:' + colour + '">' +
                    (run ? run.passed + '/' + run.total : '-') + '</span>' +
                  '<button class="btn btn-line btn-sm" data-runeval="' + esc(s.id) + '">Run</button>' +
                  '</div>';
              }).join('') +
            '</div>' +

            '<div class="card">' +
              '<div class="card-head"><h3>Latest results</h3>' +
                '<span class="meta">per suite</span></div>' +
              '<table class="matrix"><thead><tr>' +
                '<th>Suite</th><th>Status</th><th>Passed</th><th>Pass rate</th><th>Last run</th>' +
              '</tr></thead><tbody>' +
              e.data.map(function (s) {
                var cell = s.status === 'passing' ? 'p' : s.status === 'failing' ? 'f' : 'u';
                return '<tr><td><b>' + esc(s.name) + '</b></td>' +
                  '<td><span class="cell ' + cell + '">' + esc(s.status.replace('_', ' ')) + '</span></td>' +
                  '<td class="mono">' + (s.lastRun ? s.lastRun.passed + '/' + s.lastRun.total : '-') + '</td>' +
                  '<td class="mono">' + (s.lastRun && s.lastRun.passRate !== null ? fmtPct(s.lastRun.passRate) : '-') + '</td>' +
                  '<td class="mono" style="font-size:.7rem">' +
                    (s.lastRun && s.lastRun.createdAt ? esc(fmtDate(s.lastRun.createdAt)) : 'never') + '</td>' +
                  '</tr>';
              }).join('') + '</tbody></table>' +
            '</div>' +
          '</div>' +

          '<div>' +
            '<div class="card" style="margin-bottom:12px">' +
              '<div class="card-head"><h3>Deploy gate</h3><span class="meta">blocks promotion</span></div>' +
              e.gate.map(function (g) {
                return '<div class="gate">' +
                  '<div class="ic ' + (g.passed ? 'ok' : 'no') + '">' + (g.passed ? '✓' : '✕') + '</div>' +
                  '<p><b>' + esc(g.label) + '</b> - ' + esc(g.detail) + '</p></div>';
              }).join('') +
              '<div style="padding:13px 15px">' +
                '<button class="btn ' + (e.canPromote ? 'btn-amber' : 'btn-line') + '" style="width:100%"' +
                  (e.canPromote ? '' : ' disabled') + '>' +
                  (e.canPromote ? 'Promote to production' : 'Promotion blocked') + '</button>' +
              '</div>' +
            '</div>' +

            '<div class="card">' +
              '<div class="card-head"><h3>How the gate works</h3></div>' +
              '<div class="card-body" style="font-size:.79rem;color:var(--txt-mid)">' +
                '<p>A suite that has never run counts as <b style="color:var(--txt)">not passing</b>. ' +
                'An unverified agent must not reach production just because nobody tested it.</p>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';

      els('[data-runeval]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          b.disabled = true;
          b.textContent = 'Running…';
          api('/v1/observe/evals/' + b.getAttribute('data-runeval') + '/run', { method: 'POST' })
            .then(function () { toast('Eval run started'); renderView('evals'); })
            .catch(function (err) { fail(err); b.disabled = false; b.textContent = 'Run'; });
        });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load evals', err.message);
    });
  };

  function openEvalForm() {
    openDrawer('New eval suite',
      '<div class="field"><label for="evName">Suite name</label>' +
        '<input id="evName" placeholder="Compliance probes"></div>' +
      '<div class="field"><label for="evType">Type</label>' +
        '<select id="evType">' +
          '<option value="chat">Chat - scripted conversation</option>' +
          '<option value="voice">Voice - synthetic caller</option>' +
        '</select></div>' +
      '<div class="field"><label for="evBody">Definition (JSON)</label>' +
        '<textarea id="evBody" style="min-height:180px;font-family:\'IBM Plex Mono\';font-size:.74rem">' +
        esc('{\n  "rubric": "AssistantResponseCorrectness",\n  "messages": []\n}') + '</textarea>' +
        '<div class="hint">Passed through to the provider. See /docs for the eval schema.</div></div>',
      '<button class="btn btn-line" data-close>Cancel</button>' +
      '<button class="btn btn-amber" id="evSubmit">Create suite</button>');

    $('evSubmit').addEventListener('click', function () {
      var name = $('evName').value.trim();
      if (!name) return toast('Name required', 'Name the suite.', 'err');
      var extra;
      try { extra = JSON.parse($('evBody').value || '{}'); }
      catch (e) { return toast('Invalid JSON', 'The definition is not valid JSON.', 'err'); }

      this.disabled = true;
      api('/v1/evals', { method: 'POST', body: Object.assign({ name: name, type: $('evType').value }, extra) })
        .then(function () { closeDrawer(); toast('Suite created'); loadCounts(); renderView('evals'); })
        .catch(function (err) { fail(err); $('evSubmit').disabled = false; });
    });
  }

  // ---------------------------------------------------------------------------
  // Voices
  // ---------------------------------------------------------------------------

  RENDERERS.voices = function (node) {
    loading(node, 'Loading voices…');

    api('/v1/observe/voices').then(function (v) {
      node.innerHTML =
        '<div class="audition-bar">' +
          '<span style="font-size:.8rem;color:var(--txt-mid);flex-shrink:0">Audition line:</span>' +
          '<input id="vcLine" value="I\'ve flagged that transaction as disputed - you\'re covered while we investigate.">' +
          '<button class="btn btn-line" style="flex-shrink:0" id="vcProviderBtn">Load provider library</button>' +
        '</div>' +

        '<div class="sec-label">In use by your agents</div>' +
        (v.inUse.length
          ? '<div class="voice-grid">' + v.inUse.map(function (u) {
              return '<div class="voice-card">' +
                '<div class="voice-top"><button class="play" title="Preview requires a provider key">▶</button>' +
                  '<div><h4>' + esc(u.voiceId) + '</h4>' +
                  '<div class="prov">' + esc(u.provider) + '</div></div></div>' +
                '<div class="voice-desc">Used by ' + esc(u.agents.slice(0, 3).join(', ')) +
                  (u.agents.length > 3 ? ' +' + (u.agents.length - 3) + ' more' : '') + '.</div>' +
                '<div class="voice-foot"><span class="chip amber">' + u.agents.length + ' agent' +
                  (u.agents.length === 1 ? '' : 's') + '</span></div>' +
                '</div>';
            }).join('') + '</div>'
          : '<div class="card"><div class="empty"><p>No agents have a voice configured yet.</p></div></div>') +

        '<div class="sec-label">Available providers · ' + v.providers.length + '</div>' +
        '<div class="voice-grid">' + v.providers.map(function (p) {
          return '<div class="voice-card">' +
            '<div class="voice-top"><button class="play" data-vprov="' + esc(p.provider) + '">▶</button>' +
              '<div><h4>' + esc(p.label) + '</h4><div class="prov">' + esc(p.provider) + '</div></div></div>' +
            '<div class="voice-desc">' + esc(p.options.length
              ? p.options.length + ' preset voice(s)' + (p.freeform ? ', plus any provider voice ID.' : '.')
              : 'Accepts any provider-specific voice ID.') + '</div>' +
            '<div class="voice-foot">' + p.options.slice(0, 4).map(function (o) {
              return '<span class="chip dim">' + esc(o) + '</span>';
            }).join('') +
            (p.options.length > 4 ? '<span class="chip dim">+' + (p.options.length - 4) + '</span>' : '') +
            '</div></div>';
        }).join('') + '</div>' +

        '<div id="vcLibrary"></div>';

      // Previewing audio needs the provider's own synthesis endpoint and a
      // credential; without one we say so rather than showing a dead button.
      els('.play', node).forEach(function (b) {
        b.addEventListener('click', function () {
          var provider = b.getAttribute('data-vprov');
          if (!provider) {
            return toast('Preview unavailable',
              'Audio preview needs a configured provider credential. Place a test call to hear the voice.', 'warn');
          }
          loadVoiceLibrary(provider);
        });
      });

      $('vcProviderBtn').addEventListener('click', function () {
        var provider = prompt('Provider to load voices from:\n' +
          v.providers.map(function (p) { return p.provider; }).join(', '));
        if (provider) loadVoiceLibrary(provider.trim());
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load voices', err.message);
    });
  };

  function loadVoiceLibrary(provider) {
    var box = $('vcLibrary');
    if (!box) return;
    box.innerHTML = '<div class="sec-label">' + esc(provider) + ' library</div>' +
      '<div class="card"><div class="empty"><span class="spinner"></span></div></div>';

    api('/v1/observe/voices?provider=' + encodeURIComponent(provider)).then(function (v) {
      var lib = v.library;
      if (!lib || lib.error) {
        box.innerHTML = '<div class="sec-label">' + esc(provider) + ' library</div>' +
          '<div class="card"><div class="empty"><h4>Library unavailable</h4><p>' +
          esc((lib && lib.error) || 'No voices returned. This provider may need a credential on your provider account.') +
          '</p></div></div>';
        return;
      }
      var items = Array.isArray(lib) ? lib : (lib.results || lib.data || []);
      box.innerHTML = '<div class="sec-label">' + esc(provider) + ' library · ' + items.length + '</div>' +
        '<div class="voice-grid">' + items.slice(0, 30).map(function (voice) {
          return '<div class="voice-card">' +
            '<div class="voice-top"><button class="play">▶</button>' +
              '<div><h4>' + esc(voice.name || voice.voiceId || voice.id || 'voice') + '</h4>' +
              '<div class="prov">' + esc(voice.voiceId || voice.id || '') + '</div></div></div>' +
            '<div class="voice-desc">' + esc(voice.description || voice.accent || '') + '</div>' +
            '</div>';
        }).join('') + '</div>';
    }).catch(function (err) {
      box.innerHTML = '<div class="card"><div class="empty"><p>' + esc(err.message) + '</p></div></div>';
    });
  }

  // ---------------------------------------------------------------------------
  // Intel schemas - structured extraction
  // ---------------------------------------------------------------------------

  RENDERERS.schemas = function (node) {
    loading(node, 'Loading schemas…');

    api('/v1/observe/schemas').then(function (res) {
      var schemas = res.data || [];
      state.counts.structuredOutput = schemas.length;
      updateCounts();

      if (!schemas.length) {
        node.innerHTML = emptyState(
          'No intel schemas yet',
          'A schema turns every call into structured data - intents, objections, claim details - and sinks it to your CRM. Define the fields once and every matching call is extracted automatically.',
          '+ Create a schema', 'firstSchema');
        var b = $('firstSchema');
        if (b) b.addEventListener('click', openSchemaForm);
        return;
      }

      node.innerHTML =
        '<div class="schema-grid">' + schemas.map(function (s) {
          return '<div class="schema-card">' +
            '<div class="schema-head"><h4>' + esc(s.name) + '</h4>' +
              '<div style="display:flex;gap:6px"><span class="chip teal">EXTRACT</span></div></div>' +
            s.fields.slice(0, 6).map(function (f) {
              return '<div class="fieldrow">' +
                '<span class="fn">' + esc(f.name) + '</span>' +
                '<span class="ft">' + esc(f.type) + (f.required ? ' · required' : '') +
                  (f.enumValues ? ' · enum(' + f.enumValues.length + ')' : '') + '</span>' +
                '</div>';
            }).join('') +
            (s.fields.length > 6
              ? '<div class="fieldrow"><span class="fn muted">+' + (s.fields.length - 6) + ' more</span></div>'
              : '') +
            '<div class="schema-foot"><span>' + s.fieldCount + ' field' + (s.fieldCount === 1 ? '' : 's') + '</span>' +
              '<span>' + esc(fmtDate(s.createdAt)) + '</span></div>' +
            '</div>';
        }).join('') +
        '<button class="schema-card" id="newSchema" style="border-style:dashed;display:flex;align-items:center;justify-content:center;min-height:200px;color:var(--txt-dim);background:none">' +
          '+ New schema</button>' +
        '</div>';

      $('newSchema').addEventListener('click', openSchemaForm);
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load schemas', err.message);
    });
  };

  function openSchemaForm() {
    openDrawer('New intel schema',
      '<div class="field"><label for="scName">Name</label>' +
        '<input id="scName" placeholder="dispute_intake"></div>' +
      '<div class="field"><label for="scDesc">Description</label>' +
        '<input id="scDesc" placeholder="Fields to extract from a card dispute call"></div>' +
      '<div class="field"><label for="scSchema">JSON Schema</label>' +
        '<textarea id="scSchema" style="min-height:220px;font-family:\'IBM Plex Mono\';font-size:.74rem">' +
        esc('{\n  "type": "object",\n  "properties": {\n    "transaction_amount": { "type": "number" },\n    "merchant_category": { "type": "string" },\n    "card_last4": { "type": "string", "description": "Last 4 digits only - never the full PAN" }\n  },\n  "required": ["transaction_amount"]\n}') +
        '</textarea>' +
        '<div class="hint">Extraction runs after each call and the result is attached to the call record.</div></div>',
      '<button class="btn btn-line" data-close>Cancel</button>' +
      '<button class="btn btn-amber" id="scSubmit">Create schema</button>');

    $('scSubmit').addEventListener('click', function () {
      var name = $('scName').value.trim();
      if (!name) return toast('Name required', 'Name the schema.', 'err');
      var schema;
      try { schema = JSON.parse($('scSchema').value); }
      catch (e) { return toast('Invalid JSON', 'The schema is not valid JSON.', 'err'); }

      this.disabled = true;
      api('/v1/structured-outputs', {
        method: 'POST',
        body: { name: name, description: $('scDesc').value.trim() || undefined, schema: schema }
      }).then(function () {
        closeDrawer(); toast('Schema created'); loadCounts(); renderView('schemas');
      }).catch(function (err) { fail(err); $('scSubmit').disabled = false; });
    });
  }

  // ---------------------------------------------------------------------------
  // Access & keys
  // ---------------------------------------------------------------------------

  RENDERERS.access = function (node) {
    loading(node, 'Loading access…');

    api('/v1/observe/access').then(function (a) {
      node.innerHTML =
        '<div class="grid-2">' +
          '<div class="card">' +
            '<div class="card-head"><h3>API keys</h3>' +
              '<span class="meta">least-privilege · scoped · revocable</span></div>' +
            (a.keys.length
              ? a.keys.map(function (k) {
                  var revoked = Boolean(k.revokedAt);
                  return '<div class="key-row"' + (revoked ? ' style="opacity:.5"' : '') + '>' +
                    '<div class="key-ico">🔑</div>' +
                    '<div style="min-width:0;flex:1">' +
                      '<div class="nm">' + esc(k.name) +
                        ' <span class="chip ' + (revoked ? 'red' : 'teal') + '" style="margin-left:5px">' +
                        (revoked ? 'REVOKED' : 'ACTIVE') + '</span></div>' +
                      '<div class="sub">' + esc(k.masked) + ' · ' + esc(k.environment) + '</div>' +
                      '<div class="scopes">' + k.scopes.map(function (s) {
                        return '<span class="chip dim">' + esc(s) + '</span>';
                      }).join('') + '</div>' +
                    '</div>' +
                    '<div class="right">' + (k.lastUsedAt ? 'used ' + esc(timeAgo(k.lastUsedAt)) : 'never used') +
                      '<br>' + esc(fmtDate(k.createdAt)) +
                      (revoked ? '' : '<br><button class="btn btn-line btn-sm" style="margin-top:6px" data-revoke="' + esc(k.id) + '">Revoke</button>') +
                    '</div></div>';
                }).join('')
              : '<div class="empty"><p>No API keys yet.</p></div>') +
            '<div style="padding:11px 16px;font-family:\'IBM Plex Mono\';font-size:.64rem;color:var(--txt-dim)">' +
              'Keys are stored hashed. The plaintext is shown once at creation and never again.</div>' +
          '</div>' +

          '<div>' +
            '<div class="card" style="margin-bottom:12px">' +
              '<div class="card-head"><h3>Team &amp; roles</h3>' +
                '<span class="meta">' + a.members.length + ' member' + (a.members.length === 1 ? '' : 's') + '</span></div>' +
              a.members.map(function (m) {
                var initials = (m.name || m.email).split(/[\s@.]/).filter(Boolean)
                  .slice(0, 2).map(function (s) { return s[0].toUpperCase(); }).join('');
                var chip = m.role === 'owner' ? 'amber' : m.role === 'admin' ? 'teal' : 'dim';
                return '<div class="role-row">' +
                  '<div class="avatar">' + esc(initials) + '</div>' +
                  '<div style="min-width:0"><b style="font-size:.82rem">' + esc(m.name || m.email) + '</b> ' +
                    '<span class="chip ' + chip + '">' + esc(m.role.toUpperCase()) + '</span></div>' +
                  '<span class="mono" style="margin-left:auto;font-size:.62rem;color:var(--txt-dim);flex-shrink:0">' +
                    esc(fmtDate(m.joinedAt)) + '</span></div>';
              }).join('') +
            '</div>' +

            '<div class="card">' +
              '<div class="card-head"><h3>Audit trail</h3><span class="meta">every mutation</span></div>' +
              (a.audit.length
                ? a.audit.slice(0, 12).map(function (r) {
                    return '<div class="audit"><b>' + esc(r.action) + '</b> · ' +
                      esc(r.actor.label || r.actor.type) + ' · ' + esc(timeAgo(r.createdAt)) + '</div>';
                  }).join('')
                : '<div class="empty"><p>No changes recorded yet.</p></div>') +
            '</div>' +
          '</div>' +
        '</div>';

      els('[data-revoke]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Revoke this key? Services using it start receiving 401s immediately.')) return;
          api('/v1/api-keys/' + b.getAttribute('data-revoke'), { method: 'DELETE' })
            .then(function () { toast('Key revoked'); renderView('access'); })
            .catch(fail);
        });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load access', err.message);
    });
  };

  // ---------------------------------------------------------------------------
  // Providers & routing
  // ---------------------------------------------------------------------------

  RENDERERS.providers = function (node) {
    loading(node, 'Loading provider routing…');

    api('/v1/observe/providers').then(function (p) {
      var stages = [
        { key: 'transcriber', label: 'TRANSCRIBE' },
        { key: 'model', label: 'REASONING' },
        { key: 'voice', label: 'VOICE' }
      ];
      var anyRouting = stages.some(function (s) { return (p.routing[s.key] || []).length; });

      node.innerHTML =
        '<div class="card" style="margin-bottom:14px">' +
          '<div class="card-head"><h3>Routing policy</h3>' +
            '<span class="meta">agents reference roles, not vendors - swap without redeploying</span></div>' +
          (anyRouting
            ? stages.map(function (s) {
                var entries = p.routing[s.key] || [];
                if (!entries.length) {
                  return '<div class="route-row"><span class="stage">' + s.label + '</span>' +
                    '<span class="muted" style="font-size:.78rem">Not configured on any agent.</span></div>';
                }
                return entries.map(function (e) {
                  return '<div class="route-row">' +
                    '<span class="stage">' + s.label + '</span>' +
                    '<span class="chip teal">' + esc(e.provider + (e.model ? ' · ' + e.model : '')) + '</span>' +
                    (e.fallback
                      ? '<span class="arrow">→ on failure →</span><span class="chip dim">' + esc(e.fallback) + '</span>'
                      : '<span class="arrow">no failover configured</span>') +
                    '<span class="mono" style="margin-left:auto;font-size:.62rem;color:var(--txt-dim)">' +
                      e.agents + ' agent' + (e.agents === 1 ? '' : 's') + '</span>' +
                    '</div>';
                }).join('');
              }).join('')
            : '<div class="empty"><h4>No routing configured</h4>' +
              '<p>Create an agent to see which providers back each stage of the pipeline.</p></div>') +
        '</div>' +

        '<div class="card" style="margin-bottom:14px">' +
          '<div class="card-head"><h3>Voice provider account</h3>' +
            '<span class="chip ' + (p.mode === 'byo' ? 'teal' : 'dim') + '">' + esc(p.mode) + '</span></div>' +
          kvRow('Mode', p.mode === 'byo' ? 'Your own provider account' : 'Shared VoiceKernel platform account') +
          kvRow('Region', p.organization.region) +
          kvRow('Key', p.organization.provider.keyLast4 ? '••••' + p.organization.provider.keyLast4 : 'platform key') +
          '<div style="padding:13px 16px"><button class="btn btn-line" data-go="settings">Change in Settings</button></div>' +
        '</div>' +

        '<div class="sec-label">Available providers</div>' +
        '<div class="kpis" style="grid-template-columns:repeat(3,1fr)">' +
          kpi('Model providers', String(p.available.models), 'swappable per agent', 'flat') +
          kpi('Voice providers', String(p.available.voices), 'swappable per agent', 'flat') +
          kpi('Transcribers', String(p.available.transcribers), 'swappable per agent', 'flat') +
        '</div>';

      els('[data-go]', node).forEach(function (b) {
        b.addEventListener('click', function () {
          state.settingsTab = 'provider';
          navigate('settings');
        });
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load providers', err.message);
    });
  };

  // ---------------------------------------------------------------------------
  // Simulator
  // ---------------------------------------------------------------------------

  RENDERERS.simulator = function (node) {
    var agentOptions = state.agents.map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.name || a.id) + '</option>';
    }).join('');

    node.innerHTML =
      '<div class="grid-2">' +
        '<div class="card">' +
          '<div class="card-head"><h3>Simulate a conversation</h3>' +
            '<span class="meta">text-mode, no telephony required</span></div>' +
          '<div class="card-body">' +
            '<div class="field"><label for="simAgent">Agent</label>' +
              '<select id="simAgent">' + (agentOptions || '<option value="">No agents yet</option>') + '</select></div>' +
            '<div class="field"><label for="simInput">What the caller says</label>' +
              '<textarea id="simInput" style="min-height:90px" placeholder="There\'s a $249 charge I don\'t recognise from this morning."></textarea></div>' +
            '<button class="btn btn-teal" id="simRun" style="width:100%">Run simulation</button>' +
            '<p class="muted" style="font-size:.75rem;margin-top:10px">Runs the agent\'s prompt and model over text through the provider\'s chat API - the same reasoning path a call takes, without dialling anyone.</p>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><h3>Transcript</h3><span class="meta" id="simMeta"></span></div>' +
          '<div class="test-log" id="simLog">' +
            '<div class="empty"><p>Run a simulation to see the agent respond.</p></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    $('simRun').addEventListener('click', runSimulation);
  };

  function runSimulation() {
    if (state.view !== 'simulator') return navigate('simulator');

    var agentId = $('simAgent') ? $('simAgent').value : '';
    var input = $('simInput') ? $('simInput').value.trim() : '';
    if (!agentId) return toast('No agent', 'Create an agent first.', 'err');
    if (!input) return toast('Nothing to say', 'Enter what the caller says.', 'err');

    var log = $('simLog');
    var btn = $('simRun');
    btn.disabled = true;
    btn.textContent = 'Running…';
    log.innerHTML = '<div class="empty"><span class="spinner"></span></div>';

    var started = Date.now();
    api('/v1/chats', { method: 'POST', body: { assistantId: agentId, input: input } })
      .then(function (chat) {
        var elapsed = Date.now() - started;
        var output = chat.output || chat.messages || [];
        var replies = Array.isArray(output) ? output : [output];

        log.innerHTML =
          '<div class="tline"><span class="tag caller">Caller</span><p>' + esc(input) + '</p></div>' +
          replies.map(function (m) {
            var text = typeof m === 'string' ? m : (m.content || m.message || JSON.stringify(m));
            return '<div class="tline"><span class="tag agent">Agent</span><p>' + esc(text) + '</p></div>';
          }).join('');
        $('simMeta').textContent = elapsed + 'ms';
      })
      .catch(function (err) {
        log.innerHTML = '<div class="empty"><h4>Simulation failed</h4><p>' + esc(err.message) + '</p></div>';
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Run simulation';
      });
  }

  // ---------------------------------------------------------------------------
  // Number detail
  // ---------------------------------------------------------------------------

  function openNumberDetail(id) {
    state.number = { id: id };
    navigate('numberDetail');
  }

  RENDERERS.numberDetail = function (node) {
    if (!state.number) {
      node.innerHTML = emptyState('No number selected', 'Pick a number from Numbers & trunks.');
      return;
    }
    loading(node, 'Loading number…');

    var id = state.number.id;
    Promise.all([
      api('/v1/phone-numbers/' + encodeURIComponent(id)),
      api('/v1/phone-numbers/' + encodeURIComponent(id) + '/health').catch(function () { return null; }),
      api('/v1/phone-numbers/' + encodeURIComponent(id) + '/events').catch(function () { return null; })
    ]).then(function (r) {
      var num = r[0] || {};
      var health = r[1];
      var events = (r[2] && r[2].data) || [];
      state.number = { id: id, data: num };

      var agentOptions = state.agents.map(function (a) {
        return '<option value="' + esc(a.id) + '"' +
          (a.id === num.assistantId ? ' selected' : '') + '>' + esc(a.name || a.id) + '</option>';
      }).join('');

      node.innerHTML =
        '<div class="row" style="margin-bottom:14px;flex-wrap:wrap">' +
          '<button class="btn btn-line btn-sm" data-go="numbers">← All numbers</button>' +
          '<span class="mono" style="font-size:.9rem;color:var(--txt)">' + esc(num.number || num.name || id) + '</span>' +
          (health
            ? '<span class="chip ' + (health.status === 'ok' ? 'teal' : health.status === 'no_traffic' ? 'dim' : 'amber') + '">' +
              esc(health.status.replace('_', ' ').toUpperCase()) + '</span>'
            : '') +
          '<span class="chip dim">' + esc((num.provider || 'unknown').toUpperCase()) + '</span>' +
        '</div>' +

        '<div class="grid-2">' +
          '<div>' +
            '<div class="card" style="margin-bottom:12px">' +
              '<div class="card-head"><h3>Inbound routing</h3>' +
                '<span class="meta">where calls to this number go</span></div>' +
              '<div class="chain">' +
                '<div class="chain-row"><span class="when">All inbound calls</span>' +
                  '<span class="arrow">→</span>' +
                  (num.assistantId
                    ? '<span class="chip amber">' + esc(agentNameFor(num.assistantId)) + '</span>'
                    : num.squadId
                      ? '<span class="chip blue">squad ' + esc(num.squadId.slice(0, 12)) + '</span>'
                      : '<span class="chip dim">no agent assigned</span>') +
                '</div>' +
                '<div class="chain-row"><span class="when">Events</span><span class="arrow">→</span>' +
                  '<span class="chip teal">VoiceKernel webhook pipeline</span>' +
                  '<span class="mono" style="font-size:.62rem;color:var(--txt-dim)">signed · retried · replayable</span>' +
                '</div>' +
                '<div class="chain-row"><span class="when">Fallback</span><span class="arrow">→</span>' +
                  (num.fallbackDestination
                    ? '<span class="chip teal">' + esc(JSON.stringify(num.fallbackDestination).slice(0, 60)) + '</span>'
                    : '<span class="chip dim">none configured</span>') +
                '</div>' +
              '</div>' +
              '<div class="card-body" style="border-top:1px solid var(--line-soft)">' +
                '<div class="field"><label for="ndAgent">Route inbound to</label>' +
                  '<select id="ndAgent"><option value="">No agent - handle via webhook</option>' + agentOptions + '</select></div>' +
                '<div class="field" style="margin-bottom:0"><label for="ndLabel">Label</label>' +
                  '<input id="ndLabel" value="' + esc(num.name || '') + '" placeholder="Disputes main"></div>' +
              '</div>' +
            '</div>' +

            '<div class="card">' +
              '<div class="card-head"><h3>Events</h3>' +
                '<span class="meta">signed HMAC · retries · replay-protected</span></div>' +
              (events.length
                ? events.slice(0, 8).map(function (d) {
                    var ok = d.status === 'succeeded';
                    return '<div class="webhook-log">' +
                      '<span><b>' + esc(d.eventType) + '</b></span>' +
                      '<span style="color:' + (ok ? 'var(--teal)' : 'var(--amber)') + '">' +
                        esc((d.responseStatus || d.status) + ' · ' + timeAgo(d.createdAt)) + '</span>' +
                      '</div>';
                  }).join('')
                : '<div class="empty"><p>No event deliveries yet. Register an endpoint under Webhooks.</p></div>') +
            '</div>' +
          '</div>' +

          '<div>' +
            '<div class="card" style="margin-bottom:12px">' +
              '<div class="card-head"><h3>Number</h3></div>' +
              kvRow('Number', num.number || '-') +
              kvRow('Provider', num.provider || '-') +
              kvRow('ID', id) +
              kvRow('Created', fmtDate(num.createdAt)) +
            '</div>' +

            '<div class="card" style="margin-bottom:12px">' +
              '<div class="card-head"><h3>Health · 24h</h3></div>' +
              (health
                ? kvRow('Calls', fmtNum(health.calls.total)) +
                  kvRow('Answered', fmtNum(health.calls.answered) +
                    (health.calls.answerRate !== null ? ' · ' + fmtPct(health.calls.answerRate) : '')) +
                  kvRow('Inbound / outbound', health.calls.inbound + ' / ' + health.calls.outbound) +
                  kvRow('Failed', fmtNum(health.calls.failed)) +
                  kvRow('Median latency', health.medianTurnLatencyMs === null ? 'not measured' : health.medianTurnLatencyMs + 'ms') +
                  kvRow('Cost', fmtMoney(health.cost))
                : '<div class="empty"><p>No health data.</p></div>') +
            '</div>' +

            '<div class="card">' +
              '<div class="card-head"><h3>Compliance on this line</h3></div>' +
              kvRow('Region', (state.org && state.org.region) || '-') +
              kvRow('Recording', num.assistantId ? 'per agent configuration' : 'not applicable') +
              kvRow('PCI redaction', 'set on the agent · compliancePlan') +
              '<div style="padding:13px 16px"><button class="btn btn-red btn-sm" id="ndDelete">Release number</button></div>' +
            '</div>' +
          '</div>' +
        '</div>';

      els('[data-go]', node).forEach(function (b) {
        b.addEventListener('click', function () { navigate(b.getAttribute('data-go')); });
      });

      $('ndDelete').addEventListener('click', function () {
        if (!confirm('Release this number? Inbound calls to it will stop being answered.')) return;
        api('/v1/phone-numbers/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function () {
            toast('Number released');
            state.number = null;
            loadCounts();
            navigate('numbers');
          }).catch(fail);
      });
    }).catch(function (err) {
      node.innerHTML = emptyState('Could not load number', err.message);
    });
  };

  function saveNumber() {
    if (!state.number) return;
    var body = {};
    if ($('ndAgent')) body.assistantId = $('ndAgent').value || null;
    if ($('ndLabel')) body.name = $('ndLabel').value.trim() || undefined;

    var btn = $('primaryAction');
    btn.disabled = true;
    api('/v1/phone-numbers/' + encodeURIComponent(state.number.id), { method: 'PATCH', body: body })
      .then(function () { toast('Number saved'); renderView('numberDetail'); })
      .catch(fail)
      .then(function () { btn.disabled = false; });
  }

  // ---------------------------------------------------------------------------
  // Theme
  //
  // Three states, not two: light, dark, and "match system". The third matters
  // because a user who has not chosen should keep following their OS when it
  // switches at sunset - collapsing that into a boolean silently freezes them
  // on whatever the OS happened to be the first time they loaded the page.
  // ---------------------------------------------------------------------------

  var THEME_KEY = 'vk-theme';

  /**
   * The theme actually on screen.
   *
   * With no stored preference there is no data-theme attribute and the OS
   * decides through prefers-color-scheme, so the effective theme has to be read
   * from the media query rather than assumed.
   */
  function effectiveTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }

    var button = $('themeToggle');
    if (button) {
      button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      button.setAttribute('title', theme === 'dark' ? 'Light theme' : 'Dark theme');
    }

    var meta = el('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0A1220' : '#F4F7F9');

    // Charts read computed custom properties when they render, so the current
    // view has to be redrawn to pick up the new palette.
    if (state.user && state.view) renderView(state.view);
  }

  function wireTheme() {
    var button = $('themeToggle');
    if (!button) return;

    // Label only on load: writing the attribute here would stop the OS being
    // followed for a visitor who has never chosen.
    var current = effectiveTheme();
    button.setAttribute('aria-label', current === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');

    button.addEventListener('click', function () {
      applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
    });
  }

  // ---------------------------------------------------------------------------
  // Mobile navigation
  //
  // Below 760px the sidebar is off-canvas. It has to close on navigation, or a
  // tap on a nav item would leave the menu covering the view it just opened.
  // ---------------------------------------------------------------------------

  function setSidebar(open) {
    var side = $('sidebar');
    var backdrop = $('sideBackdrop');
    var toggle = $('navToggle');
    if (!side) return;
    side.classList.toggle('open', open);
    if (backdrop) backdrop.classList.toggle('open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
  }

  function wireMobileNav() {
    var toggle = $('navToggle');
    var backdrop = $('sideBackdrop');
    if (toggle) {
      toggle.addEventListener('click', function () {
        setSidebar(!$('sidebar').classList.contains('open'));
      });
    }
    if (backdrop) backdrop.addEventListener('click', function () { setSidebar(false); });
  }

  // ---------------------------------------------------------------------------
  // Chrome
  // ---------------------------------------------------------------------------

  function renderOrgChrome() {
    var org = state.org || {};
    $('orgName').textContent = org.name || '-';
    $('orgEnv').textContent = (org.region || '').toUpperCase() || 'PROD';

    var provider = org.provider || {};
    var healthy = provider.mode === 'byo' || provider.platformKeyAvailable;
    $('statusPill').className = 'pill' + (healthy ? '' : ' warn');
    $('statusText').textContent = healthy
      ? 'Connected · ' + (provider.mode === 'byo' ? 'own provider account' : 'platform account')
      : 'No voice provider configured';
  }

  function updateCounts() {
    els('[data-count]').forEach(function (node) {
      var key = node.getAttribute('data-count');
      var value = key === 'calls' ? (state.overview && state.overview.calls.inProgress) : state.counts[key];
      node.textContent = value ? String(value) : '';
    });
  }

  function loadCounts() {
    return api('/v1/organization').then(function (org) {
      state.org = org;
      state.counts = org.resources || {};
      renderOrgChrome();
      updateCounts();
    }).catch(function () { /* chrome is best-effort */ });
  }

  function loadUsageStrip() {
    return api('/v1/analytics/overview').then(function (ov) {
      state.overview = ov;
      var quota = 120000;
      var pct = Math.min(100, (ov.minutes.total / quota) * 100);
      $('usageBar').style.width = pct + '%';
      $('usageText').innerHTML = fmtNum(ov.minutes.total, 0) + ' / ' + fmtNum(quota) + ' min ' +
        '<span style="color:var(--teal)">· ' + pct.toFixed(0) + '%</span>';
      updateCounts();
    }).catch(function () { /* strip is best-effort */ });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function boot() {
    return api('/auth/me').then(function (me) {
      state.user = me.user;
      state.org = me.organization;
      state.role = me.role;
      hideAuth();
      renderOrgChrome();
      // Only once a session exists: the stream authenticates with the same
      // cookie, so opening it earlier would just 401 and back off.
      startLive();

      // Agent names decorate call and campaign tables, so load them once up
      // front rather than per view.
      return Promise.all([
        api('/v1/agents?limit=100').then(function (r) { state.agents = r.data || []; }).catch(function () {}),
        loadCounts(),
        loadUsageStrip()
      ]);
    }).then(function () {
      var target = (location.hash || '#overview').slice(1).split('/');
      var view = target[0];
      var id = target[1];

      if (view === 'inspector' && id) state.inspecting = { id: id };
      if (view === 'editor' && id) {
        state.editing = state.agents.filter(function (a) { return a.id === id; })[0] || null;
      }
      navigate(VIEWS.indexOf(view) !== -1 ? view : 'overview', { silent: true });
    }).catch(function (err) {
      if (err && err.status === 401) showAuth();
      else {
        showAuth();
        var box = $('authErr');
        box.textContent = err.message || 'Could not reach the API.';
        box.classList.remove('hidden');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    wireTheme();
    wireMobileNav();
    setAuthMode('login');
    $('authForm').addEventListener('submit', submitAuth);
    $('authSwitch').addEventListener('click', function () {
      setAuthMode(authMode === 'login' ? 'signup' : 'login');
    });

    els('.nav-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigate(btn.getAttribute('data-view'));
      });
    });

    $('primaryAction').addEventListener('click', primaryAction);
    $('refreshBtn').addEventListener('click', function () {
      loadCounts();
      loadUsageStrip();
      renderView(state.view);
      toast('Refreshed');
    });

    $('signOut').addEventListener('click', function () {
      api('/auth/logout', { method: 'POST' }).then(function () {
        state.user = null;
        showAuth();
      }).catch(fail);
    });

    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerVeil').addEventListener('click', closeDrawer);

    // Delegated so drawers can render their own close buttons.
    document.addEventListener('click', function (e) {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-close')) closeDrawer();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        $('cmdk').click();
      }
    });

    $('cmdk').addEventListener('click', function () {
      var target = prompt('Jump to view:\n' + VIEWS.join(', '));
      if (target && VIEWS.indexOf(target.trim()) !== -1) navigate(target.trim());
    });

    $('orgSwitch').addEventListener('click', function () { navigate('settings'); });


    boot();
  });


  // ---- Live updates --------------------------------------------------------
  //
  // The API already knows about a call the moment the provider tells it; the
  // console just had no way to hear. An EventSource carries the fact that
  // something changed, and the view refetches through the normal endpoints -
  // the stream deliberately carries no data of its own.

  var live = { source: null, timer: null, connected: false };

  // Views that show data the provider can change underneath the operator.
  // Deliberately excludes the editor and the wizards: re-rendering a form
  // mid-edit would discard whatever the user had typed.
  var LIVE_VIEWS = ['overview', 'calls', 'inspector', 'analytics', 'monitoring', 'numbers', 'campaigns'];

  function startLive() {
    if (!window.EventSource || live.source) return;

    var src = new EventSource('/v1/events/stream', { withCredentials: true });
    live.source = src;

    src.addEventListener('ready', function () {
      live.connected = true;
      setLiveIndicator(true);
    });

    // Every named event lands here; the payload only identifies what changed.
    src.onmessage = onLiveEvent;
    ['call.status-update', 'call.ended', 'call.updated', 'call.transcript', 'tool.called']
      .forEach(function (type) { src.addEventListener(type, onLiveEvent); });

    src.onerror = function () {
      // EventSource reconnects on its own; reflect the gap rather than tearing
      // it down, or a brief blip would leave the console permanently static.
      live.connected = false;
      setLiveIndicator(false);
    };
  }

  function onLiveEvent() {
    if (LIVE_VIEWS.indexOf(state.view) === -1) return;
    // A call generates a burst of events; refresh once when it settles rather
    // than re-rendering the table per transcript line.
    clearTimeout(live.timer);
    live.timer = setTimeout(function () {
      renderView(state.view);
      loadCounts();
    }, 700);
  }

  function setLiveIndicator(on) {
    var el = $('liveDot');
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.title = on ? 'Live - updates arrive as they happen' : 'Reconnecting...';
  }

  // ---- In-browser test call ------------------------------------------------
  //
  // The panel lives on <body> rather than inside the view container, because
  // views re-render wholesale via innerHTML. A re-render mid-call would tear
  // out the panel while the call carried on underneath, invisibly.

  var talk = { session: null, lines: [], status: 'idle', callId: null, agentName: '' };

  function micIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4" stroke-linecap="round"/></svg>';
  }

  function toggleTalk(agent) {
    if (talk.session && talk.session.isActive()) {
      talk.session.stop();
      return;
    }
    startTalk(agent);
  }

  function startTalk(agent) {
    if (!window.VKTalk) {
      toast('Cannot start call', 'The call module did not load. Reload the console.', 'err');
      return;
    }

    talk.lines = [];
    talk.callId = null;
    talk.status = 'connecting';
    talk.agentName = agent.name || 'Agent';
    renderTalk();

    talk.session = window.VKTalk.start({
      agentId: agent.id,
      onEvent: function (name, payload) {
        if (name === 'created') { talk.callId = payload.id; }
        else if (name === 'connected') { talk.status = 'live'; }
        else if (name === 'transcript') { applyTranscript(payload); }
        else if (name === 'status') {
          if (payload.status === 'ended') {
            talk.status = 'ended';
            talk.endedReason = payload.reason;
          }
        } else if (name === 'ended') {
          talk.status = 'ended';
          if (!talk.endedReason) talk.endedReason = payload.reason;
        } else if (name === 'error') {
          talk.status = 'error';
          talk.error = payload.message;
        }
        renderTalk();
        syncTalkButton();
      },
    });

    syncTalkButton();
  }

  /**
   * Partial transcripts arrive repeatedly for the same utterance. Replacing
   * the trailing partial for that speaker - rather than appending - is what
   * keeps the panel from filling with half-sentences.
   */
  function applyTranscript(t) {
    var last = talk.lines[talk.lines.length - 1];
    if (last && !last.final && last.role === t.role) {
      last.text = t.text;
      last.final = t.final;
      return;
    }
    talk.lines.push({ role: t.role, text: t.text, final: t.final });
  }

  function syncTalkButton() {
    var btn = $('agTalk');
    if (!btn) return;
    var active = talk.session && talk.session.isActive();
    btn.classList.toggle('on', !!active);
    btn.innerHTML = micIcon() + (active ? 'End' : 'Talk');
  }

  function talkNode() {
    var node = $('talkPanel');
    if (node) return node;
    node = document.createElement('div');
    node.id = 'talkPanel';
    node.className = 'talk-panel';
    document.body.appendChild(node);
    return node;
  }

  function renderTalk() {
    var node = talkNode();

    var label = talk.status === 'connecting' ? 'Connecting'
      : talk.status === 'live' ? 'Live'
      : talk.status === 'ended' ? 'Ended'
      : talk.status === 'error' ? 'Failed' : 'Idle';

    var body;
    if (talk.status === 'error') {
      body = '<div class="talk-error">' + esc(talk.error || 'The call failed.') + '</div>';
    } else if (!talk.lines.length) {
      body = '<div class="talk-empty">' +
        (talk.status === 'connecting'
          ? 'Allow microphone access when your browser asks.'
          : talk.status === 'live' ? 'Listening. Say something.' : 'The call ended with nothing transcribed.') +
        '</div>';
    } else {
      body = talk.lines.map(function (l) {
        return '<div class="talk-line ' + (l.role === 'assistant' ? 'from-agent' : 'from-you') + '">' +
          '<span class="talk-who">' + (l.role === 'assistant' ? esc(talk.agentName) : 'You') + '</span>' +
          '<div class="talk-bubble' + (l.final ? '' : ' partial') + '">' + esc(l.text) + '</div>' +
        '</div>';
      }).join('');
    }

    node.innerHTML =
      '<div class="talk-head">' +
        '<span class="talk-status ' + talk.status + '">' + esc(label) + '</span>' +
        '<strong>Transcript</strong>' +
        '<button class="talk-close" id="talkClose" type="button" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="talk-body" id="talkBody">' + body + '</div>' +
      '<div class="talk-foot">' +
        (talk.callId ? '<button class="link" id="talkLogs">View call logs</button>' : '<span></span>') +
        (talk.session && talk.session.isActive()
          ? '<button class="btn btn-red btn-sm" id="talkEnd" type="button">End call</button>'
          : '') +
      '</div>';

    node.classList.add('open');

    var b = $('talkBody');
    if (b) b.scrollTop = b.scrollHeight;

    $('talkClose').addEventListener('click', function () {
      if (talk.session && talk.session.isActive()) talk.session.stop();
      node.classList.remove('open');
    });
    var end = $('talkEnd');
    if (end) end.addEventListener('click', function () { talk.session.stop(); });
    var logs = $('talkLogs');
    if (logs) logs.addEventListener('click', function () { openInspector(talk.callId); });
  }

})();
