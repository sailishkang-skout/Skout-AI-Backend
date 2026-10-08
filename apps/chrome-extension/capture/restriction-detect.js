// Detects a LinkedIn warning, verification or restriction that is rendered on the current
// page. Capture stops as soon as one is seen; nothing here tries to dismiss or work around it.
globalThis.SkoutCaptureRestriction = (() => {
  const PATH_PATTERNS = [/^\/checkpoint\//i, /^\/authwall/i, /^\/uas\/login/i, /\/captcha/i, /^\/sales\/restricted/i];
  const TEXT_PATTERNS = [
    [/you(?:'|’)ve reached the (?:weekly |monthly )?(?:commercial use|search|invitation|profile view) limit/i, 'LinkedIn reported a usage limit.'],
    [/commercial use limit/i, 'LinkedIn reported the commercial use limit.'],
    [/unusual activity/i, 'LinkedIn reported unusual activity on this account.'],
    [/(?:account|access)(?: has been| is)? (?:temporarily )?restricted/i, 'LinkedIn reported an account restriction.'],
    [/we(?:'|’)ve restricted your account/i, 'LinkedIn reported an account restriction.'],
    [/temporarily (?:restricted|limited|blocked)/i, 'LinkedIn reported a temporary restriction.'],
    [/(?:quick )?security (?:check|verification)/i, 'LinkedIn asked for a security verification.'],
    [/automated (?:activity|behavior|behaviour|tools?)/i, 'LinkedIn warned about automated activity.'],
    [/prohibited (?:software|extensions?)/i, 'LinkedIn warned about prohibited software or extensions.'],
    [/too many requests/i, 'LinkedIn reported too many requests.'],
  ];
  // Only LinkedIn's own notices are read: a profile that merely mentions one of these phrases
  // in its About text must not stop a capture.
  const NOTICE_SELECTOR =
    '[role="alert"], [role="alertdialog"], [role="dialog"], .artdeco-toast-item, .artdeco-modal, .artdeco-inline-feedback, main h1';

  function reasonForText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    for (const [pattern, reason] of TEXT_PATTERNS) if (pattern.test(text)) return reason;
    return null;
  }

  function detect(doc = document, loc = location) {
    if (PATH_PATTERNS.some((pattern) => pattern.test(loc.pathname || ''))) {
      return 'LinkedIn redirected to a sign-in, verification or restriction page.';
    }
    for (const node of doc.querySelectorAll(NOTICE_SELECTOR)) {
      const reason = reasonForText(node.textContent);
      if (reason) return reason;
    }
    return null;
  }

  return { detect, reasonForText };
})();
