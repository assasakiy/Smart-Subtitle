(() => {
  if (window.__subtitleSyncAiLoaded) return;
  window.__subtitleSyncAiLoaded = true;

  let phase = "idle";
  let active = false;
  let recorder;
  let stream;
  let segments = [];
  let rawSegments = [];
  let batches = [];
  let chunkStartedAt = 0;
  let renderFrame = 0;
  let host;
  let textNode;
  let error = "";
  let progress = "";
  let runId = 0;
  let pending = Promise.resolve();
  let runSettings = {};
  let currentVideoId = getVideoId();
  let source = null;
  let currentJob = null;
  let cachedTracks = [];

  let userFontSize = 24;
  let userPositionBottom = 8;
  let userMaxWidthPercent = 90;
  let userLineHeight = 1.35;
  loadStyleSettings();

  loadDefaultCache();
  window.addEventListener("yt-navigate-finish", handleNavigation);
  requestCaptionTracks().then((tracks) => {
    cachedTracks = tracks || [];
  }).catch(() => {
    cachedTracks = [];
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const tasks = {
      GET_STATE: () => getState(),
      GENERATE: () => startGeneration(message),
      FINISH_GENERATION: () => finishGeneration(),
      ACTIVATE: () => activate(),
      DEACTIVATE: () => deactivate(),
      SWITCH_TARGET: () => switchTarget(message),
      UPDATE_STYLE: () => {
        if (message.fontSize) userFontSize = Number(message.fontSize);
        if (message.positionBottom !== undefined) userPositionBottom = Number(message.positionBottom);
        if (message.maxWidthPercent !== undefined) userMaxWidthPercent = Number(message.maxWidthPercent);
        if (message.lineHeight !== undefined) userLineHeight = Number(message.lineHeight);
        applyStyleToOverlay();
        return getState();
      },
    };
    if (message.type === "AI_PROGRESS") {
      const payload = message.payload || {};
      if (payload.jobId && currentJob && payload.jobId !== currentJob.id) return;
      progress = typeof payload === "string" ? payload : payload.message || progress;
      sendResponse(getState());
      return;
    }
    if (!tasks[message.type]) return;
    Promise.resolve(tasks[message.type]()).then(sendResponse).catch((reason) => {
      phase = "error";
      error = reason.message;
      sendResponse(getState());
    });
    return true;
  });

  document.addEventListener("fullscreenchange", () => {
    if (active) mountOverlay();
  });

  async function switchTarget({ sourceMode, trackId, targetLanguage, textModel }) {
    if (phase === "generating") return getState();
    if (!currentVideoId) return getState();

    cancelCurrentJob();
    segments = [];
    rawSegments = [];
    batches = [];
    error = "";
    progress = "";

    if (sourceMode === "original") {
      const track = chooseTrack(cachedTracks, trackId || targetLanguage);
      const trackKey = track?.vssId || track?.languageCode || trackId || targetLanguage;
      const kind = track?.kind || "manual";
      const key = originalCacheKey(currentVideoId, trackKey, kind);
      const cached = await readCache(key);
      if (cached && Array.isArray(cached.segments) && cached.segments.length > 0) {
        segments = cached.segments;
        source = "original";
        phase = "generated";
        progress = "Subtitle original tersimpan siap digunakan.";
      } else {
        source = "original";
        phase = "idle";
      }
    } else {
      // mode captions AI
      const lang = targetLanguage || "id";
      const model = textModel || "gpt-4o-mini";
      const key = captionCacheKey(currentVideoId, lang, model);
      const cached = await readCache(key);
      if (cached?.schema === 2 && Array.isArray(cached.batches)) {
        rawSegments = cached.rawSegments || [];
        batches = cached.batches;
        segments = collectCompletedSegments(batches);
        const completed = batches.filter((b) => b.status === "complete").length;
        if (completed > 0) {
          source = "captions";
          phase = completed === batches.length ? "generated" : "generating";
          progress = `${completed}/${batches.length} batch siap dari cache.`;
        } else {
          source = "captions";
          phase = "idle";
        }
      } else {
        source = "captions";
        phase = "idle";
      }
    }
    return getState();
  }

  async function startGeneration(settings) {
    if (phase === "generating" && source === "audio") return getState();
    const video = document.querySelector("video");
    if (!video) return fail("Video tidak ditemukan.");

    if (settings.sourceMode === "audio") {
      return startAudioGeneration(settings, video);
    }
    if (settings.sourceMode === "original") {
      return startOriginalGeneration(settings, video);
    }
    return startCaptionGeneration(settings, video);
  }

  async function startOriginalGeneration(settings, video) {
    cancelCurrentJob();
    const capturedVideoId = currentVideoId;
    debug("Mulai Original Smart Segmentation", { videoId: capturedVideoId, trackId: settings.trackId || settings.targetLanguage });

    try {
      const tracks = await requestCaptionTracks();
      assertCurrentVideo(capturedVideoId);
      const track = chooseTrack(tracks, settings.trackId || settings.targetLanguage);
      if (!track) throw new Error("Track subtitle YouTube tidak ditemukan.");

      const rawCues = await fetchCaptionSegments(track.baseUrl);
      assertCurrentVideo(capturedVideoId);
      if (!rawCues.length) throw new Error("Track subtitle tidak memiliki teks.");

      const normalized = normalizeCaptionCues(rawCues);
      const processed = segmentCuesLocally(normalized);

      rawSegments = normalized.map((c, id) => ({ ...c, id }));
      segments = processed;
      batches = [];
      source = "original";
      phase = "generated";
      progress = `Selesai! ${segments.length} segmen natural siap (tanpa AI).`;

      const trackKey = track.vssId || track.languageCode;
      const key = originalCacheKey(capturedVideoId, trackKey, track.kind);
      await writeCache({
        key,
        schema: 2,
        videoId: capturedVideoId,
        videoTitle: getVideoTitle(),
        targetLanguage: track.languageCode,
        source: "youtube",
        sourceType: track.kind || "manual",
        processing: "smart",
        textModel: null,
        segments,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      return getState();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      debug("Original segmentation gagal", { message });
      return fail(message);
    }
  }

  async function startAudioGeneration(settings, video) {
    stream = typeof video.captureStream === "function" ? video.captureStream() : null;
    const audioTracks = stream?.getAudioTracks() || [];
    if (!audioTracks.length || typeof MediaRecorder === "undefined") return fail("Audio video tidak dapat ditangkap browser.");

    cancelCurrentJob();
    deactivateOverlay();
    runId += 1;
    runSettings = {
      transcriptionModel: settings.transcriptionModel,
      textModel: settings.textModel,
      targetLanguage: settings.targetLanguage,
    };
    segments = [];
    rawSegments = [];
    batches = [];
    error = "";
    source = "audio";
    phase = "generating";
    progress = "Live audio berjalan…";
    chunkStartedAt = video.currentTime;
    pending = Promise.resolve();
    recorder = createRecorder(audioTracks, video, runId);
    recorder.start(30000);
    return getState();
  }

  async function startCaptionGeneration(settings, video) {
    cancelCurrentJob();
    const capturedVideoId = currentVideoId;
    debug("Mulai caption pipeline progresif", { videoId: capturedVideoId, targetLanguage: settings.targetLanguage, textModel: settings.textModel });

    try {
      const tracks = await requestCaptionTracks();
      assertCurrentVideo(capturedVideoId);
      const track = chooseTrack(tracks, settings.targetLanguage);
      if (!track) throw new Error("[track] YouTube tidak mengembalikan caption track.");

      const rawCues = await fetchCaptionSegments(track.baseUrl);
      assertCurrentVideo(capturedVideoId);
      if (!rawCues.length) throw new Error("[parse] Timedtext tidak memiliki segmen yang dapat digunakan.");

      const normalized = normalizeCaptionCues(rawCues);
      rawSegments = normalized.map((cue, id) => ({ ...cue, id }));
      const fingerprint = await fingerprintSegments(rawSegments);
      assertCurrentVideo(capturedVideoId);

      const key = captionCacheKey(capturedVideoId, settings.targetLanguage, settings.textModel);
      const cached = await readCache(key);
      assertCurrentVideo(capturedVideoId);

      const job = restoreOrCreateJob({
        key,
        videoId: capturedVideoId,
        targetLanguage: settings.targetLanguage,
        textModel: settings.textModel,
        fingerprint,
        rawSegments,
        cached,
      });
      currentJob = job;
      applyJobState(job);

      if (job.pendingIds.length) {
        phase = "generating";
        source = "captions";
        progress = job.completedCount ? `Melanjutkan (${job.completedCount}/${job.batches.length} batch siap)…` : "Memproses batch pertama di posisi pemutaran…";
        void runCaptionBatches(job, video.currentTime);
      } else {
        phase = "generated";
        source = "captions";
        progress = "Semua batch AI sudah lengkap dari cache.";
      }
      return getState();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      debug("Caption pipeline gagal", { message });
      return fail(message);
    }
  }

  function restoreOrCreateJob({ key, videoId, targetLanguage, textModel, fingerprint, rawSegments, cached }) {
    const freshBatches = partitionCaptionBatches(rawSegments);
    const reusable = cached && cached.schema === 2 && cached.sourceFingerprint === fingerprint && Array.isArray(cached.batches) && cached.batches.length === freshBatches.length;
    const finalBatches = reusable
      ? freshBatches.map((batch, index) => {
          const cachedBatch = cached.batches[index];
          return cachedBatch && cachedBatch.status === "complete" && Array.isArray(cachedBatch.segments)
            ? { ...batch, status: "complete", segments: cachedBatch.segments }
            : batch;
        })
      : freshBatches;

    const completedCount = finalBatches.filter((b) => b.status === "complete").length;
    const pendingIds = finalBatches.filter((b) => b.status !== "complete").map((b) => b.id);
    return {
      id: crypto.randomUUID(),
      key,
      videoId,
      targetLanguage,
      textModel,
      fingerprint,
      batches: finalBatches,
      pendingIds,
      completedCount,
      cancelled: false,
    };
  }

  function applyJobState(job) {
    batches = job.batches;
    segments = collectCompletedSegments(job.batches);
  }

  async function runCaptionBatches(job, currentTime) {
    const queue = orderBatchIds(job.batches, currentTime).filter((id) => job.batches[id]?.status !== "complete");
    for (const batchId of queue) {
      if (!isCurrentJob(job)) return;
      const batch = job.batches[batchId];
      if (!batch || batch.status === "complete") continue;

      try {
        const response = await chrome.runtime.sendMessage({
          type: "ENHANCE_CAPTIONS",
          jobId: job.id,
          batchId,
          segments: batch.cues,
          textModel: job.textModel,
          targetLanguage: job.targetLanguage,
        });

        if (!isCurrentJob(job)) return;
        if (!response?.ok || !Array.isArray(response.segments)) throw new Error(response?.error || `Batch ${batchId + 1} gagal diproses.`);

        batch.segments = response.segments;
        batch.status = "complete";
        job.completedCount += 1;
        applyJobState(job);

        await persistCaptionJob(job);
        if (!isCurrentJob(job)) return;

        progress = `Batch ${job.completedCount}/${job.batches.length} selesai. Subtitle siap ditonton.`;
        if (job.completedCount === job.batches.length) {
          phase = "generated";
          progress = `Selesai 100% (${job.completedCount}/${job.batches.length} batch AI). Tersimpan lokal.`;
        }
      } catch (reason) {
        if (!isCurrentJob(job)) return;
        phase = "error";
        error = reason instanceof Error ? reason.message : String(reason);
        progress = `Gagal di batch ${batchId + 1}: ${error}`;
        return;
      }
    }
  }

  function partitionCaptionBatches(cues) {
    const batches = [];
    let current = [];
    let batchId = 0;

    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index];
      const nextCandidate = [...current, cue];
      const estimate = estimateOutputTokens(nextCandidate);

      if (current.length && estimate > 6500) {
        batches.push(createBatch(batchId++, current));
        current = [cue];
      } else {
        current = nextCandidate;
      }
    }
    if (current.length) {
      if (batches.length && estimateOutputTokens(current) < 2500) {
        const prev = batches[batches.length - 1];
        const combined = [...prev.cues, ...current];
        if (estimateOutputTokens(combined) <= 7500) {
          batches[batches.length - 1] = createBatch(prev.id, combined);
          current = [];
        }
      }
      if (current.length) batches.push(createBatch(batchId++, current));
    }
    return batches;
  }

  function createBatch(id, cues) {
    const first = cues[0];
    const last = cues.at(-1);
    return {
      id,
      firstCueId: first.id,
      lastCueId: last.id,
      start: first.start,
      end: last.end,
      cues,
      status: "pending",
      segments: [],
    };
  }

  function orderBatchIds(batchList, currentTime) {
    if (!batchList.length) return [];
    let pivot = batchList.findIndex((b) => b.start <= currentTime && currentTime <= b.end);
    if (pivot < 0) pivot = batchList.findIndex((b) => b.end > currentTime);
    if (pivot < 0) pivot = batchList.length - 1;

    const queue = [pivot];
    for (let i = pivot + 1; i < batchList.length; i += 1) queue.push(i);
    for (let i = pivot - 1; i >= 0; i -= 1) queue.push(i);
    return queue;
  }

  function collectCompletedSegments(batchList) {
    const list = [];
    for (const batch of batchList) {
      if (batch.status === "complete" && Array.isArray(batch.segments)) {
        list.push(...batch.segments);
      }
    }
    return list.sort((a, b) => a.start - b.start);
  }

  async function persistCaptionJob(job) {
    await writeCache({
      key: job.key,
      schema: 2,
      videoId: job.videoId,
      videoTitle: getVideoTitle(),
      targetLanguage: job.targetLanguage,
      textModel: job.textModel,
      sourceFingerprint: job.fingerprint,
      rawSegments,
      batches: job.batches.map(({ id, firstCueId, lastCueId, start, end, status, segments }) => ({
        id,
        firstCueId,
        lastCueId,
        start,
        end,
        status,
        segments,
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async function fingerprintSegments(cues) {
    const payload = JSON.stringify(cues.map(({ start, end, text }) => [start, end, text]));
    const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function isCurrentJob(job) {
    return job && !job.cancelled && currentJob === job && currentVideoId === job.videoId;
  }

  function cancelCurrentJob() {
    if (currentJob) {
      currentJob.cancelled = true;
      currentJob = null;
    }
  }

  function assertCurrentVideo(expectedVideoId) {
    if (expectedVideoId !== currentVideoId || getVideoId() !== expectedVideoId) {
      throw new Error("Navigasi YouTube berubah sebelum proses selesai.");
    }
  }

  function requestCaptionTracks() {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new Error("[bridge] Player YouTube tidak merespons dalam 2,5 detik."));
      }, 2500);
      function receive(event) {
        const message = event.data;
        if (event.source !== window || event.origin !== location.origin || message?.source !== "subtitle-sync-ai-page" || message.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("message", receive);
        message.ok ? resolve(message.tracks || []) : reject(new Error(`[bridge] ${message.error || "Gagal membaca player response."}`));
      }
      window.addEventListener("message", receive);
      window.postMessage({ source: "subtitle-sync-ai", type: "GET_CAPTION_TRACKS", requestId }, location.origin);
    });
  }

  function normalizeCaptionCues(rawCues) {
    if (!Array.isArray(rawCues)) return [];
    const entityMap = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&#039;": "'" };
    const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|apos|#39|#039);/g, (m) => entityMap[m] || m);

    const cleaned = [];
    for (const cue of rawCues) {
      if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)) continue;
      let text = decode(String(cue.text || "")).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
      if (!text) continue;
      const start = Math.max(0, Number(cue.start));
      const end = Math.max(start + 0.1, Number(cue.end));
      cleaned.push({ start, end, text });
    }

    cleaned.sort((a, b) => a.start - b.start || a.end - b.end);

    // Dedup consecutive identical texts
    const deduped = [];
    for (let i = 0; i < cleaned.length; i++) {
      const cur = cleaned[i];
      const prev = deduped[deduped.length - 1];
      if (prev && prev.text === cur.text && Math.abs(prev.end - cur.start) < 0.2) {
        prev.end = Math.max(prev.end, cur.end);
      } else {
        deduped.push({ ...cur });
      }
    }
    return deduped;
  }

  function segmentCuesLocally(cues) {
    if (!cues.length) return [];
    const conf = {
      minDuration: 2.0,
      targetMaxDuration: 6.0,
      hardMaxDuration: 6.5,
      targetMinChars: 30,
      targetMaxChars: 80,
      hardMaxChars: 100,
      softGap: 0.250,
      sentenceGap: 0.550,
      targetMaxCps: 20,
    };

    const segments = [];
    let currentGroup = [];

    const flush = () => {
      if (!currentGroup.length) return;
      const first = currentGroup[0];
      const last = currentGroup[currentGroup.length - 1];
      const text = currentGroup.map((c) => c.text).join(" ").trim();
      segments.push({
        firstStart: first.start,
        lastEnd: last.end,
        text,
      });
      currentGroup = [];
    };

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (!currentGroup.length) {
        currentGroup.push(cue);
        continue;
      }

      const prev = currentGroup[currentGroup.length - 1];
      const gap = cue.start - prev.end;
      const curFirst = currentGroup[0];
      const potentialDuration = cue.end - curFirst.start;
      const curText = currentGroup.map((c) => c.text).join(" ");
      const potentialChars = curText.length + 1 + cue.text.length;

      // 1. Akhir kalimat pada cue sebelumnya (. ? !) -> POTONG
      const prevEndsSentence = /[.?!]$/.test(prev.text.trim());
      if (prevEndsSentence) {
        flush();
        currentGroup.push(cue);
        continue;
      }

      // 2. Gap jeda bicara >= 550ms -> POTONG
      if (gap >= conf.sentenceGap) {
        flush();
        currentGroup.push(cue);
        continue;
      }

      // 3. Batas keras (durasi > 6.5s ATAU karakter > 100) -> POTONG
      if (potentialDuration > conf.hardMaxDuration || potentialChars > conf.hardMaxChars) {
        flush();
        currentGroup.push(cue);
        continue;
      }

      // 4. Zona ideal tercapai (durasi >= 2s, karakter >= 30) dengan jeda alami (, ; :)
      const curDuration = prev.end - curFirst.start;
      const hasNaturalBreak = /[,;:]$/.test(prev.text.trim()) || gap >= conf.softGap;
      if (curDuration >= conf.minDuration && curText.length >= conf.targetMinChars && hasNaturalBreak) {
        flush();
        currentGroup.push(cue);
        continue;
      }

      // 5. Gap kecil (< 250ms) dan masih dalam batas target -> GABUNGKAN
      currentGroup.push(cue);
    }
    flush();

    // Clamped padding: start - 0.08, end + 0.12, hindari overlap dengan segmen berikutnya
    return segments.map((seg, idx) => {
      const next = segments[idx + 1];
      const rawStart = Math.max(0, seg.firstStart - 0.08);
      const targetEnd = seg.lastEnd + 0.12;
      const maxEnd = next ? Math.max(rawStart + 0.2, next.firstStart - 0.02) : targetEnd;
      const end = Math.min(targetEnd, maxEnd);
      return {
        start: Number(rawStart.toFixed(3)),
        end: Number(end.toFixed(3)),
        text: seg.text,
      };
    });
  }

  function chooseTrack(tracks, identifier) {
    if (!tracks || !tracks.length) return null;
    if (identifier) {
      const match = tracks.find((t) => t.vssId === identifier || `${t.languageCode}:${t.kind}` === identifier || t.languageCode === identifier);
      if (match) return match;
    }
    return tracks.find((t) => t.kind !== "asr") || tracks[0];
  }

  async function fetchCaptionSegments(baseUrl) {
    const url = new URL(baseUrl);
    const allowed = url.protocol === "https:" && (url.hostname === "www.youtube.com" || url.hostname.endsWith(".youtube.com") || url.hostname.endsWith(".googlevideo.com"));
    if (!allowed) throw new Error(`[fetch] Host timedtext ditolak: ${url.hostname}`);
    url.searchParams.set("fmt", "json3");
    debug("Mengambil timedtext", { host: url.hostname, language: url.searchParams.get("lang") });
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) {
      const errMsg = `[fetch] Timedtext gagal: HTTP ${response.status}`;
      chrome.runtime.sendMessage({
        type: "LOG_ERROR",
        log: {
          level: "error",
          source: "timedtext",
          message: errMsg,
          details: { url: url.toString(), videoId: currentVideoId, status: response.status }
        }
      }).catch(() => {});
      throw new Error(errMsg);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`[parse] Respons timedtext bukan JSON (${response.headers.get("content-type") || "content-type kosong"}).`);
    }
    const events = Array.isArray(payload.events) ? payload.events : [];
    return events.map((event, index) => {
      const start = Number(event.tStartMs) / 1000;
      const nextStart = Number(events[index + 1]?.tStartMs) / 1000;
      const duration = Number(event.dDurationMs) / 1000;
      const end = Number.isFinite(duration) ? start + duration : Number.isFinite(nextStart) ? nextStart : start + 4;
      const text = (event.segs || []).map((part) => part.utf8 || "").join("").replace(/\s+/g, " ").trim();
      return { start, end, text };
    }).filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.text);
  }

  function createRecorder(audioTracks, video, currentRun) {
    const mimeType = supportedMimeType();
    const nextRecorder = new MediaRecorder(new MediaStream(audioTracks), mimeType ? { mimeType } : undefined);
    nextRecorder.addEventListener("dataavailable", ({ data }) => {
      const end = video.currentTime;
      const start = chunkStartedAt;
      chunkStartedAt = end;
      pending = pending.then(() => processChunk(data, start, end, currentRun));
    });
    nextRecorder.addEventListener("error", () => fail("Perekaman audio gagal."));
    return nextRecorder;
  }

  async function finishGeneration() {
    if (source === "audio") {
      if (phase !== "generating") return getState();
      const currentRecorder = recorder;
      await new Promise((resolve) => {
        currentRecorder.addEventListener("stop", resolve, { once: true });
        currentRecorder.stop();
      });
      await pending;
      cleanupCapture();
      if (phase !== "error") {
        phase = segments.length ? "generated" : "idle";
        if (segments.length) await writeCache({
          key: cacheKey(currentVideoId, runSettings.targetLanguage, runSettings.textModel),
          videoId: currentVideoId,
          videoTitle: getVideoTitle(),
          targetLanguage: runSettings.targetLanguage,
          textModel: runSettings.textModel,
          segments,
          createdAt: Date.now(),
        });
      }
    }
    return getState();
  }

  async function processChunk(blob, offset, end, currentRun) {
    if (!blob.size || currentRun !== runId) return;
    const response = await chrome.runtime.sendMessage({
      type: "TRANSCRIBE_CHUNK",
      audio: await blob.arrayBuffer(),
      mimeType: blob.type || "audio/webm",
      ...runSettings,
    }).catch(() => ({ ok: false, error: "Endpoint tidak dapat dihubungi." }));

    if (currentRun !== runId) return;
    if (!response?.ok) {
      fail(response?.error || "Transkripsi gagal.");
      cleanupCapture();
      return;
    }

    const additions = response.segments.length
      ? response.segments.map((segment) => ({ ...segment, start: segment.start + offset, end: segment.end + offset }))
      : response.text ? [{ start: offset, end, text: response.text }] : [];
    segments.push(...additions);
    segments.sort((left, right) => left.start - right.start);
  }

  function activate() {
    const hasCompletedAiBatch = batches.some((b) => b.status === "complete" && b.segments.length);
    if (!hasCompletedAiBatch && !segments.length) return fail("Batch subtitle belum siap.");
    active = true;
    error = "";
    mountOverlay();
    render();
    return getState();
  }

  function deactivate() {
    active = false;
    deactivateOverlay();
    return getState();
  }

  function deactivateOverlay() {
    cancelAnimationFrame(renderFrame);
    host?.remove();
    host = undefined;
    textNode = undefined;
  }

  function cleanupCapture() {
    if (recorder?.state !== "inactive") recorder?.stop();
    stream?.getTracks().forEach((track) => track.stop());
    recorder = undefined;
    stream = undefined;
  }

  function mountOverlay() {
    host?.remove();
    const video = document.querySelector("video");
    const container = document.fullscreenElement || video?.closest("#movie_player");
    if (!container) return;

    host = document.createElement("div");
    host.id = "subtitle-sync-ai-root";
    Object.assign(host.style, {
      position: "absolute",
      inset: "0",
      zIndex: "2147483646",
      pointerEvents: "none",
      contain: "layout style paint",
    });

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .wrap {
        position: absolute;
        left: 50%;
        bottom: ${userPositionBottom}%;
        transform: translateX(-50%);
        width: max-content;
        max-width: min(${userMaxWidthPercent}%, 1100px);
        text-align: center;
        color: #fff;
        font: 650 ${userFontSize}px/${userLineHeight} system-ui, sans-serif;
        text-shadow: 0 2px 4px #000, 0 0 10px #000;
        pointer-events: none;
      }
      .text {
        display: inline-block;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
        background: rgba(8, 12, 20, .82);
        padding: .14em .42em;
        border-radius: .28em;
      }
      .text:empty {
        display: none;
        padding: 0;
        background: transparent;
      }
      .dock-wrap {
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        z-index: 2147483647;
        pointer-events: none;
        transition: transform 0.26s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .dock-wrap.closed {
        transform: translateY(-50%) translateX(-220px);
      }
      .panel {
        width: 220px;
        background: rgba(13, 22, 38, 0.96);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid #263650;
        border-left: 0;
        border-radius: 0 14px 14px 0;
        padding: 16px;
        color: #f4f7fb;
        font: 12px system-ui, sans-serif;
        box-shadow: 4px 0 30px rgba(0,0,0,0.6);
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        gap: 13px;
        box-sizing: border-box;
      }
      .dock-btn {
        width: 28px;
        height: 52px;
        background: rgba(13, 22, 38, 0.94);
        border: 1px solid #263650;
        border-left: 0;
        border-radius: 0 10px 10px 0;
        color: #F86800;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        pointer-events: auto;
        font-size: 15px;
        font-weight: 700;
        box-shadow: 3px 0 14px rgba(0,0,0,0.4);
        transition: background 0.15s, color 0.15s;
        user-select: none;
        flex-shrink: 0;
      }
      .dock-btn:hover {
        background: #182842;
        color: #fff;
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: 700;
        font-size: 13px;
        color: #F86800;
      }
      .control-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .control-row label {
        display: flex;
        justify-content: space-between;
        font-weight: 600;
        color: #cfd9e8;
      }
      input[type="range"] {
        width: 100%;
        margin: 4px 0;
        accent-color: #F86800;
        cursor: pointer;
      }
    `;

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    textNode = document.createElement("span");
    textNode.className = "text";
    wrap.append(textNode);

    // Floating UI Elements
    const dockWrap = document.createElement("div");
    dockWrap.className = "dock-wrap closed";

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="panel-head">
        <span>Pengaturan Subtitle</span>
      </div>
      <div class="control-row">
        <label><span>Ukuran Font</span><span id="widgetFontVal">${userFontSize}px</span></label>
        <input id="widgetFontInput" type="range" min="14" max="42" step="2" value="${userFontSize}">
      </div>
      <div class="control-row">
        <label><span>Posisi Bawah</span><span id="widgetPosVal">${userPositionBottom}%</span></label>
        <input id="widgetPosInput" type="range" min="4" max="75" step="1" value="${userPositionBottom}">
      </div>
      <div class="control-row">
        <label><span>Lebar Maks</span><span id="widgetWidthVal">${userMaxWidthPercent}%</span></label>
        <input id="widgetWidthInput" type="range" min="30" max="98" step="2" value="${userMaxWidthPercent}">
      </div>
      <div class="control-row">
        <label><span>Jarak Baris</span><span id="widgetLhVal">${userLineHeight}</span></label>
        <input id="widgetLhInput" type="range" min="1.0" max="2.4" step="0.05" value="${userLineHeight}">
      </div>
    `;

    const dockBtn = document.createElement("div");
    dockBtn.className = "dock-btn";
    dockBtn.title = "Buka / Tutup Pengaturan";
    dockBtn.textContent = "⚙";

    dockBtn.addEventListener("click", () => {
      const isClosed = dockWrap.classList.toggle("closed");
      dockBtn.textContent = isClosed ? "⚙" : "✕";
    });

    dockWrap.append(panel, dockBtn);

    const fontSlider = panel.querySelector("#widgetFontInput");
    const posSlider = panel.querySelector("#widgetPosInput");
    const widthSlider = panel.querySelector("#widgetWidthInput");
    const lhSlider = panel.querySelector("#widgetLhInput");
    const fontValEl = panel.querySelector("#widgetFontVal");
    const posValEl = panel.querySelector("#widgetPosVal");
    const widthValEl = panel.querySelector("#widgetWidthVal");
    const lhValEl = panel.querySelector("#widgetLhVal");

    fontSlider.addEventListener("input", () => {
      userFontSize = Number(fontSlider.value);
      fontValEl.textContent = `${userFontSize}px`;
      wrap.style.fontSize = `${userFontSize}px`;
      chrome.storage.local.set({ fontSize: userFontSize });
    });

    posSlider.addEventListener("input", () => {
      userPositionBottom = Number(posSlider.value);
      posValEl.textContent = `${userPositionBottom}%`;
      wrap.style.bottom = `${userPositionBottom}%`;
      chrome.storage.local.set({ positionBottom: userPositionBottom });
    });

    widthSlider.addEventListener("input", () => {
      userMaxWidthPercent = Number(widthSlider.value);
      widthValEl.textContent = `${userMaxWidthPercent}%`;
      wrap.style.maxWidth = `min(${userMaxWidthPercent}%, 1100px)`;
      chrome.storage.local.set({ maxWidthPercent: userMaxWidthPercent });
    });

    lhSlider.addEventListener("input", () => {
      userLineHeight = Number(lhSlider.value);
      lhValEl.textContent = `${userLineHeight.toFixed(2)}`;
      wrap.style.lineHeight = `${userLineHeight}`;
      chrome.storage.local.set({ lineHeight: userLineHeight });
    });

    shadow.append(style, wrap, dockWrap);
    container.append(host);
  }

  function updateWidgetValues() {
    if (!host) return;
    const fontSlider = host.shadowRoot?.querySelector("#widgetFontInput");
    const posSlider = host.shadowRoot?.querySelector("#widgetPosInput");
    const widthSlider = host.shadowRoot?.querySelector("#widgetWidthInput");
    const lhSlider = host.shadowRoot?.querySelector("#widgetLhInput");
    const fontValEl = host.shadowRoot?.querySelector("#widgetFontVal");
    const posValEl = host.shadowRoot?.querySelector("#widgetPosVal");
    const widthValEl = host.shadowRoot?.querySelector("#widgetWidthVal");
    const lhValEl = host.shadowRoot?.querySelector("#widgetLhVal");
    if (fontSlider) fontSlider.value = userFontSize;
    if (posSlider) posSlider.value = userPositionBottom;
    if (widthSlider) widthSlider.value = userMaxWidthPercent;
    if (lhSlider) lhSlider.value = userLineHeight;
    if (fontValEl) fontValEl.textContent = `${userFontSize}px`;
    if (posValEl) posValEl.textContent = `${userPositionBottom}%`;
    if (widthValEl) widthValEl.textContent = `${userMaxWidthPercent}%`;
    if (lhValEl) lhValEl.textContent = `${userLineHeight.toFixed(2)}`;
  }

  function render() {
    if (!active) return;
    const video = document.querySelector("video");
    if (!host?.isConnected) mountOverlay();
    const time = video?.currentTime ?? -1;

    let text = "";
    if (source === "captions" && batches.length) {
      const batch = batches.find((b) => b.start <= time && time <= b.end);
      const cueList = batch && batch.status === "complete" ? batch.segments : rawSegments;
      const segment = cueList.findLast((item) => item.start <= time && time < item.end);
      text = segment?.text || "";
    } else {
      const segment = segments.findLast((item) => item.start <= time && time < item.end);
      text = segment?.text || "";
    }

    if (textNode) {
      if (textNode.textContent !== text) {
        textNode.textContent = text;
      }
      textNode.style.display = text ? "inline-block" : "none";
    }
    renderFrame = requestAnimationFrame(render);
  }

  function fail(message) {
    error = message;
    phase = "error";
    chrome.runtime.sendMessage({
      type: "LOG_ERROR",
      log: {
        level: "error",
        source: "content",
        message: String(message || ""),
        details: { videoId: currentVideoId, source, phase }
      }
    }).catch(() => {});
    return getState();
  }

  async function handleNavigation() {
    const nextVideoId = getVideoId();
    if (nextVideoId === currentVideoId) return;
    currentVideoId = nextVideoId;
    cancelCurrentJob();
    runId += 1;
    cleanupCapture();
    deactivateOverlay();
    active = false;
    segments = [];
    rawSegments = [];
    batches = [];
    source = null;
    phase = "idle";
    error = "";
    progress = "";
    cachedTracks = [];
    requestCaptionTracks().then((tracks) => {
      cachedTracks = tracks || [];
    }).catch(() => {
      cachedTracks = [];
    });
    await loadDefaultCache();
  }

  async function loadStyleSettings() {
    const s = await chrome.storage.local.get({ fontSize: 24, positionBottom: 8, maxWidthPercent: 90, lineHeight: 1.35 });
    userFontSize = Number(s.fontSize) || 24;
    userPositionBottom = Number(s.positionBottom) || 8;
    userMaxWidthPercent = Number(s.maxWidthPercent) || 90;
    userLineHeight = Number(s.lineHeight) || 1.35;
    applyStyleToOverlay();
  }

  function applyStyleToOverlay() {
    if (!host) return;
    const wrap = host.shadowRoot?.querySelector(".wrap");
    if (wrap) {
      wrap.style.bottom = `${userPositionBottom}%`;
      wrap.style.fontSize = `${userFontSize}px`;
      wrap.style.maxWidth = `min(${userMaxWidthPercent}%, 1100px)`;
      wrap.style.lineHeight = `${userLineHeight}`;
    }
    updateWidgetValues();
  }

  async function loadDefaultCache() {
    if (!currentVideoId) return;
    const defaults = await chrome.storage.local.get({ textModel: "gpt-4o-mini", targetLanguage: "id" });
    const key = captionCacheKey(currentVideoId, defaults.targetLanguage, defaults.textModel);
    const cached = await readCache(key);
    if (cached?.schema === 2 && Array.isArray(cached.batches)) {
      rawSegments = cached.rawSegments || [];
      batches = cached.batches;
      segments = collectCompletedSegments(batches);
      const completed = batches.filter((b) => b.status === "complete").length;
      if (completed > 0) {
        source = "captions";
        phase = completed === batches.length ? "generated" : "generating";
        progress = `${completed}/${batches.length} batch siap dari cache.`;
      }
      return;
    }

    const legacy = await readCache(captionCacheKey(currentVideoId, defaults.targetLanguage, defaults.textModel));
    if (legacy?.schema === 2 && Array.isArray(legacy.batches)) {
      rawSegments = legacy.rawSegments || [];
      batches = legacy.batches;
      segments = collectCompletedSegments(batches);
      const completed = batches.filter((b) => b.status === "complete").length;
      if (completed > 0) {
        source = "captions";
        phase = completed === batches.length ? "generated" : "generating";
        progress = `${completed}/${batches.length} batch siap dari cache.`;
      }
      return;
    }
  }

  async function readCache(key) {
    if (!key) return null;
    try {
      const res = await chrome.runtime.sendMessage({ type: "READ_CACHE", key });
      return res?.result || null;
    } catch {
      return null;
    }
  }

  async function writeCache(record) {
    if (!record || !record.key) return;
    try {
      await chrome.runtime.sendMessage({ type: "WRITE_CACHE", record });
    } catch (e) {
      console.warn("[Subtitle Sync AI] Gagal simpan cache ke background:", e);
    }
  }

  function getVideoTitle() {
    const docTitle = document.title ? document.title.replace(/\s*-\s*YouTube$/, "").trim() : "";
    const h1Title = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, h1.title")?.textContent?.trim();
    return h1Title || docTitle || "";
  }

  function cacheKey(videoId, languageCode, model) {
    return videoId ? JSON.stringify([videoId, languageCode, model]) : "";
  }

  function captionCacheKey(videoId, languageCode, model) {
    return videoId ? JSON.stringify(["captions-v2", videoId, languageCode, model]) : "";
  }

  function originalCacheKey(videoId, trackId, kind) {
    return videoId ? JSON.stringify(["captions-v2", videoId, trackId || "original", kind || "manual", "smart-segmentation"]) : "";
  }

  function getVideoId() {
    return new URL(location.href).searchParams.get("v");
  }

  function debug(message, details) {
    console.debug("[Subtitle Sync AI]", message, details || "");
  }

  function estimateOutputTokens(cueList) {
    const textCharacters = cueList.reduce((total, cue) => total + cue.text.length, 0);
    return Math.ceil(textCharacters / 3.2 + cueList.length * 5);
  }

  function getState() {
    const completedBatches = batches.filter((b) => b.status === "complete").length;
    return {
      phase,
      active,
      segmentCount: segments.length,
      rawSegmentCount: rawSegments.length,
      completedBatches,
      totalBatches: batches.length,
      error,
      progress,
      source,
      videoId: currentVideoId,
      captionAvailable: Boolean(cachedTracks && cachedTracks.length),
      availableTracks: cachedTracks.map((t) => ({
        vssId: t.vssId || t.languageCode,
        languageCode: t.languageCode,
        name: t.name,
        kind: t.kind || "manual",
      })),
    };
  }

  function supportedMimeType() {
    return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
  }
})();
