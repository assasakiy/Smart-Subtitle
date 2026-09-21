import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "qvac-data");
const modelsMarker = path.join(dataDir, "models-ready.json");
let sdk;
let whisperModelId;
let translationModelId;

fs.mkdirSync(dataDir, { recursive: true });
process.env.QVAC_CACHE_DIR ||= dataDir;
process.env.QVAC_WORKER_PATH ||= path.join(__dirname, "qvac-worker.js");
process.env.QVAC_RPC_INIT_TIMEOUT_MS ||= "60000";

const send = (message) => process.send?.(message);
const packageReady = (name) => {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(rootDir, "node_modules", "@qvac", name, "package.json"), "utf8")).name);
  } catch {
    return false;
  }
};

async function getSdk() {
  if (!packageReady("sdk") || !packageReady("asr-ggml") || !packageReady("llm-llamacpp")) throw new Error("Dependency QVAC belum lengkap.");
  sdk ||= await import("@qvac/sdk");
  return sdk;
}

const progress = (requestId, model, value) => send({ requestId, event: "progress", stage: "models", model, percentage: Number(value.percentage || 0), downloaded: Number(value.downloaded || 0), total: Number(value.total || 0) });

async function loadWhisper(requestId) {
  const qvac = await getSdk();
  whisperModelId ||= await qvac.loadModel({ modelSrc: qvac.WHISPER_TINY, modelConfig: { audio_format: "f32le", strategy: "greedy", language: "auto", translate: false, no_timestamps: false, single_segment: false, token_timestamps: true, temperature: 0 }, onProgress: (p) => progress(requestId, "whisper", p) });
  return whisperModelId;
}

async function loadTranslation(requestId) {
  const qvac = await getSdk();
  translationModelId ||= await qvac.loadModel({ modelSrc: qvac.QWEN3_600M_INST_Q4, modelConfig: { ctx_size: 4096 }, onProgress: (p) => progress(requestId, "translation", p) });
  return translationModelId;
}

async function dispatch(message) {
  if (message.action === "qvac_runner_status") return { success: true, running: Boolean(whisperModelId && translationModelId), whisperLoaded: Boolean(whisperModelId), translationLoaded: Boolean(translationModelId) };
  const qvac = await getSdk();
  if (message.action === "qvac_download_models") {
    const selected = Array.isArray(message.models) && message.models.length ? message.models : ["whisper", "translation"];
    const saved = fs.existsSync(modelsMarker) ? JSON.parse(fs.readFileSync(modelsMarker, "utf8")) : {};
    if (selected.includes("whisper")) {
      await qvac.downloadAsset({ assetSrc: qvac.WHISPER_TINY, onProgress: (p) => progress(message.requestId, "whisper", p) });
      saved.whisper = true;
    }
    if (selected.includes("translation")) {
      await qvac.downloadAsset({ assetSrc: qvac.QWEN3_600M_INST_Q4, onProgress: (p) => progress(message.requestId, "translation", p) });
      saved.translation = true;
    }
    saved.updatedAt = Date.now();
    fs.writeFileSync(modelsMarker, JSON.stringify(saved));
    return { success: true, message: `${selected.length} model berhasil diunduh.` };
  }
  if (message.action === "qvac_start") {
    await loadWhisper(message.requestId);
    await loadTranslation(message.requestId);
    fs.writeFileSync(modelsMarker, JSON.stringify({ downloadedAt: Date.now() }));
    return { success: true, message: "QVAC lokal aktif.", running: true };
  }
  if (message.action === "qvac_stop") {
    if (whisperModelId) await qvac.unloadModel({ modelId: whisperModelId, clearStorage: false });
    if (translationModelId) await qvac.unloadModel({ modelId: translationModelId, clearStorage: false });
    whisperModelId = undefined;
    translationModelId = undefined;
    return { success: true, message: "Model dilepas dari RAM.", running: false };
  }
  if (message.action === "qvac_transcribe") {
    const modelId = await loadWhisper(message.requestId);
    const audioPath = path.join(dataDir, `audio-${message.requestId}.wav`);
    fs.writeFileSync(audioPath, Buffer.from(message.audioBase64, "base64"));
    try {
      const result = await qvac.transcribe({ modelId, audioChunk: audioPath, prompt: message.prompt || "" });
      return { success: true, text: typeof result === "string" ? result : String(result?.text || result?.transcription || ""), segments: Array.isArray(result?.segments) ? result.segments : [] };
    } finally { fs.rmSync(audioPath, { force: true }); }
  }
  if (message.action === "qvac_translate") {
    const modelId = await loadTranslation(message.requestId);
    const prompt = `Translate to ${message.targetLanguage}. Preserve speaker perspective. Return JSON only: {"segments":[{"ids":[0],"text":"..."}]}. Plain text only. Context: ${message.previousContext || ""}\nCues: ${JSON.stringify(message.cues || [])}`;
    const run = qvac.completion({ modelId, history: [{ role: "user", content: prompt }], stream: false, captureThinking: false });
    const final = await run.final;
    return { success: true, content: final.contentText || final.raw?.fullText || "" };
  }
  throw new Error(`Aksi runner tidak dikenal: ${message.action}`);
}

process.on("message", async (message) => {
  try { send({ requestId: message.requestId, ...(await dispatch(message)) }); }
  catch (error) { send({ requestId: message.requestId, success: false, error: error?.cause?.stderrTail || error.message || String(error) }); }
});
