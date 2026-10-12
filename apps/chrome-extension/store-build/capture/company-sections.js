// Company modules verified against rendered Salesforce pages, September 2026.
// Read-only DOM extraction: no requests, clicks, scrolling or navigation.
window.SkoutCompanySections = (() => {
  const compact = el => el?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
  function clean(el) {
    if (!el) return undefined;
    const clone = el.cloneNode(true);
    // This is the chart's rendered screen-reader data table, not hidden API state.
    clone.querySelectorAll('table.visually-hidden').forEach(table => table.classList.remove('visually-hidden'));
    // Preserve signed growth descriptions supplied for accessibility.
    clone.querySelectorAll('td').forEach(td => {
      const direction = td.querySelector('.visually-hidden');
      if (direction && /increase|decrease/i.test(direction.textContent)) td.textContent = direction.textContent;
    });
    clone.querySelectorAll('script, style, svg, iframe, button, nav, footer, .visually-hidden, .chart-container, .artdeco-carousel__navigation, .lt-line-clamp__ellipsis, [hidden]').forEach(n => n.remove());
    clone.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    clone.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,dt,dd,tr,section').forEach(n => { n.prepend('\n'); n.append('\n'); });
    clone.querySelectorAll('td,th').forEach(n => n.append(' | '));
    return clone.textContent.split('\n').map(s => s.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n') || undefined;
  }
  function section(title) {
    return Array.from(document.querySelectorAll('main h2, main h3')).find(h => {
      const value = compact(h);
      return title instanceof RegExp ? title.test(value || '') : value === title;
    })?.closest('section');
  }
  function url(a) {
    try { const u = new URL(a?.getAttribute('href'), location.origin); return /^https?:$/.test(u.protocol) ? u.href : undefined; } catch { return undefined; }
  }
  function products() {
    const cards = [...document.querySelectorAll('main [data-inmon-company-products]')];
    const home = section('Products');
    if (home) cards.push(...home.querySelectorAll('.artdeco-carousel__item'));
    const seen = new Set();
    return cards.flatMap(card => {
      const heading = card.querySelector('.org-product-card__entity-lockup-title, h4');
      const a = heading?.closest('a');
      const productUrl = url(a);
      const slug = productUrl?.match(/\/products\/([^/?#]+)/)?.[1];
      if (!slug || seen.has(slug)) return [];
      seen.add(slug);
      const description = clean(card.querySelector('.org-product-card__description')) ||
        Array.from(card.querySelectorAll('a[href*="/products/"]')).map(a => clean(a)).filter(t=>t && t.length > 100).sort((a,b)=>b.length-a.length)[0];
      return [{slug,productUrl,name:compact(heading),description,
        category:compact(card.querySelector('.org-product-card__entity-lockup-caption')) || compact(a.querySelector('p'))}];
    });
  }
  function life() {
    return Array.from(document.querySelectorAll('main .org-life-custom-modules-module__inline-body')).map(p => {
      const heading = compact(p.parentElement.querySelector('h4'));
      return [heading,clean(p)].filter(Boolean).join('\n');
    });
  }
  function people() {
    if (!/\/people\/?$/.test(location.pathname)) return undefined;
    const heading = Array.from(document.querySelectorAll('main h2')).find(h => /[\d,]+ associated members/.test(compact(h) || ''));
    const breakdowns = {};
    document.querySelectorAll('main .insight-container').forEach(card => {
      const label = compact(card.querySelector('h3'));
      const rows = Array.from(card.querySelectorAll('.org-people-bar-graph-element__percentage-bar-info')).map(row =>
        [compact(row.querySelector('strong')),compact(row.querySelector('.org-people-bar-graph-element__category'))].filter(Boolean).join(' — '));
      if (label && rows.length) breakdowns[label] = rows;
    });
    if (!heading && !Object.keys(breakdowns).length) return undefined;
    return {totalEmployeesText:compact(heading),breakdowns};
  }
  function peopleProfiles() {
    if (!/\/people\/?$/.test(location.pathname)) return [];
    // Recommendations are not evidence of current employment. The
    // company-filtered people search supplies discovery candidates.
    if (Array.from(document.querySelectorAll('main h2')).some(h => /^people you may know$/i.test(compact(h) || ''))) return [];
    const seen = new Set();
    // LinkedIn's company People page also includes the header's employee
    // link, service-profile links, and mutuals. The profile-image link is
    // the stable marker for an actual rendered member card; using all /in/
    // links is what previously admitted unrelated people and produced an
    // incomplete, noisy list.
    const cardAnchors = Array.from(document.querySelectorAll('main a[id^="org-people-profile-card__profile-image"][href*="/in/"]'));
    const anchors = cardAnchors.length ? cardAnchors : Array.from(document.querySelectorAll('main .org-people-profile-card a[href*="/in/"]'));
    return anchors.flatMap((anchor) => {
      let url;
      try { url = new URL(anchor.getAttribute('href'), location.origin); } catch { return []; }
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.hostname !== 'www.linkedin.com' || parts[0] !== 'in' || !parts[1] || seen.has(parts[1])) return [];
      const fullName = (compact(anchor) || anchor.getAttribute('aria-label') || anchor.querySelector('img')?.alt || '')
        .replace(/\s+(?:is hiring|profile picture)$/i, '').trim();
      if (!fullName || fullName.length > 100 || /^(view|follow|message|connect)$/i.test(fullName) || /\b(people you may know|ad options|mutual connections?)\b/i.test(fullName)) return [];
      seen.add(parts[1]);
      const card = anchor.closest('.org-people-profile-card__card-spacing, .org-people-profile-card, [role="listitem"], li, article') || anchor.parentElement;
      const lines = Array.from(card?.querySelectorAll('p') || []).map(compact).filter(Boolean);
      return [{ publicId: parts[1], sourceUrl: `${url.origin}/in/${parts[1]}/`, fullName, headline: lines.find(line => line !== fullName) }];
    });
  }
  function captures(data) {
    const result = {};
    const sourceUrl = location.href.split('?')[0];
    function add(key, content) {
      if (!content?.trim()) return;
      result[key] = {text:content.slice(0,30000),sourceUrl,capturedAt:new Date().toISOString(),method:'rendered-dom',scope:'loaded-page'};
    }
    const list = items => items.map(item => Object.entries(item).filter(([,v])=>v != null).map(([key,value])=>`${key}: ${value}`).join('\n')).join('\n\n');
    add('home', [data.name,data.tagline,data.industry,data.headquarter,data.size,data.followers != null ? `${data.followers} followers` : null].filter(Boolean).join('\n'));
    add('overview',data.overview);
    const about = document.querySelector('main .org-page-details-module__card-spacing');
    add('about', clean(about));
    if (data.recentPosts?.length) add('posts',list(data.recentPosts));
    if (data.openJobs?.length) add('jobs',list(data.openJobs));
    if (data.products?.length) add('products',list(data.products));
    if (data.life?.length) add('life',data.life.join('\n\n'));
    else {
      const homeLife = section(/^Life at /);
      if (homeLife) {
        const photos = Array.from(homeLife.querySelectorAll('a[href*="photoIndex"]')).map(a=>`${a.getAttribute('aria-label') || 'Company photo'}: ${url(a)}`);
        if (photos.length) add('life',photos.join('\n'));
      }
    }
    if (data.peopleStats) add('people',[data.peopleStats.totalEmployeesText,...Object.entries(data.peopleStats.breakdowns || {}).map(([key,rows])=>`${key}\n${rows.join('\n')}`)].filter(Boolean).join('\n\n'));
    add('salesInsights',clean(section('Sales insights')));
    const highlights = section('People highlights');
    // Aggregate highlight headings only; never enumerate employee cards.
    if (highlights) add('peopleHighlights',Array.from(highlights.querySelectorAll('h3')).map(compact).filter(Boolean).join('\n'));
    const events = section('Past events');
    if (events) add('pastEvents',Array.from(events.querySelectorAll('.events-components-shared-discovery-card')).map(card => {
      const title = card.querySelector('.events-components-shared-discovery-card__event-title');
      return [clean(card),url(title?.closest('a'))].filter(Boolean).join('\n');
    }).join('\n\n'));
    const newsletter = document.querySelector('main .org-newsletters-module__body');
    if (newsletter) add('newsletters',[clean(newsletter),url(newsletter.querySelector('a[href*="/newsletters/"]'))].filter(Boolean).join('\n'));
    const premium = section(/^Exclusive insights on /);
    if (premium) {
      const stats = premium.querySelector('.aiq-premium-insights-module-card__statistics-container');
      add('exclusiveInsights',clean(stats));
    }
    const insightModules = document.querySelectorAll('main .org-insights-module');
    if (insightModules.length) add('exclusiveInsights',Array.from(insightModules).map(clean).filter(Boolean).join('\n\n'));
    return result;
  }
  return {clean,section,products,life,people,peopleProfiles,captures};
})();
