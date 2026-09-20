#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "qvac-data");
const modelsMarker = path.join(dataDir, "models-ready.json");
const hostLogPath = path.join(dataDir, "native-host.log");
const nodeVersionOk = Number(process.versions.node.split(".")[0]) >= 22;
let sdk;
let whisperModelId;
let translationModelId;
let qvacRunner;
let runnerRunning = false;
const runnerRequests = new Map();

fs.mkdirSync(dataDir, { recursive: true });
const logStream = fs.createWriteStream(hostLogPath, { flags: "a" });
const writeLog = (...args) => {
  const line = args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
  logStream.write(`[${new Date().toISOString()}] ${line}\n`);
};
console.log = writeLog;
console.info = writeLog;
console.debug = writeLog;
console.warn = writeLog;
console.error = writeLog;
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

function formatError(error) {
  const cause = error?.cause;
  const detail = cause?.stderrTail || cause?.message || "";
  const missing = detail.match(/Cannot find module '([^']+)'/)?.[1];
  if (missing) return `Dependency ${missing} belum terpasang lengkap. Klik Pasang QVAC SDK lagi.`;
  if (detail) return `${error.message}\n${detail.slice(-1200)}`;
  return error?.message || String(error);
}

function sendMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  fs.writeSync(1, header);
  fs.writeSync(1, payload);
}

async function getSdk() {
  if (!nodeVersionOk) throw new Error(`QVAC membutuhkan Node.js >=22.17. Versi saat ini ${process.versions.node}.`);
  if (!packageReady("sdk") || !packageReady("asr-ggml") || !packageReady("llm-llamacpp")) {
    throw new Error("Dependency QVAC belum lengkap. Klik Pasang QVAC SDK terlebih dahulu.");
  }
  sdk ||= await import("@qvac/sdk");
  return sdk;
}

function emitProgress(requestId, model, progress) {
  sendMessage({
    requestId,
    event: "progress",
    stage: "models",
    model,
    percentage: Number(progress.percentage || 0),
    downloaded: Number(progress.downloaded || 0),
    total: Number(progress.total || 0),
  });
}

function emitStage(requestId, stage, message) {
  sendMessage({ requestId, event: "progress", stage, message });
}

function packageReady(name) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "node_modules", "@qvac", name, "package.json"), "utf8"));
    return Boolean(packageJson.name);
  } catch {
    return false;
  }
}

function getQvacRunner() {
  if (qvacRunner?.connected) return qvacRunner;
  const runnerLog = fs.createWriteStream(path.join(dataDir, "qvac-runner.log"), { flags: "a" });
  qvacRunner = fork(path.join(__dirname, "qvac-runner.js"), [], {
    cwd: rootDir,
    stdio: ["ignore", runnerLog, runnerLog, "ipc"],
    env: { ...process.env, QVAC_CACHE_DIR: dataDir, QVAC_WORKER_PATH: path.join(__dirname, "qvac-worker.js"), QVAC_RPC_INIT_TIMEOUT_MS: "60000" },
  });
  qvacRunner.on("message", (message) => {
    if (message.event === "progress") {
      sendMessage(message);
      return;
    }
    const request = runnerRequests.get(message.requestId);
    if (!request) return;
    runnerRequests.delete(message.requestId);
    if (message.success && typeof message.running === "boolean") runnerRunning = message.running;
    message.success ? request.resolve(message) : request.reject(new Error(message.error || "QVAC runner gagal."));
  });
  qvacRunner.on("exit", (code, signal) => {
    const error = new Error(`QVAC runner berhenti (code ${code}, signal ${signal || "none"}). Lihat qvac-data/qvac-runner.log.`);
    for (const request of runnerRequests.values()) request.reject(error);
    runnerRequests.clear();
    runnerRunning = false;
    qvacRunner = undefined;
  });
  return qvacRunner;
}

function runQvac(message) {
  return new Promise((resolve, reject) => {
    runnerRequests.set(message.requestId, { resolve, reject });
    getQvacRunner().send(message, (error) => {
      if (!error) return;
      runnerRequests.delete(message.requestId);
      reject(error);
    });
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
  let sdkVersion = "";
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "node_modules", "@qvac", "sdk", "package.json"), "utf8"));
    sdkVersion = packageJson.version || "";
  } catch {}
  const sdkInstalled = packageReady("sdk") && packageReady("asr-ggml") && packageReady("llm-llamacpp");
  return {
    success: true,
    nodeVersion: process.versions.node,
    nodeVersionOk,
    sdkInstalled,
    sdkVersion,
    whisperLoaded: Boolean(whisperModelId),
    translationLoaded: Boolean(translationModelId),
    modelsDownloaded: fs.existsSync(modelsMarker),
    running: runnerRunning || Boolean(whisperModelId && translationModelId),
    dataDir,
  };
}

async function installDependencies(requestId) {
  if (!nodeVersionOk) throw new Error(`Pasang Node.js >=22.17 terlebih dahulu. Versi saat ini ${process.versions.node}.`);
  emitStage(requestId, "dependencies", "Mengunduh QVAC SDK dan backend Whisper/Qwen…");
  await new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(command, [
      "install",
      "@qvac/sdk@^0.19.1",
      "@qvac/asr-ggml@^0.3.3",
      "@qvac/llm-llamacpp@^0.49.2",
      "--save",
      "--no-audit",
      "--no-fund",
    ], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `npm install gagal dengan exit code ${code}.`)));
  });
  sdk = undefined;
  if (!packageReady("sdk") || !packageReady("asr-ggml") || !packageReady("llm-llamacpp")) {
    throw new Error("Instalasi QVAC belum lengkap. Coba Pasang QVAC SDK lagi.");
  }
  emitStage(requestId, "dependencies", "Dependency QVAC lengkap.");
  return { success: true, message: "QVAC SDK, backend Whisper, dan backend Qwen berhasil dipasang." };
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
    case "qvac_install": return installDependencies(message.requestId);
    case "qvac_download_models":
      emitStage(message.requestId, "models", "Menghubungkan registry QVAC dan menyiapkan unduhan model…");
      return runQvac(message);
    case "qvac_start":
      emitStage(message.requestId, "models", "Menjalankan worker dan memuat model ke RAM…");
      return runQvac(message);
    case "qvac_stop": return runQvac(message);
    case "qvac_transcribe": return runQvac(message);
    case "qvac_translate": return runQvac(message);
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
      sendMessage({ success: false, error: formatError(error) });
      continue;
    }
    if (!message) break;
    try {
      sendMessage({ requestId: message.requestId, ...(await dispatch(message)) });
    } catch (error) {
      sendMessage({ requestId: message.requestId, success: false, error: formatError(error) });
    }
  }
}

main().catch((error) => {
  sendMessage({ success: false, error: formatError(error) });
  process.exitCode = 1;
});
