const LOGS_KEY = "error_logs";
const MAX_LOGS = 100;

export async function addLog({ level = "error", source = "general", message = "", details = null }) {
  try {
    const data = await chrome.storage.local.get({ [LOGS_KEY]: [] });
    const logs = Array.isArray(data[LOGS_KEY]) ? data[LOGS_KEY] : [];
    
    let explanation = "";
    if (message.includes("429")) {
      explanation = "YouTube membatasi request subtitle (Rate Limit). Buka tab YouTube baru, tunggu beberapa saat, atau tonton video lain dulu.";
    } else if (message.includes("Timedtext")) {
      explanation = "Gagal mengambil trek subtitle dari server YouTube.";
    } else if (message.includes("Failed to fetch") || message.includes("Network error")) {
      explanation = "Gagal menghubungi endpoint AI atau host tujuan. Periksa koneksi atau Base URL.";
    }

    const newEntry = {
      id: "log_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
      timestamp: Date.now(),
      level,
      source,
      message: String(message || ""),
      explanation,
      details: details ? (typeof details === "string" ? details : JSON.stringify(details, null, 2)) : null,
    };

    logs.unshift(newEntry);
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;

    await chrome.storage.local.set({ [LOGS_KEY]: logs });
  } catch (err) {
    console.error("[Logger] Gagal menyimpan log:", err);
  }
}

export async function getLogs() {
  const data = await chrome.storage.local.get({ [LOGS_KEY]: [] });
  return Array.isArray(data[LOGS_KEY]) ? data[LOGS_KEY] : [];
}

export async function clearLogs() {
  await chrome.storage.local.set({ [LOGS_KEY]: [] });
  return true;
}

export async function deleteLog(id) {
  const data = await chrome.storage.local.get({ [LOGS_KEY]: [] });
  const logs = (Array.isArray(data[LOGS_KEY]) ? data[LOGS_KEY] : []).filter((l) => l.id !== id);
  await chrome.storage.local.set({ [LOGS_KEY]: logs });
  return true;
}
