(() => {
  if (window.__subtitleSyncAiBridge) return;
  window.__subtitleSyncAiBridge = true;

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || message?.source !== "subtitle-sync-ai" || message.type !== "GET_CAPTION_TRACKS") return;

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
  });
})();
