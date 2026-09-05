const DEFAULTS = {
  baseUrl: "",
  apiKey: "",
  transcriptionModel: "whisper-1",
  textModel: "gpt-4o-mini",
  targetLanguage: "id",
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tasks = {
    LIST_MODELS: () => listModels(message),
    TRANSCRIBE_CHUNK: () => transcribe(message, sender.tab?.id),
    ENHANCE_CAPTIONS: () => enhanceCaptions(message, sender.tab?.id),
    READ_CACHE: () => readCacheItem(message.key),
    WRITE_CACHE: () => writeCacheItem(message.record),
    LIST_CACHE: () => listCacheItems(),
    DELETE_CACHE: () => deleteCacheItem(message.key),
    DELETE_BATCH_CACHE: () => deleteBatchCacheItems(message.keys),
    CLEAR_ALL_CACHE: () => clearAllCache(),
  };
  if (!tasks[message.type]) return;

  tasks[message.type]().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("subtitle-sync-ai", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("captions", { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function listCacheItems() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("captions", "readonly");
    const store = tx.objectStore("captions");
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result || []).map((item) => {
        let segCount = 0;
        if (Array.isArray(item.segments)) segCount = item.segments.length;
        else if (Array.isArray(item.batches)) {
          segCount = item.batches.reduce((acc, b) => acc + (b.segments ? b.segments.length : 0), 0);
        }
        return {
          key: item.key,
          videoId: item.videoId || "unknown",
          videoTitle: item.videoTitle || item.title || "",
          targetLanguage: item.targetLanguage || "id",
          textModel: item.textModel || "",
          processing: item.processing || (item.textModel ? "ai" : "smart"),
          schema: item.schema || 1,
          segmentCount: segCount,
          createdAt: item.createdAt || Date.now(),
          updatedAt: item.updatedAt || item.createdAt || Date.now(),
        };
      });
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve({ ok: true, items });
    };
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

async function readCacheItem(key) {
  if (!key) return { ok: true, result: null };
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("captions", "readonly");
    const req = tx.objectStore("captions").get(key);
    req.onsuccess = () => resolve({ ok: true, result: req.result || null });
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

async function writeCacheItem(record) {
  if (!record || !record.key) throw new Error("Record atau key tidak valid.");
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("captions", "readwrite");
    tx.objectStore("captions").put(record);
    tx.oncomplete = () => resolve({ ok: true });
    tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
}

async function deleteBatchCacheItems(keys) {
  if (!Array.isArray(keys) || !keys.length) return { ok: true };
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("captions", "readwrite");
    const store = tx.objectStore("captions");
    for (const key of keys) {
      store.delete(key);
    }
    tx.oncomplete = () => resolve({ ok: true });
    tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
}

async function clearAllCache() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("captions", "readwrite");
    tx.objectStore("captions").clear();
    tx.oncomplete = () => resolve({ ok: true });
    tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
}

async function listModels(overrides = {}) {
  const settings = { ...await chrome.storage.local.get(DEFAULTS), ...overrides };
  requireSettings(settings, false);
  const response = await fetchWithTimeout(`${normalizeBaseUrl(settings.baseUrl)}/models`, {
    headers: authHeaders(settings.apiKey),
  });
  const payload = await parseResponse(response, "Model");
  const source = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const models = source.map((model) => typeof model === "string" ? model : model?.id).filter(Boolean).sort();
  return { ok: true, models };
}

async function transcribe({ audio, mimeType, transcriptionModel, textModel, targetLanguage }) {
  const settings = {
    ...await chrome.storage.local.get(DEFAULTS),
    transcriptionModel,
    textModel,
    targetLanguage,
  };
  requireSettings(settings, true);

  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimeType }), `chunk.${extensionFor(mimeType)}`);
  form.append("model", settings.transcriptionModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const response = await fetchWithTimeout(`${normalizeBaseUrl(settings.baseUrl)}/audio/transcriptions`, {
    method: "POST",
    headers: authHeaders(settings.apiKey),
    body: form,
  }, 90000);
  const payload = await parseResponse(response, "Transkripsi");
  const segments = Array.isArray(payload.segments)
    ? payload.segments.map(({ start, end, text }) => ({
        start: Number(start),
        end: Number(end),
        text: String(text || "").trim(),
      })).filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.text)
    : [];

  const translated = await translateSegments(segments, settings);
  return { ok: true, segments: translated, text: String(payload.text || "").trim() };
}

