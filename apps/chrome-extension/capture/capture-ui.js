// Bridge between the page-side capture readers and the Skout side panel. The readers report
// progress and hand over a draft for review; nothing is saved until the user sends it from
// the side panel.
(() => {
  if (globalThis.SkoutCaptureUi) return;
  const send = (message) => {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  };
  let active = null;

  function progress(kind) {
    const state = { stopped: false, handlers: [] };
    const api = {
      set(text) {
        send({ type: 'SKOUT_CAPTURE_PROGRESS', kind, text, active: true });
        const reason = globalThis.SkoutCaptureRestriction?.detect();
        if (reason && !state.stopped) {
          send({ type: 'SKOUT_CAPTURE_RESTRICTION', reason, url: location.href });
          api.stop();
        }
      },
      get stopped() {
        return state.stopped;
      },
      onStop(handler) {
        state.handlers.push(handler);
      },
      stop() {
        if (state.stopped) return;
        state.stopped = true;
        for (const handler of state.handlers) {
          try {
            handler();
          } catch {
            // A stop handler must never block the others.
          }
        }
      },
      done(text, isError = false) {
        if (active === api) active = null;
        send({ type: 'SKOUT_CAPTURE_PROGRESS', kind, text: text || '', active: false, isError });
      },
    };
    active = api;
    return api;
  }

  /** Hands a draft to the side panel for review. `notes` are shown next to it, never saved. */
  function review(kind, data, notes = []) {
    return send({
      type: 'SKOUT_CAPTURE_REVIEW',
      kind,
      data,
      notes,
      sourceUrl: location.href.split('?')[0],
      capturedAt: new Date().toISOString(),
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, respond) => {
      if (sender.id !== chrome.runtime.id || request.type !== 'SKOUT_CAPTURE_STOP') return;
      const wasActive = !!active;
      active?.stop();
      respond({ ok: true, wasActive });
    });
  }

  globalThis.SkoutCaptureUi = { progress, review, isActive: () => !!active };
})();
