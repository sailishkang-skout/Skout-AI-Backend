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
      "*"
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
    if (event.source !== window || event.data?.source !== "skout-web") return;

    if (event.data.type === "SKOUT_EXTENSION_PING") {
      announce();
      window.postMessage({ source: "skout-extension", type: "REQUEST_AUTH" }, "*");
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
          "*"
        );
      }
    });
  });

  window.addEventListener("skout-extension-ping", announce);

  announce();
})();