async function enhanceCaptions({ segments, textModel, targetLanguage, jobId, batchId }, tabId) {
  if (!Array.isArray(segments) || !segments.length || segments.length > 10000) throw new Error("Segmen caption tidak valid.");
  const cleanSegments = segments.map(({ id, start, end, text }) => ({
    id: Number(id),
    start: Number(start),
    end: Number(end),
    text: String(text || "").slice(0, 1000),
  }));
  if (cleanSegments.some((segment) => !Number.isFinite(segment.id) || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end < segment.start)) {
    throw new Error("Timestamp atau ID caption tidak valid.");
  }

  const settings = { ...await chrome.storage.local.get(DEFAULTS), textModel, targetLanguage };
  requireSettings(settings, false);
  if (!settings.textModel || !settings.targetLanguage) throw new Error("Pilih model terjemahan dan bahasa target.");

  notifyProgress(tabId, { jobId, batchId, message: `Memproses batch ${Number(batchId) + 1}…` });
  const output = await refineSegmentBatch(cleanSegments, settings, true, false, tabId, { jobId, batchId });
  return { ok: true, jobId, batchId, segments: output };
}

async function translateSegments(segments, settings) {
  if (!segments.length || !settings.targetLanguage || !settings.textModel) return segments;
  return refineSegmentBatch(segments.map((segment, id) => ({ ...segment, id })), settings, false, false, null, {});
}

