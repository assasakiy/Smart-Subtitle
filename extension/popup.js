const DEFAULTS = {
  transcriptionModel: "whisper-1",
  textModel: "gpt-4o-mini",
  targetLanguage: "id",
  cachedModels: [],
  fontSize: 24,
  positionBottom: 8,
  maxWidthPercent: 90,
};

const GLOBAL_TRANSLATE_LANGUAGES = [
  { code: "id", name: "Bahasa Indonesia" },
  { code: "en", name: "English" },
  { code: "ms", name: "Bahasa Melayu" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "zh", name: "中文" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "ar", name: "العربية" },
  { code: "pt", name: "Português" },
  { code: "ru", name: "Русский" },
];

const source = document.querySelector("#source");
const audioMode = document.querySelector("#audioMode");
const audioModeField = document.querySelector("#audioModeField");
const asrModelField = document.querySelector("#asrModelField");
const textModelField = document.querySelector("#textModelField");
const textModel = document.querySelector("#textModel");
const language = document.querySelector("#language");
const languageLabel = document.querySelector("#languageLabel");

const generate = document.querySelector("#generate");
const activate = document.querySelector("#activate");
const status = document.querySelector("#status");

let tab;
let busy = false;
let progressTimer;
let savedDefaultTargetLang = "id";
let state = {
  phase: "idle",
  active: false,
  segmentCount: 0,
  completedBatches: 0,
  totalBatches: 0,
  error: "",
  captionAvailable: null, // null = belum selesai diperiksa dari tab
  availableTracks: [],
};

init();
source.addEventListener("change", onSourceChanged);
language.addEventListener("change", onTargetChanged);
textModel.addEventListener("change", onTargetChanged);
document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
generate.addEventListener("click", generateSubtitles);
activate.addEventListener("click", toggleSubtitle);

async function init() {
  initCustomSelects();
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.querySelector("#popupVersion");
  if (versionEl && manifest?.version) {
    versionEl.textContent = `v${manifest.version}`;
  }

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await chrome.storage.local.get(DEFAULTS);
  savedDefaultTargetLang = settings.targetLanguage || "id";

  const models = settings.cachedModels.length ? settings.cachedModels : [settings.transcriptionModel, settings.textModel];
  setModels(models, settings.transcriptionModel, transcriptionModel);
  setModels(models, settings.textModel, textModel);

  if (!settings.cachedModels.length) status.textContent = "Cache model kosong. Perbarui dari Pengaturan.";
  if (!tab?.url?.startsWith("https://www.youtube.com/")) return disableForPage("Buka video YouTube lebih dulu.");
  await refreshState();
}

async function onSourceChanged() {
  renderSourceFields();
  await onTargetChanged();
}

async function onTargetChanged() {
  if (!tab?.id) return;
  const mode = source.value;
  const response = await sendToTab({
    type: "SWITCH_TARGET",
    sourceMode: mode,
    trackId: language.value,
    targetLanguage: language.value,
    textModel: textModel.value,
  });
  if (response) state = response;
  render();
}

function setModels(models, selected, select) {
  const unique = [...new Set([selected, ...models].filter(Boolean))];
  select.replaceChildren(...unique.map((id) => Object.assign(document.createElement("option"), { value: id, textContent: id, title: id })));
  select.value = selected || unique[0] || "";
  syncCustomSelect(select);
}

function renderSourceFields() {
  const mode = source.value;
  if (mode === "original") {
    textModelField.classList.add("hidden");
    audioModeField.classList.add("hidden");
    asrModelField.classList.add("hidden");
    languageLabel.textContent = "Track Subtitle YouTube";
    populateOriginalTracks();
  } else if (mode === "captions") {
    textModelField.classList.remove("hidden");
    audioModeField.classList.add("hidden");
    asrModelField.classList.add("hidden");
    languageLabel.textContent = "Bahasa Target";
    populateAILanguages();
  }
}

function populateOriginalTracks() {
  const tracks = state.availableTracks || [];
  if (!tracks.length) {
    language.replaceChildren(Object.assign(document.createElement("option"), {
      value: "",
      textContent: "Tidak ada subtitle di video ini",
    }));
    syncCustomSelect(language);
    return;
  }
  language.replaceChildren(...tracks.map((t) => {
    const opt = document.createElement("option");
    opt.value = t.vssId || t.languageCode;
    const kindLabel = t.kind === "asr" ? "(Auto-generated)" : "(Manual)";
    opt.textContent = `${t.name || t.languageCode} ${kindLabel}`;
    return opt;
  }));
  syncCustomSelect(language);
}

function populateAILanguages() {
  language.replaceChildren(...GLOBAL_TRANSLATE_LANGUAGES.map((l) => {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    return opt;
  }));
  language.value = savedDefaultTargetLang;
  syncCustomSelect(language);
}

