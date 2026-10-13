// Reads a public profile link exposed by the signed-in user's lead page.
// The link is taken only from the lead actions menu, never inferred from a
// Sales Navigator lead ID or an unrelated recommendation on the page.
(() => {
  if (globalThis.__SKOUT_SALES_LEAD_READER__) return;
  globalThis.__SKOUT_SALES_LEAD_READER__ = true;
  const publicUrl = value => {
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.protocol !== 'https:' || !['www.linkedin.com', 'linkedin.com'].includes(url.hostname) ||
          parts[0] !== 'in' || !parts[1] || parts.length !== 2) return undefined;
      return `https://www.linkedin.com/in/${parts[1]}/`;
    } catch { return undefined; }
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = element => !!(element && element.getClientRects().length);

  async function readLink() {
    const leadId = location.pathname.split('/').filter(Boolean)[2]?.split(',')[0];
    if (!leadId || !location.pathname.startsWith('/sales/lead/')) return {ok:false,error:'Not a Sales Navigator lead page.'};
    let button;
    for (let attempt = 0; attempt < 20; attempt++) {
      button = document.querySelector('button[data-x--lead-actions-bar-overflow-menu]') ||
        document.querySelector('button[aria-label="Open actions overflow menu"]');
      if (visible(button)) break;
      await delay(350);
    }
    if (!visible(button)) return {ok:true,leadId,publicUrl:null};
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    const menuId = button.getAttribute('aria-controls');
    for (let attempt = 0; attempt < 12; attempt++) {
      const menu = menuId && document.getElementById(menuId);
      const links = menu ? [...menu.querySelectorAll('a[href]')] :
        [...document.querySelectorAll('a[href]')].filter(a => visible(a));
      const link = links.find(a => /view linkedin profile/i.test(a.textContent || '') && publicUrl(a.href));
      if (link) return {ok:true,leadId,publicUrl:publicUrl(link.href)};
      await delay(250);
    }
    return {ok:true,leadId,publicUrl:null};
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'SALES_LEAD_READER_READY') {
      respond({ok:true,url:location.href});
      return;
    }
    if (message.type === 'READ_SALES_PUBLIC_LINK') {
      readLink().then(respond).catch(error => respond({ok:false,error:error.message}));
      return true;
    }
  });
})();
