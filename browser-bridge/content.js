(() => {
  "use strict";
  const MAX_TEXT_CHARS = 32768;
  const runtime =
    typeof chrome !== "undefined" && chrome.runtime
      ? chrome.runtime
      : typeof browser !== "undefined"
        ? browser.runtime
        : null;
  if (!runtime || !runtime.onMessage) return;

  function visibleArticleText() {
    const main =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body;
    if (!main) return "";
    // Strictly read visible prose; never read input, textarea, or password field values.
    const clone = main.cloneNode(true);
    const blocked = clone.querySelectorAll(
      "script, style, noscript, input, textarea, select, [aria-hidden='true']",
    );
    for (const el of blocked) el.remove();
    const raw = (clone.innerText || clone.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    return raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS) : raw;
  }

  function mediaState() {
    const media = document.querySelector("video, audio");
    const sessionMeta =
      typeof navigator !== "undefined" && navigator.mediaSession && navigator.mediaSession.metadata
        ? navigator.mediaSession.metadata
        : null;
    if (!media && !sessionMeta) return null;
    const title = String(
      (sessionMeta && sessionMeta.title) || document.title || "",
    ).trim();
    const artist = String((sessionMeta && sessionMeta.artist) || "").trim();
    const paused = media ? Boolean(media.paused) : false;
    const currentTime =
      media && Number.isFinite(media.currentTime) ? Number(media.currentTime.toFixed(1)) : 0;
    const duration =
      media && Number.isFinite(media.duration) ? Number(media.duration.toFixed(1)) : 0;
    return {
      playing: !paused,
      paused,
      title,
      artist,
      currentTime,
      duration,
    };
  }

  function extractDom() {
    const sel = window.getSelection ? String(window.getSelection() || "").trim() : "";
    return {
      url: String(location.href || ""),
      title: String(document.title || ""),
      articleText: visibleArticleText(),
      selection: sel.slice(0, 4096),
      mediaPlaying: mediaState(),
    };
  }

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "extract") return false;
    try {
      sendResponse({ ok: true, data: extractDom() });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  });
})();
