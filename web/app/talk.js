/* ===========================================================================
   In-browser test calls
   ---------------------------------------------------------------------------
   Lets an operator speak to an agent from the console instead of dialling it,
   which is the difference between "the prompt looks right" and "the prompt
   sounds right". Interruptions, pace and the first message are the things you
   cannot review by reading.

   Audio goes browser <-> media vendor directly over WebRTC. It does not
   transit VoiceKernel: there is no relay to scale, and no point at which we
   hold a recording nobody asked us to hold.

   Deliberately self-contained. app.js is one long IIFE, and reaching into it
   for `api()` would mean exporting its internals to get a feature that only
   needs fetch and an <audio> element.
   =========================================================================== */
(function () {
  'use strict';

  // The WebRTC client is 265 KB and most console sessions never place a call,
  // so it is fetched on first use rather than on every page load.
  var BUNDLE = '/assets/webrtc.js';
  var loader = null;

  function loadClient() {
    if (window.Daily) return Promise.resolve(window.Daily);
    if (loader) return loader;

    loader = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = BUNDLE;
      el.async = true;
      el.onload = function () {
        if (window.Daily) resolve(window.Daily);
        // A 200 that is not the bundle (an SPA fallback page, say) loads
        // without error and leaves no global behind.
        else reject(new Error('The call client loaded but did not initialise.'));
      };
      el.onerror = function () {
        loader = null; // let a later attempt retry rather than reusing the failure
        reject(new Error('Could not load the call client from ' + BUNDLE + '.'));
      };
      document.head.appendChild(el);
    });

    return loader;
  }

  /**
   * Everything the upstream tells us mid-call arrives as a Daily app-message.
   * The shapes are the provider's, so each is read defensively: an unfamiliar
   * message is ignored rather than allowed to throw inside an event handler
   * where it would kill the rest of the call's updates.
   */
  function readMessage(data, emit) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'transcript' && typeof data.transcript === 'string') {
      emit('transcript', {
        role: data.role === 'assistant' ? 'assistant' : 'user',
        text: data.transcript,
        // Partials are the live caption; finals are the record. Rendering both
        // the same way makes the transcript flicker and duplicate.
        final: data.transcriptType === 'final',
      });
      return;
    }

    if (data.type === 'speech-update' && data.role) {
      emit('speaking', { role: data.role, on: data.status === 'started' });
      return;
    }

    if (data.type === 'status-update' && data.status) {
      emit('status', { status: data.status, reason: data.endedReason || null });
      return;
    }

    if (data.type === 'conversation-update' && Array.isArray(data.messages)) {
      emit('conversation', { messages: data.messages });
    }
  }

  /**
   * Starts a call and returns a handle with .stop().
   *
   * `onEvent(name, payload)` receives: connecting, connected, transcript,
   * speaking, status, conversation, ended, error.
   */
  function start(options) {
    options = options || {};
    var emit = typeof options.onEvent === 'function' ? options.onEvent : function () {};

    var call = null;
    var audioEl = null;
    var stopped = false;

    function cleanup() {
      if (audioEl) {
        audioEl.pause();
        audioEl.srcObject = null;
        if (audioEl.parentNode) audioEl.parentNode.removeChild(audioEl);
        audioEl = null;
      }
      if (call) {
        try { call.destroy(); } catch (e) { /* already torn down */ }
        call = null;
      }
    }

    function fail(err) {
      if (stopped) return;
      stopped = true;
      cleanup();
      emit('error', { message: err && err.message ? err.message : String(err) });
    }

    emit('connecting', {});

    var body = { };
    if (options.agentId) body.agentId = options.agentId;
    if (options.agent) body.agent = options.agent;
    if (options.assistantOverrides) body.assistantOverrides = options.assistantOverrides;

    var handle = {
      stop: function () {
        if (stopped) return;
        stopped = true;
        // Leave before destroy so the far end sees a clean hangup rather than
        // a timeout, which is what decides whether the call is billed as
        // ended-by-customer or as a failure.
        var leaving = call ? call.leave() : Promise.resolve();
        Promise.resolve(leaving).catch(function () {}).then(function () {
          cleanup();
          emit('ended', { reason: 'stopped-by-operator' });
        });
      },
      isActive: function () { return !stopped; },
    };

    fetch('/v1/calls/web', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().then(function (payload) {
          if (!res.ok) {
            var err = payload && payload.error ? payload.error : {};
            throw new Error(err.message || 'Could not start the call (HTTP ' + res.status + ').');
          }
          return payload;
        });
      })
      .then(function (payload) {
        if (stopped) return null;
        if (!payload.callUrl) throw new Error('The API did not return a room to join.');
        emit('created', { id: payload.id });
        return loadClient().then(function (Daily) {
          return { Daily: Daily, payload: payload };
        });
      })
      .then(function (ctx) {
        if (!ctx || stopped) return;

        call = ctx.Daily.createCallObject({
          // Audio only. Asking for a camera would prompt for it, and a webcam
          // permission dialog on a voice test reads as a bug.
          audioSource: true,
          videoSource: false,
          // The client fetches a second bundle at join time and, by default,
          // evaluates it as a string - which needs 'unsafe-eval' in the page's
          // CSP. Set in both positions because the option has moved between
          // versions and the loader silently falls back to eval when it does
          // not find it.
          avoidEval: true,
          dailyConfig: { avoidEval: true },
        });

        // The call object does not render media; remote audio has to be
        // attached to an element or the agent speaks into nothing.
        call.on('track-started', function (ev) {
          if (!ev || !ev.track || ev.track.kind !== 'audio') return;
          if (ev.participant && ev.participant.local) return;

          audioEl = document.createElement('audio');
          audioEl.autoplay = true;
          audioEl.srcObject = new MediaStream([ev.track]);
          document.body.appendChild(audioEl);
          // Autoplay can still be refused; the click that started the call is
          // usually enough to satisfy it, so this is a fallback not a promise.
          var played = audioEl.play();
          if (played && played.catch) {
            played.catch(function () {
              emit('error', { message: 'The browser blocked audio playback. Click the page and try again.' });
            });
          }
        });

        call.on('app-message', function (ev) { readMessage(ev && ev.message, emit); });

        call.on('left-meeting', function () {
          if (stopped) return;
          stopped = true;
          cleanup();
          emit('ended', { reason: 'left-meeting' });
        });

        call.on('error', function (ev) {
          fail(new Error((ev && ev.errorMsg) || 'The call dropped.'));
        });

        return call.join({ url: ctx.payload.callUrl }).then(function () {
          if (stopped) return;
          emit('connected', { id: ctx.payload.id });
        });
      })
      .catch(fail);

    return handle;
  }

  window.VKTalk = { start: start };
})();