async function refreshState() {
  const response = await sendToTab({ type: "GET_STATE" });
  if (!response) return disableForPage("Muat ulang halaman YouTube.");
  state = response;

  // Pulihkan pilihan sumber subtitle jika sedang aktif atau tersimpan di tab
  if (state.source === "original" || state.source === "captions" || state.source === "audio") {
    source.value = state.source;
  }
  renderSourceFields();

  // Pulihkan track / bahasa yang sedang dipakai
  if (state.source === "original" && state.currentTrackId) {
    if (language.querySelector(`option[value="${state.currentTrackId}"]`)) {
      language.value = state.currentTrackId;
      syncCustomSelect(language);
    }
  } else if (state.source === "captions") {
    if (state.currentTargetLanguage && language.querySelector(`option[value="${state.currentTargetLanguage}"]`)) {
      language.value = state.currentTargetLanguage;
      syncCustomSelect(language);
    }
    if (state.currentTextModel && textModel.querySelector(`option[value="${state.currentTextModel}"]`)) {
      textModel.value = state.currentTextModel;
      syncCustomSelect(textModel);
    }
  }

  render();
}

async function generateSubtitles() {
  if (busy) return;
  const mode = source.value;
  busy = true;

  if (mode === "original") {
    renderBusy("Menerapkan…");
    status.classList.remove("error");
    status.textContent = "Memproses segmentasi kalimat natural YouTube secara lokal…";
    try {
      state = await sendToTab({
        type: "GENERATE",
        sourceMode: "original",
        trackId: language.value,
        targetLanguage: language.value,
      }) || state;
    } finally {
      busy = false;
      render();
    }
    return;
  }

  // mode AI Captions
  renderBusy("Menyiapkan batch…");
  status.classList.remove("error");
  status.textContent = "Mempersiapkan smart segmentation & batch AI…";
  progressTimer = setInterval(refreshProgress, 750);
  try {
    const res = await sendToTab({
      type: "GENERATE",
      sourceMode: "captions",
      transcriptionModel: transcriptionModel.value,
      textModel: textModel.value,
      targetLanguage: language.value,
    });
    if (res) state = res;
  } finally {
    busy = false;
    render();
    // Biarkan progress polling tetap jalan di background jika masih generating
    if (state.phase === "generating" && !progressTimer) {
      progressTimer = setInterval(refreshProgress, 750);
    }
  }
}

async function refreshProgress() {
  const response = await sendToTab({ type: "GET_STATE" });
  if (!response) return;
  state = response;
  render();
  // Hentikan timer jika selesai atau error
  if (state.phase !== "generating" && progressTimer) {
    clearInterval(progressTimer);
    progressTimer = undefined;
  }
}

async function toggleSubtitle() {
  if (busy) return;
  busy = true;
  activate.disabled = true;
  activate.textContent = state.active ? "Menonaktifkan…" : "Mengaktifkan…";
  status.textContent = state.active ? "Menghapus overlay subtitle…" : "Memasang overlay subtitle ke player…";
  try {
    state = await sendToTab({ type: state.active ? "DEACTIVATE" : "ACTIVATE" }) || state;
  } finally {
    busy = false;
    render();
  }
}

function renderBusy(label) {
  generate.disabled = true;
  activate.disabled = true;
  generate.classList.add("loading");
  generate.textContent = label;
  source.disabled = true;
  audioMode.disabled = true;
  transcriptionModel.disabled = true;
  textModel.disabled = true;
  language.disabled = true;
}

function render() {
  const mode = source.value;
  const isCaptions = state.source === "captions";
  const generating = state.phase === "generating";
  const isCompletedFromCache = state.phase === "generated" && (state.segmentCount > 0);
  const hasUsableSubtitles = (state.completedBatches > 0) || (state.segmentCount > 0);
  const noCaptionAvailable = state.captionAvailable === false && state.availableTracks?.length === 0;

  generate.classList.remove("loading");

  if (noCaptionAvailable) {
    generate.disabled = true;
    generate.textContent = "Tidak Ada Subtitle";
    source.disabled = true;
    language.disabled = true;
    activate.disabled = true;
    status.textContent = "Video ini tidak memiliki subtitle dari YouTube.";
    return;
  }

  if (isCompletedFromCache) {
    generate.disabled = true;
    generate.textContent = "Sudah Tersimpan";
  } else {
    generate.disabled = generating;
    generate.textContent = generating && isCaptions
      ? `Memproses (${state.completedBatches || 0}/${state.totalBatches || "?"})…`
      : mode === "original"
        ? "Terapkan Subtitle"
        : "Generate Subtitle";
  }

  source.disabled = generating;
  audioMode.disabled = generating;
  transcriptionModel.disabled = generating;
  textModel.disabled = generating;
  language.disabled = generating;

  syncCustomSelect(source);
  syncCustomSelect(textModel);
  syncCustomSelect(language);
  syncCustomSelect(transcriptionModel);

  // Tombol aktifkan langsung terbuka begitu batch 1 atau fallback lokal siap!
  activate.disabled = busy || !hasUsableSubtitles;
  activate.textContent = state.active ? "Nonaktifkan subtitle" : "Aktifkan subtitle";
  status.classList.toggle("error", state.phase === "error");

  const progressMsg = state.progress || (generating ? "Memproses…" : "");
  const messages = {
    idle: mode === "original"
      ? "Pilih track subtitle YouTube, lalu terapkan secara instan."
      : "Siap membuat subtitle dengan AI enhancement.",
    generating: progressMsg || "Memproses batch AI…",
    generated: `${state.segmentCount} segmen siap (${state.source === "original" ? "Original Smart" : "AI Reconstructed"}). Tersimpan lokal.`,
    error: state.error || "Terjadi kesalahan.",
  };
  status.textContent = state.active
    ? `${state.active ? "Subtitle aktif. " : ""}${messages[state.phase] || progressMsg || messages.idle}`
    : (messages[state.phase] || progressMsg || messages.idle);
}

