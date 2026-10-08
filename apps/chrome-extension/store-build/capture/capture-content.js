// Starts a capture on the current LinkedIn page when the user asks for one from the Skout
// side panel. Nothing runs on page load except the restriction check below.
(() => {
  if (globalThis.__SKOUT_CAPTURE_CONTENT__) return;
  globalThis.__SKOUT_CAPTURE_CONTENT__ = true;

  function pageKind() {
    const path = location.pathname;
    if (path.startsWith('/in/')) return 'person';
    if (path.startsWith('/company/')) return 'company';
    if (path.startsWith('/sales/search/people')) return 'sales';
    return null;
  }

  const reportRestriction = () => {
    const reason = globalThis.SkoutCaptureRestriction?.detect();
    if (reason) Promise.resolve(chrome.runtime.sendMessage({ type: 'SKOUT_CAPTURE_RESTRICTION', reason, url: location.href })).catch(() => {});
    return reason;
  };

  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (request.type === 'SKOUT_CAPTURE_PAGE_KIND') {
      respond({ ok: true, kind: pageKind(), url: location.href.split('?')[0] });
      return;
    }
    if (request.type !== 'SKOUT_CAPTURE_START') return;
    const kind = pageKind();
    if (!kind || (request.kind && request.kind !== kind)) {
      respond({ ok: false, error: 'Open a LinkedIn profile, company page or Sales Navigator people search, then start the capture.' });
      return;
    }
    const restriction = reportRestriction();
    if (restriction) {
      respond({ ok: false, error: `${restriction} Capture was not started.` });
      return;
    }
    if (globalThis.SkoutCaptureUi.isActive()) {
      respond({ ok: false, error: 'A capture is already running on this page.' });
      return;
    }
    if (kind === 'person') globalThis.SkoutPersonCapture.start();
    else if (kind === 'company') globalThis.SkoutCompanyCapture.start(request.options || { includeCompany: true, includePeople: true });
    else globalThis.SkoutSalesNavigatorCapture.start();
    respond({ ok: true, kind });
  });

  // A temporary reader tab that lands on a LinkedIn warning stops the whole capture.
  reportRestriction();
})();
