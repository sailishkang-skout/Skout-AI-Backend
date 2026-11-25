// The verification scan's rules: how many records each section should have, which sections look
// incomplete and need a second look, and what a capture can honestly be called afterwards.
// Pure functions over the captured data; no page access.
globalThis.SkoutCaptureVerify = globalThis.SkoutCaptureVerify || (() => {
  const SECTIONS = {
    skills: { label: 'Skills', lists: ['skills'], detail: 'details/skills/', lowSignal: 4 },
    education: { label: 'Education', lists: ['educations'], detail: 'details/education/', lowSignal: 1 },
    experience: { label: 'Experience', lists: ['currentCompanies', 'previousCompanies'], detail: 'details/experience/', lowSignal: 1 },
  };
  // Fields a profile is expected to show. A missing one is retried once, then named.
  const CORE_FIELDS = [['fullName', 'Name'], ['headline', 'Headline'], ['locationName', 'Location']];
  const CONTACT_FIELDS = [['email', 'Email'], ['phone', 'Phone'], ['website', 'Website / portfolio']];

  /** Records in a section, each counted once (the same role is never counted twice). */
  function countOf(data, key) {
    const rows = SECTIONS[key].lists.flatMap((list) => (Array.isArray(data?.[list]) ? data[list] : []));
    if (key === 'skills') return new Set(rows.map((row) => String(row?.name || '').trim().toLowerCase()).filter(Boolean)).size;
    if (key === 'education') return new Set(rows.map((row) => `${String(row?.school || '').toLowerCase()}|${String(row?.degree || '').toLowerCase()}|${row?.dates || ''}`)).size;
    return new Set(rows.map((row) => `${String(row?.name || '').toLowerCase()}|${String(row?.title || '').toLowerCase()}|${row?.dates || ''}`)).size;
  }

  /**
   * Where each section stands: `complete` (it matches what the page says it has, or nothing says
   * otherwise), `incomplete` (fewer than the page says, or suspiciously few next to a "Show all"
   * link), `none` (the section loaded and is empty), `not_loaded`.
   */
  function assess(data) {
    const sections = {};
    for (const [key, spec] of Object.entries(SECTIONS)) {
      const found = countOf(data, key);
      const expected = Number.isFinite(data?._expectedCounts?.[key]) ? data._expectedCounts[key] : undefined;
      const showAll = data?._showAll?.[key] === true;
      const loaded = data?._sections?.[key];
      let state;
      if (expected !== undefined && found < expected) state = 'incomplete';
      else if (expected === undefined && showAll && found <= spec.lowSignal) state = 'incomplete';
      else if (found > 0) state = 'complete';
      else state = loaded === 'loaded' ? 'none' : 'not_loaded';
      sections[key] = { found, ...(expected !== undefined ? { expected } : {}), state };
    }
    const missing = [...CORE_FIELDS, ...CONTACT_FIELDS].filter(([field]) => !hasValue(data, field)).map(([, label]) => label);
    if (!hasCompany(data)) missing.push('Current company');
    if (!hasTitle(data)) missing.push('Current title');
    const coreMissing = CORE_FIELDS.some(([field]) => !hasValue(data, field)) || !hasCompany(data);
    // Sections worth a deeper look: short of what the page says, or never loaded.
    const retry = Object.entries(sections).filter(([, entry]) => entry.state === 'incomplete' || entry.state === 'not_loaded').map(([key]) => key);
    return { sections, missing, coreMissing, retry };
  }

  const hasValue = (data, field) => data?.[field] !== undefined && data?.[field] !== null && String(data[field]).trim() !== '';
  const hasCompany = (data) => (Array.isArray(data?.currentCompanies) && data.currentCompanies.some((role) => role?.name)) || (Array.isArray(data?.previousCompanies) && data.previousCompanies.length > 0);
  const hasTitle = (data) => Array.isArray(data?.currentCompanies) && data.currentCompanies.some((role) => role?.title);

  /**
   * What the capture can honestly be called after the verification pass. A section that is short
   * of what the page says is a partial capture; one that never loaded is not verified; a profile
   * missing fields is complete with missing data. Only a capture whose sections all agree is verified.
   */
  function verdict(assessment, { passes = 2, restricted = false, failed = false, notes = [] } = {}) {
    const sectionNotes = Object.entries(assessment.sections)
      .filter(([, entry]) => entry.state === 'incomplete')
      .map(([key, entry]) => `${(SECTIONS[key]?.label) || key}: captured ${entry.found}${entry.expected !== undefined ? ` of ${entry.expected}` : ' (LinkedIn shows more than was loaded)'}.`);
    return verdictFor(assessment.sections, { missing: assessment.missing, passes, restricted, failed, notes: [...notes, ...sectionNotes] });
  }

  /**
   * The same rules for any set of sections (a company's people, jobs and About fields, a profile's
   * skills and education): failed or restricted first, then partial, then not loaded, then missing data.
   */
  function verdictFor(sections, { missing = [], passes = 2, restricted = false, failed = false, notes = [] } = {}) {
    const states = Object.values(sections).map((entry) => entry.state);
    let status;
    if (failed) status = 'failed';
    else if (restricted || states.includes('restricted')) status = 'restricted';
    else if (states.length && states.every((state) => state === 'not_loaded')) status = 'not_loaded';
    else if (states.includes('failed')) status = 'partial';
    else if (states.includes('incomplete')) status = 'partial';
    else if (states.includes('not_loaded')) status = 'verification_required';
    else if (missing.length) status = 'missing_data';
    else status = 'verified';
    return {
      status,
      passes,
      sections,
      ...(missing.length ? { missing } : {}),
      notes: notes.slice(0, 20),
      verifiedAt: new Date().toISOString(),
    };
  }

  const LABELS = {
    verified: 'Completed & verified',
    missing_data: 'Completed with missing data',
    verification_required: 'Verification required',
    partial: 'Partial capture',
    not_loaded: 'Not loaded',
    restricted: 'Restricted by LinkedIn',
    failed: 'Failed',
  };
  const label = (status) => LABELS[status] || 'Unknown';

  /** Merges what two looks at the same profile learned about its totals: never lowers, never forgets. */
  function mergeSignals(a = {}, b = {}) {
    const expected = { ...(a._expectedCounts || {}) };
    for (const [key, value] of Object.entries(b._expectedCounts || {})) if (Number.isFinite(value)) expected[key] = Math.max(expected[key] || 0, value);
    const showAll = { ...(a._showAll || {}), ...Object.fromEntries(Object.entries(b._showAll || {}).filter(([, v]) => v)) };
    const sections = { ...(a._sections || {}) };
    for (const [key, value] of Object.entries(b._sections || {})) if (sections[key] !== 'loaded') sections[key] = value;
    return { _expectedCounts: expected, _showAll: showAll, _sections: sections };
  }

  return { SECTIONS, countOf, assess, verdict, verdictFor, label, mergeSignals };
})();
