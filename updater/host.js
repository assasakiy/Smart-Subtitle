#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "qvac-data");
const modelsMarker = path.join(dataDir, "models-ready.json");
const nodeVersionOk = Number(process.versions.node.split(".")[0]) >= 22;
let sdk;
let whisperModelId;
let translationModelId;

fs.mkdirSync(dataDir, { recursive: true });
process.env.QVAC_CACHE_DIR ||= dataDir;
process.env.QVAC_WORKER_PATH ||= path.join(__dirname, "qvac-worker.js");
process.env.QVAC_RPC_INIT_TIMEOUT_MS ||= "60000";

function readMessage() {
  const header = Buffer.alloc(4);
  const bytesRead = fs.readSync(0, header, 0, 4, null);
  if (bytesRead < 4) return null;
  const length = header.readUInt32LE(0);
  const body = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(0, body, offset, length - offset, null);
    if (!read) return null;
    offset += read;
  }
  return JSON.parse(body.toString("utf8"));
}

function sendMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
}

async function getSdk() {
  if (!nodeVersionOk) throw new Error(`QVAC membutuhkan Node.js >=22.17. Versi saat ini ${process.versions.node}.`);
  sdk ||= await import("@qvac/sdk");
  return sdk;
}

function emitProgress(requestId, model, progress) {
  sendMessage({
    requestId,
    event: "progress",
    model,
    percentage: Number(progress.percentage || 0),
    downloaded: Number(progress.downloaded || 0),
    total: Number(progress.total || 0),
  });
}

async function loadWhisper(requestId) {
  const qvac = await getSdk();
  whisperModelId ||= await qvac.loadModel({
    modelSrc: qvac.WHISPER_TINY,
    modelConfig: {
      audio_format: "f32le",
      strategy: "greedy",
      language: "auto",
      translate: false,
      no_timestamps: false,
      single_segment: false,
      token_timestamps: true,
      temperature: 0,
    },
    onProgress: (progress) => emitProgress(requestId, "whisper", progress),
  });
  return whisperModelId;
}

async function loadTranslation(requestId) {
  const qvac = await getSdk();
  translationModelId ||= await qvac.loadModel({
    modelSrc: qvac.QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 },
    onProgress: (progress) => emitProgress(requestId, "translation", progress),
  });
  return translationModelId;
}

async function status() {
  let sdkInstalled = false;
  let sdkVersion = "";
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "node_modules", "@qvac", "sdk", "package.json"), "utf8"));
    sdkInstalled = true;
    sdkVersion = packageJson.version || "";
  } catch {}
  return {
    success: true,
    nodeVersion: process.versions.node,
    nodeVersionOk,
    sdkInstalled,
    sdkVersion,
    whisperLoaded: Boolean(whisperModelId),
    translationLoaded: Boolean(translationModelId),
    modelsDownloaded: fs.existsSync(modelsMarker),
    running: Boolean(whisperModelId && translationModelId),
    dataDir,
  };
}

async function installDependencies() {
  if (!nodeVersionOk) throw new Error(`Pasang Node.js >=22.17 terlebih dahulu. Versi saat ini ${process.versions.node}.`);
  execFileSync("npm", ["install", "@qvac/sdk@^0.19.0", "--save"], { cwd: rootDir, stdio: "ignore", shell: process.platform === "win32" });
  sdk = undefined;
  return { success: true, message: "QVAC SDK berhasil dipasang." };
}

async function downloadModels(requestId) {
  const qvac = await getSdk();
  await qvac.downloadAsset({
    assetSrc: qvac.WHISPER_TINY,
    onProgress: (p) => emitProgress(requestId, "whisper", p),
  });
  await qvac.downloadAsset({
    assetSrc: qvac.QWEN3_600M_INST_Q4,
    onProgress: (p) => emitProgress(requestId, "translation", p),
  });
  fs.writeFileSync(modelsMarker, JSON.stringify({ downloadedAt: Date.now(), whisper: "WHISPER_TINY", translation: "QWEN3_600M_INST_Q4" }));
  return { success: true, message: "Whisper Tiny dan Qwen3 600M berhasil diunduh dan tersimpan di disk." };
}

async function start(requestId) {
  await loadWhisper(requestId);
  await loadTranslation(requestId);
  fs.writeFileSync(modelsMarker, JSON.stringify({ downloadedAt: Date.now(), whisper: "WHISPER_TINY", translation: "QWEN3_600M_INST_Q4" }));
  return { success: true, message: "QVAC lokal aktif.", ...(await status()) };
}