async function refineSegmentBatch(segments, settings, allowGrouping = true, retry = false, tabId = null, meta = {}) {
  const estimatedOutputTokens = estimateOutputTokens(segments);
  const requestBody = {
    model: settings.textModel,
    temperature: 0,
    stream: false,
    max_tokens: Math.min(8192, Math.max(5500, Math.ceil(estimatedOutputTokens * 1.08))),
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Perbaiki ejaan, tanda baca, kapitalisasi, segmentasi natural, dan terjemahkan ke bahasa ${settings.targetLanguage}. Input berbentuk [id,text]. ${allowGrouping ? "Gabungkan hanya ID berurutan bila membentuk kalimat natural." : "Jangan gabungkan segmen."} Setiap ID wajib muncul tepat sekali, urut, tanpa hilang atau duplikat. Balas JSON valid tanpa markdown: {"segments":[{"ids":[0,1],"text":"..."}]}`,
      },
      { role: "user", content: JSON.stringify({ cues: segments.map(({ id, text }) => [id, text]), retry: retry ? "Output sebelumnya gagal validasi. Patuhi semua ID." : undefined }) },
    ],
  };
  const payload = await requestChatCompletion(settings, requestBody, tabId, meta);

  const content = extractAssistantContent(payload);
  const result = parseJsonContent(content);
  try {
    return reconstructSegments(segments, result);
  } catch (error) {
    console.error("[Subtitle Sync AI] Output AI gagal validasi", {
      ...summarizePayload(payload),
      validationError: error.message,
      assistantContent: typeof content === "string" ? content : JSON.stringify(content),
    });
    if (!retry) {
      notifyProgress(tabId, { ...meta, message: `Output batch ${Number(meta.batchId || 0) + 1} tidak valid. Mengulang…` });
      return refineSegmentBatch(segments, settings, allowGrouping, true, tabId, meta);
    }
    throw new Error(`[AI] ${error.message}`);
  }
}

async function requestChatCompletion(settings, body, tabId, meta = {}) {
  const url = `${normalizeBaseUrl(settings.baseUrl)}/chat/completions`;
  const retryableStatuses = new Set([429, 500, 502, 503, 504]);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    notifyProgress(tabId, { ...meta, message: `Menghubungi AI (batch ${Number(meta.batchId || 0) + 1}) — percobaan ${attempt}/3…` });
    let response;
    try {
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { ...authHeaders(settings.apiKey), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 180000);
    } catch (error) {
      if (attempt === 3) throw error;
      const delayMs = attempt * 2000;
      console.warn("[Subtitle Sync AI] Network/timeout gagal; retry", { attempt, nextAttempt: attempt + 1, delayMs, error: error.message });
      notifyProgress(tabId, { ...meta, message: `Percobaan ${attempt} gagal. Retry dalam ${delayMs / 1000} detik…` });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (response.ok || !retryableStatuses.has(response.status) || attempt === 3) return parseResponse(response, "Terjemahan");
    const delayMs = attempt * 2000;
    console.warn("[Subtitle Sync AI] Provider sementara gagal; retry", { status: response.status, attempt, nextAttempt: attempt + 1, delayMs });
    notifyProgress(tabId, { ...meta, message: `Provider HTTP ${response.status}. Retry dalam ${delayMs / 1000} detik…` });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function notifyProgress(tabId, payload) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "AI_PROGRESS", payload }).catch(() => {});
}

function estimateOutputTokens(segments) {
  const textCharacters = segments.reduce((total, segment) => total + (segment.text ? segment.text.length : 0), 0);
  return Math.ceil(textCharacters / 3.2 + segments.length * 5);
}

function reconstructSegments(input, result) {
  if (!Array.isArray(result?.segments) || !result.segments.length) throw new Error("Respons tidak memiliki segments.");
  const expectedIds = input.map(({ id }) => id);
  const outputIds = result.segments.flatMap((segment) => Array.isArray(segment.ids) ? segment.ids : []);
  if (outputIds.length !== expectedIds.length || outputIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error(`Coverage ID tidak valid. Diharapkan ${expectedIds[0]}–${expectedIds.at(-1)} berurutan.`);
  }

  const byId = new Map(input.map((segment) => [segment.id, segment]));
  return result.segments.map((group) => {
    if (!group.ids.length || !String(group.text || "").trim()) throw new Error("Group memiliki ids/text kosong.");
    if (group.ids.some((id, index) => index && id !== group.ids[index - 1] + 1)) throw new Error("Group memakai ID tidak berurutan.");
    const first = byId.get(group.ids[0]);
    const last = byId.get(group.ids.at(-1));
    if (!first || !last) throw new Error("Group memakai ID di luar input.");
    return {
      start: Math.max(0, first.start - 0.08),
      end: last.end + 0.12,
      text: String(group.text).trim(),
    };
  });
}

function extractAssistantContent(payload) {
  const content = payload?.choices?.[0]?.message?.content
    ?? payload?.choices?.[0]?.text
    ?? payload?.output_text
    ?? payload?.output?.[0]?.content
    ?? payload;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? "").join("");
  }
  return content;
}

function parseJsonContent(content) {
  if (content && typeof content === "object") return content;
  if (typeof content !== "string" || !content.trim()) return null;
  let clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const parsed = JSON.parse(clean);
      if (typeof parsed === "string") {
        clean = parsed.trim();
        continue;
      }
      return parsed;
    } catch {}
    break;
  }

  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced.trim()); } catch {}
  }

  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
  }
  return null;
}

function describeContent(content) {
  if (content == null) return "kosong";
  if (Array.isArray(content)) return "array";
  if (typeof content === "object") return "object";
  return `${typeof content} ${String(content).length} karakter`;
}

function summarizePayload(payload) {
  return {
    keys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    finishReason: payload?.choices?.[0]?.finish_reason,
    contentType: describeContent(payload?.choices?.[0]?.message?.content),
  };
}

async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  const request = {
    requestId,
    url,
    method: options.method || "GET",
    headers: redactHeaders(options.headers),
    body: describeRequestBody(options.body),
    timeoutMs,
  };
  console.groupCollapsed(`[Subtitle Sync AI] Request ${request.method} ${url}`);
  console.log(request);
  console.groupEnd();

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const responseBody = await response.clone().text().catch((error) => `[gagal membaca body: ${error.message}]`);
    console.groupCollapsed(`[Subtitle Sync AI] Response ${response.status} ${url}`);
    console.log({
      requestId,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      durationMs: Math.round(performance.now() - startedAt),
      body: responseBody,
    });
    console.groupEnd();
    return response;
  } catch (error) {
    console.error(`[Subtitle Sync AI] Network error ${url}`, {
      requestId,
      name: error.name,
      message: error.message,
      durationMs: Math.round(performance.now() - startedAt),
      hint: "Periksa izin host extension, Base URL, CORS provider, DNS, TLS, dan koneksi internet.",
    });
    throw new Error(`Request gagal ke ${url}: ${error.message}. Periksa service worker console untuk detail.`);
  } finally {
    clearTimeout(timeout);
  }
}

function redactHeaders(headers = {}) {
  const result = Object.fromEntries(new Headers(headers).entries());
  if (result.authorization) result.authorization = "Bearer [REDACTED]";
  return result;
}

function describeRequestBody(body) {
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return body; }
  }
  if (body instanceof FormData) {
    return Object.fromEntries([...body.entries()].map(([key, value]) => [
      key,
      value instanceof Blob ? { type: value.type, size: value.size, name: value.name || "blob" } : value,
    ]));
  }
  return body ?? null;
}

async function parseResponse(response, stage) {
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch {
    payload = parseSseResponse(text);
  }
  if (!response.ok) throw new Error(payload?.error?.message || `${stage} gagal: HTTP ${response.status}${text ? ` — ${text.slice(0, 160)}` : ""}`);
  if (!text) throw new Error(`${stage} mengembalikan body kosong.`);
  if (!payload) throw new Error(`${stage} mengembalikan format tidak dikenal: ${text.slice(0, 160)}`);
  return payload;
}

function parseSseResponse(text) {
  const chunks = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data && data !== "[DONE]");
  if (!chunks.length) return null;

  let content = "";
  let model = "";
  let finishReason = null;
  for (const chunk of chunks) {
    let payload;
    try { payload = JSON.parse(chunk); } catch { continue; }
    model ||= payload.model || "";
    const choice = payload.choices?.[0];
    const part = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? "";
    content += Array.isArray(part) ? part.map((item) => item?.text ?? "").join("") : part;
    finishReason = choice?.finish_reason ?? finishReason;
  }
  return content ? { model, choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }] } : null;
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function requireSettings(settings, includeModels) {
  if (!settings.baseUrl) throw new Error("Lengkapi endpoint di Pengaturan.");
  if (includeModels && (!settings.transcriptionModel || !settings.textModel)) throw new Error("Pilih model transkripsi dan terjemahan.");
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, "");
}

function extensionFor(mimeType) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}
