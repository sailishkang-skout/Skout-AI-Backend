/** Relays Clerk token from Skout web app → extension storage. Injected on Skout tabs only. */
(function initSkoutWebBridge() {
  const EXTENSION_ID = chrome.runtime.id;

  function announce() {
    window.postMessage(
      {
        source: "skout-extension",
        type: "EXTENSION_INSTALLED",
        extensionId: EXTENSION_ID,
      },
      window.location.origin
    );
  }

  function safeSend(message, callback) {
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch {
      // Extension was reloaded — page needs refresh.
    }
  }

  if (window.__SKOUT_WEB_BRIDGE__) {
    announce();
    return;
  }
  window.__SKOUT_WEB_BRIDGE__ = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source !== "skout-web") return;

    // Ping only announces presence — do not REQUEST_AUTH (avoids sync storms).
    if (event.data.type === "SKOUT_EXTENSION_PING") {
      announce();
      return;
    }

    if (event.data.type !== "SKOUT_EXTENSION_CONNECT") return;
    if (!event.data.token) return;

    const { requestId, token, email } = event.data;

    safeSend({ type: "save-auth", token, email: email || "" }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (!requestId?.startsWith("auto-")) {
        window.postMessage(
          {
            source: "skout-extension",
            type: "SKOUT_EXTENSION_CONNECTED",
            requestId,
            ok: Boolean(response?.ok) && !lastError,
            error: lastError?.message || response?.error || null,
          },
          window.location.origin
        );
      }
    });
  });

  window.addEventListener("skout-extension-ping", announce);

  announce();
})();