async function stop() {
  const qvac = await getSdk();
  if (whisperModelId) await qvac.unloadModel({ modelId: whisperModelId, clearStorage: false });
  if (translationModelId) await qvac.unloadModel({ modelId: translationModelId, clearStorage: false });
  whisperModelId = undefined;
  translationModelId = undefined;
  return { success: true, message: "Model dilepas dari RAM; file tetap tersimpan." };
}

function normalizeTranscription(result) {
  if (typeof result === "string") return { text: result, segments: [] };
  const text = String(result?.text || result?.transcription || result?.content || "").trim();
  const source = Array.isArray(result?.segments) ? result.segments : [];
  const segments = source.map((segment) => ({
    start: Number(segment.start ?? segment.t0 ?? 0),
    end: Number(segment.end ?? segment.t1 ?? segment.start ?? 0),
    text: String(segment.text || "").trim(),
  })).filter((segment) => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end));
  return { text, segments };
}

async function transcribeAudio(message) {
  const qvac = await getSdk();
  const modelId = await loadWhisper(message.requestId);
  const audioPath = path.join(dataDir, `audio-${message.requestId}.wav`);
  fs.writeFileSync(audioPath, Buffer.from(message.audioBase64, "base64"));
  try {
    const result = await qvac.transcribe({ modelId, audioChunk: audioPath, prompt: message.prompt || "" });
    return { success: true, ...normalizeTranscription(result) };
  } finally {
    fs.rmSync(audioPath, { force: true });
  }
}

function subtitlePrompt(message) {
  return `You are a professional subtitle editor and translator. Translate to ${message.targetLanguage}. Preserve speaker perspective: never swap I/me with you. Return JSON only as {"segments":[{"ids":[0],"text":"..."}]}. Every input id must appear once, in order. Plain text only; no HTML or Markdown. Previous context is reference only and must not be output.\nPrevious context: ${message.previousContext || ""}\nCues: ${JSON.stringify(message.cues || [])}`;
}

async function translateSubtitles(message) {
  const qvac = await getSdk();
  const modelId = await loadTranslation(message.requestId);
  const run = qvac.completion({
    modelId,
    history: [{ role: "user", content: subtitlePrompt(message) }],
    stream: false,
    captureThinking: false,
  });
  const final = await run.final;
  return { success: true, content: final.contentText || final.raw?.fullText || "" };
}

async function cleanup(message) {
  await stop().catch(() => {});
  if (message.models !== false) fs.rmSync(dataDir, { recursive: true, force: true });
  if (message.dependencies) fs.rmSync(path.join(rootDir, "node_modules"), { recursive: true, force: true });
  return { success: true, message: "Data lokal QVAC berhasil dihapus." };
}

async function update(downloadUrl) {
  if (fs.existsSync(path.join(rootDir, ".git"))) {
    execFileSync("git", ["pull", "origin", "main"], { cwd: rootDir, stdio: "ignore" });
    return { success: true, message: "Git pull berhasil." };
  }
  return { success: false, error: `Update ZIP belum didukung host Node. URL: ${downloadUrl || "tidak tersedia"}` };
}

async function dispatch(message) {
  switch (message.action) {
    case "ping": return status();
    case "qvac_status": return status();
    case "qvac_install": return installDependencies();
    case "qvac_download_models": return downloadModels(message.requestId);
    case "qvac_start": return start(message.requestId);
    case "qvac_stop": return stop();
    case "qvac_transcribe": return transcribeAudio(message);
    case "qvac_translate": return translateSubtitles(message);
    case "qvac_cleanup": return cleanup(message);
    case "update": return update(message.downloadUrl);
    default: return { success: false, error: "Aksi tidak diizinkan." };
  }
}

async function main() {
  while (true) {
    let message;
    try {
      message = readMessage();
    } catch (error) {
      sendMessage({ success: false, error: error.message });
      continue;
    }
    if (!message) break;
    try {
      sendMessage({ requestId: message.requestId, ...(await dispatch(message)) });
    } catch (error) {
      sendMessage({ requestId: message.requestId, success: false, error: error.message });
    }
  }
}

main().catch((error) => {
  sendMessage({ success: false, error: error.message });
  process.exitCode = 1;
});
