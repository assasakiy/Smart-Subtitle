(() => {
  if (window.__subtitleSyncAiBridge) return;
  window.__subtitleSyncAiBridge = true;

  // Intercepted timedtext cache (URL, response text, content-type)
  const interceptedTimedtext = new Map();

  function saveIntercepted(url, text, contentType) {
    if (!url || typeof text !== "string" || !text.trim()) return;
    try {
      const u = new URL(url, location.origin);
      const lang = u.searchParams.get("lang") || "";
      const v = u.searchParams.get("v") || "";
      const vssId = u.searchParams.get("vssId") || "";
      const data = { url, text, contentType: contentType || "" };
      interceptedTimedtext.set(url, data);
      if (v && lang) interceptedTimedtext.set(`${v}:${lang}`, data);
      if (v && vssId) interceptedTimedtext.set(`${v}:${vssId}`, data);
    } catch {}
  }

  // 1. Monkeypatch window.fetch untuk menangkap request timedtext asli dari YouTube Player
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (typeof url === "string" && url.includes("/api/timedtext")) {
        const clone = response.clone();
        clone.text().then((text) => {
          saveIntercepted(url, text, clone.headers.get("content-type"));
        }).catch(() => {});
      }
    } catch {}
    return response;
  };

  // 2. Monkeypatch XMLHttpRequest untuk menangkap timedtext jika player memakai XHR
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__ttUrl = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (this.__ttUrl && String(this.__ttUrl).includes("/api/timedtext")) {
      this.addEventListener("load", () => {
        try {
          const text = this.responseText;
          saveIntercepted(this.__ttUrl, text, this.getResponseHeader("content-type"));
        } catch {}
      });
    }
    return originalSend.apply(this, args);
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || message?.source !== "subtitle-sync-ai") return;

    if (message.type === "GET_CAPTION_TRACKS") {
      try {
        const playerResponse = document.querySelector("#movie_player")?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
        const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const tracks = captionTracks.slice(0, 100).map((track) => ({
          baseUrl: String(track.baseUrl || ""),
          vssId: String(track.vssId || track.languageCode || ""),
          languageCode: String(track.languageCode || ""),
          name: String(track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") || track.languageCode || ""),
          kind: track.kind || "manual",
          isTranslatable: Boolean(track.isTranslatable),
        })).filter((track) => track.baseUrl);

        window.postMessage({
          source: "subtitle-sync-ai-page",
          type: "CAPTION_TRACKS",
          requestId: message.requestId,
          ok: true,
          videoId: new URL(location.href).searchParams.get("v"),
          tracks,
        }, location.origin);
      } catch {
        window.postMessage({
          source: "subtitle-sync-ai-page",
          type: "CAPTION_TRACKS",
          requestId: message.requestId,
          ok: false,
          tracks: [],
          error: "Caption YouTube tidak tersedia.",
        }, location.origin);
      }
      return;
    }

    if (message.type === "FETCH_TIMEDTEXT") {
      const { url, languageCode, videoId, vssId } = message;

      // Cek apakah sudah tertangkap sebelumnya dari player
      const cached = (videoId && languageCode && interceptedTimedtext.get(`${videoId}:${languageCode}`))
        || (videoId && vssId && interceptedTimedtext.get(`${videoId}:${vssId}`))
        || interceptedTimedtext.get(url);

      if (cached && cached.text) {
        window.postMessage({
          source: "subtitle-sync-ai-page",
          type: "TIMEDTEXT_RESULT",
          requestId: message.requestId,
          ok: true,
          text: cached.text,
          contentType: cached.contentType || "",
          status: 200,
          strategy: "intercepted",
        }, location.origin);
        return;
      }

      // Fetch langsung di context halaman (bawa origin & cookie YouTube asli)
      (async () => {
        try {
          const res = await originalFetch(url, { credentials: "include" });
          const text = await res.text();
          const contentType = res.headers.get("content-type") || "";
          if (res.ok && text.trim()) {
            saveIntercepted(url, text, contentType);
          }
          window.postMessage({
            source: "subtitle-sync-ai-page",
            type: "TIMEDTEXT_RESULT",
            requestId: message.requestId,
            ok: res.ok && Boolean(text.trim()),
            status: res.status,
            contentType,
            text,
            strategy: "page-fetch",
          }, location.origin);
        } catch (e) {
          window.postMessage({
            source: "subtitle-sync-ai-page",
            type: "TIMEDTEXT_RESULT",
            requestId: message.requestId,
            ok: false,
            error: e.message,
            strategy: "page-fetch",
          }, location.origin);
        }
      })();
      return;
    }

    if (message.type === "TRIGGER_PLAYER_TRACK") {
      try {
        const player = document.querySelector("#movie_player");
        if (player) {
          if (typeof player.loadModule === "function") player.loadModule("captions");
          if (typeof player.setOption === "function" && message.languageCode) {
            player.setOption("captions", "track", { languageCode: message.languageCode });
          }
        }
      } catch {}
      return;
    }
  });
})();