function disableForPage(message) {
  generate.disabled = true;
  activate.disabled = true;
  syncCustomSelect(source);
  syncCustomSelect(textModel);
  syncCustomSelect(language);
  showError(message);
}

function showError(message) {
  status.classList.add("error");
  status.textContent = message;
}

function sendToTab(message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(response);
    });
  });
}

// Custom Select Component System
function initCustomSelects() {
  document.querySelectorAll(".select-wrap select").forEach((select) => {
    buildCustomSelect(select);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".c-select-container")) {
      document.querySelectorAll(".c-select-menu.open").forEach((m) => m.classList.remove("open"));
      document.querySelectorAll(".c-select-trigger.active").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".select-wrap.is-open").forEach((w) => w.classList.remove("is-open"));
    }
  });
}

function buildCustomSelect(select) {
  const wrap = select.closest(".select-wrap");
  if (!wrap || wrap.querySelector(".c-select-container")) return;

  select.style.display = "none";

  const container = document.createElement("div");
  container.className = "c-select-container";

  const trigger = document.createElement("div");
  trigger.className = "c-select-trigger";
  trigger.tabIndex = 0;

  const labelSpan = document.createElement("span");
  labelSpan.className = "c-select-label";

  const arrow = document.createElement("span");
  arrow.className = "c-select-arrow";

  trigger.append(labelSpan, arrow);

  const menu = document.createElement("div");
  menu.className = "c-select-menu";

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (select.disabled || trigger.classList.contains("disabled")) return;
    const isOpen = menu.classList.contains("open");
    document.querySelectorAll(".c-select-menu.open").forEach((m) => m.classList.remove("open"));
    document.querySelectorAll(".c-select-trigger.active").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".select-wrap.is-open").forEach((w) => w.classList.remove("is-open"));
    if (!isOpen) {
      menu.classList.add("open");
      trigger.classList.add("active");
      wrap.classList.add("is-open");
    }
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      trigger.click();
    } else if (e.key === "Escape") {
      menu.classList.remove("open");
      trigger.classList.remove("active");
      wrap.classList.remove("is-open");
    }
  });

  container.append(trigger, menu);
  wrap.append(container);

  syncCustomSelect(select);
}

function syncCustomSelect(select) {
  const wrap = select.closest(".select-wrap");
  if (!wrap) return;
  const container = wrap.querySelector(".c-select-container");
  if (!container) {
    buildCustomSelect(select);
    return;
  }

  const trigger = container.querySelector(".c-select-trigger");
  const labelSpan = container.querySelector(".c-select-label");
  const menu = container.querySelector(".c-select-menu");

  trigger.classList.toggle("disabled", Boolean(select.disabled));

  menu.innerHTML = "";
  const options = Array.from(select.options);
  const selectedOpt = select.selectedOptions[0] || options[0];
  labelSpan.textContent = selectedOpt ? selectedOpt.textContent : "";

  options.forEach((opt) => {
    const item = document.createElement("div");
    item.className = `c-select-option ${opt.value === select.value ? "selected" : ""} ${opt.disabled ? "disabled" : ""}`;
    item.textContent = opt.textContent;
    item.title = opt.textContent;

    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (opt.disabled) return;
      select.value = opt.value;
      labelSpan.textContent = opt.textContent;
      menu.querySelectorAll(".c-select-option").forEach((o) => o.classList.remove("selected"));
      item.classList.add("selected");
      menu.classList.remove("open");
      trigger.classList.remove("active");
      wrap.classList.remove("is-open");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    menu.append(item);
  });
}
