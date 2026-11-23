(() => {
  "use strict";
  const HOST_NAME = "app.astranavi.dom_bridge";
  const ALLOWED_ACTIONS = new Set(["ping", "read-page"]);
  const api = typeof browser !== "undefined" ? browser : chrome;

  let port = null;
  let reconnectTimer = null;

  function connect() {
    if (port) return port;
    try {
      port = api.runtime.connectNative(HOST_NAME);
      port.onMessage.addListener((message) => {
        void handleHostRequest(message);
      });
      port.onDisconnect.addListener(() => {
        port = null;
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 3000);
        }
      });
    } catch {
      port = null;
    }
    return port;
  }

  function reply(id, ok, payload) {
    const target = connect();
    if (!target) return;
    target.postMessage(ok ? { id, ok: true, data: payload } : { id, ok: false, error: payload });
  }

  async function queryActiveTab() {
    const tabs = await new Promise((resolve) => {
      api.tabs.query({ active: true, currentWindow: true }, (found) => {
        resolve(Array.isArray(found) ? found : []);
      });
    });
    const tab = tabs[0];
    if (!tab || typeof tab.id !== "number") {
      throw new Error("No active browser tab available.");
    }
    return tab;
  }

  async function extractTabDom(tabId) {
    return new Promise((resolve, reject) => {
      api.tabs.sendMessage(tabId, { type: "extract" }, (res) => {
        const runtimeErr = api.runtime.lastError;
        if (runtimeErr) {
          reject(new Error(runtimeErr.message || "Content script unavailable."));
          return;
        }
        if (!res || !res.ok) {
          reject(new Error((res && res.error) || "DOM extraction failed."));
          return;
        }
        resolve(res.data);
      });
    });
  }

  async function handleHostRequest(message) {
    const id = message && typeof message.id === "string" ? message.id : "";
    const action = message && typeof message.action === "string" ? message.action : "";
    if (!id || !ALLOWED_ACTIONS.has(action)) {
      if (id) reply(id, false, "Unsupported DOM bridge action.");
      return;
    }
    if (action === "ping") {
      reply(id, true, { alive: true, host: HOST_NAME });
      return;
    }
    try {
      const tab = await queryActiveTab();
      const tabUrl = String(tab.url || "");
      const requestedUrl = typeof message.url === "string" ? message.url : "";
      if (requestedUrl && tabUrl && !tabUrl.startsWith(requestedUrl.split("#")[0])) {
        reply(id, false, "Active tab URL does not match requested allowlisted page.");
        return;
      }
      const data = await extractTabDom(tab.id);
      reply(id, true, data);
    } catch (error) {
      reply(id, false, error instanceof Error ? error.message : String(error));
    }
  }

  connect();
})();
