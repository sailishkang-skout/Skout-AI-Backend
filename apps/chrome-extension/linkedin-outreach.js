/**
 * Executes LinkedIn connection requests and DMs from the page context
 * (has access to LinkedIn session cookies / Voyager CSRF).
 *
 * Injected into a LinkedIn tab by the background worker.
 */
(function skoutLinkedInOutreach() {
  if (window.__skoutLinkedInOutreach) return;
  window.__skoutLinkedInOutreach = true;

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)JSESSIONID="?([^";]+)"?/);
    return match?.[1]?.replace(/"/g, "") ?? null;
  }

  async function voyagerFetch(path, options = {}) {
    const csrf = getCsrfToken();
    if (!csrf) throw new Error("linkedin_not_logged_in");
    const res = await fetch(`https://www.linkedin.com${path}`, {
      ...options,
      credentials: "include",
      headers: {
        accept: "application/vnd.linkedin.normalized+json+2.1",
        "content-type": "application/json; charset=UTF-8",
        "csrf-token": csrf,
        "x-restli-protocol-version": "2.0.0",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`linkedin_api_${res.status}:${text.slice(0, 180)}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) return res.json();
    return null;
  }

  function profileSlugFromUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      const idx = parts.indexOf("in");
      if (idx >= 0 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
      return null;
    } catch {
      return null;
    }
  }

  async function resolveProfileUrn(linkedinUrl) {
    const slug = profileSlugFromUrl(linkedinUrl);
    if (!slug) throw new Error("invalid_linkedin_url");

    // Prefer URN already on the open profile page
    const code = document.querySelector("code[id*=\"bpr-guid\"]");
    if (code?.textContent?.includes("urn:li:fsd_profile:")) {
      const m = code.textContent.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/);
      if (m) return m[0];
    }

    const data = await voyagerFetch(
      `/voyager/api/identity/profiles/${encodeURIComponent(slug)}/profileView`
    );
    const urn =
      data?.data?.["*profile"] ||
      data?.included?.find((x) => x?.entityUrn?.includes("fsd_profile"))?.entityUrn ||
      data?.included?.find((x) => x?.entityUrn?.includes("fs_miniProfile"))?.entityUrn;
    if (!urn) throw new Error("linkedin_profile_urn_not_found");
    return String(urn).replace("urn:li:fs_miniProfile:", "urn:li:fsd_profile:");
  }

  async function sendConnection(linkedinUrl, note) {
    const profileUrn = await resolveProfileUrn(linkedinUrl);
    const body = {
      invitee: {
        inviteeUnion: {
          memberProfile: profileUrn,
        },
      },
      ...(note
        ? {
            message: note.slice(0, 300),
          }
        : {}),
    };
    await voyagerFetch("/voyager/api/growth/normInvitations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, action: "connect" };
  }

  async function sendMessage(linkedinUrl, message) {
    if (!message?.trim()) throw new Error("linkedin_message_empty");
    const profileUrn = await resolveProfileUrn(linkedinUrl);
    const mailboxUrn = profileUrn.replace("urn:li:fsd_profile:", "urn:li:fs_miniProfile:");
    const create = await voyagerFetch(
      "/voyager/api/messaging/conversations?action=create",
      {
        method: "POST",
        body: JSON.stringify({
          keyVersion: "LEGACY_INBOX",
          conversationCreate: {
            eventCreate: {
              value: {
                "com.linkedin.voyager.messaging.create.MessageCreate": {
                  body: message.slice(0, 8000),
                  attachments: [],
                  attributedBody: {
                    text: message.slice(0, 8000),
                    attributes: [],
                  },
                },
              },
            },
            recipients: [mailboxUrn],
            subtype: "MEMBER_TO_MEMBER",
          },
        }),
      }
    );
    return { ok: true, action: "message", create };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "SKOUT_LINKEDIN_OUTREACH") return false;
    (async () => {
      try {
        if (msg.action === "connect") {
          sendResponse({ ok: true, result: await sendConnection(msg.linkedinUrl, msg.message) });
        } else if (msg.action === "message") {
          sendResponse({ ok: true, result: await sendMessage(msg.linkedinUrl, msg.message) });
        } else {
          sendResponse({ ok: false, error: "unknown_action" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  });
})();
