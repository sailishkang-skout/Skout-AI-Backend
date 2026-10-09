// lib/extract-common.js
//
// Pure DOM-reading helpers. Nothing here makes network requests, clicks
// anything, scrolls, or navigates — it only reads text/attributes that
// are already rendered in the page the human has open.
//
// LinkedIn's class names are auto-generated and change periodically.
// These selectors are written defensively (multiple fallback selectors
// per field) but will need occasional maintenance — see README.md
// "Keeping selectors up to date".

window.SkoutCaptureExtract = (function () {
  function text(el) {
    return el ? el.textContent.trim().replace(/\s+/g, ' ') : undefined;
  }

  function firstMatch(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return undefined;
  }

  function allMatches(selectors) {
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length) return Array.from(els);
    }
    return [];
  }

  function metaContent(name) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') || undefined : undefined;
  }

  /** Pulls the LinkedIn publicId (the /in/xxxxx or /company/xxxxx slug) from the URL. */
  function publicIdFromUrl(kind) {
    const path = window.location.pathname; // e.g. /in/jane-doe-3b2a1/ or /company/acme-corp/
    const marker = kind === 'person' ? '/in/' : '/company/';
    const idx = path.indexOf(marker);
    if (idx === -1) return undefined;
    const rest = path.slice(idx + marker.length);
    return rest.split('/')[0] || undefined;
  }

  /**
   * Like text(), but preserves <br> line breaks instead of collapsing
   * them into a single space. Needed for feed post bodies, which use
   * literal <br> tags between paragraphs rather than nested block
   * elements.
   */
  function textMultiline(el) {
    if (!el) return undefined;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    const raw = clone.textContent || '';
    return raw
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || undefined;
  }

  /** Best-effort integer parse from strings like "1,204 followers" or "500+ connections". */
  function parseCount(str) {
    if (!str) return undefined;
    const cleaned = str.replace(/,/g, '').match(/[\d.]+([KkMm])?/);
    if (!cleaned) return undefined;
    let [num, suffix] = [parseFloat(cleaned[0]), cleaned[1]];
    if (suffix && /k/i.test(suffix)) num *= 1000;
    if (suffix && /m/i.test(suffix)) num *= 1000000;
    return Math.round(num);
  }

  return { text, firstMatch, allMatches, metaContent, publicIdFromUrl, parseCount, textMultiline };
})();
