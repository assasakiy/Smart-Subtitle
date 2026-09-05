const DEFAULTS = {
  baseUrl: "",
  apiKey: "",
  transcriptionModel: "whisper-1",
  textModel: "gpt-4o-mini",
  targetLanguage: "id",
  fontSize: 24,
  positionBottom: 8,
  maxWidthPercent: 90,
  lineHeight: 1.35,
};

// Elements
let navBtns = [];
const tabPanes = document.querySelectorAll(".tab-pane");

const formGeneral = document.querySelector("#formGeneral");
const generalStatus = document.querySelector("#generalStatus");
const saveGeneralBtn = document.querySelector("#saveGeneralBtn");
const modelList = document.querySelector("#modelList");
let loadModelsBtn = null;
let loadModelsStatus = null;

const fontSizeInput = document.querySelector("#fontSizeInput");
const fontSizeVal = document.querySelector("#fontSizeVal");
const positionBottomInput = document.querySelector("#positionBottomInput");
const positionBottomVal = document.querySelector("#positionBottomVal");
const maxWidthInput = document.querySelector("#maxWidthInput");
const maxWidthVal = document.querySelector("#maxWidthVal");
const lineHeightInput = document.querySelector("#lineHeightInput");
const lineHeightVal = document.querySelector("#lineHeightVal");
const previewWrap = document.querySelector("#previewWrap");
const previewSubtitle = document.querySelector("#previewSubtitle");
const saveAppearanceBtn = document.querySelector("#saveAppearance");
const appearanceStatus = document.querySelector("#appearanceStatus");

const cacheList = document.querySelector("#cacheList");
const cacheCountBadge = document.querySelector("#cacheCountBadge");
const deleteSelectedCacheBtn = document.querySelector("#deleteSelectedCacheBtn");
const selectAllCheckbox = document.querySelector("#selectAllCheckbox");

const textModelSelect = document.querySelector("#textModelSelect");
const targetLanguageSelect = document.querySelector("#targetLanguageSelect");

let initialGeneral = {};
let initialAppearance = {};

// Init
init();

async function init() {
  await loadLayout();
  setupNavigation();
  setupAppVersionAndUpdates();
  restoreGeneral();
  restoreAppearance();
  loadCacheList();

  loadModelsBtn = document.querySelector("#loadModels");
  loadModelsStatus = document.querySelector("#loadModelsStatus");
  if (loadModelsBtn) loadModelsBtn.addEventListener("click", loadModels);
  
  formGeneral.addEventListener("submit", saveGeneral);
  formGeneral.addEventListener("input", checkGeneralChanged);
  formGeneral.addEventListener("change", checkGeneralChanged);

  fontSizeInput.addEventListener("input", onAppearanceInput);
  positionBottomInput.addEventListener("input", onAppearanceInput);
  maxWidthInput.addEventListener("input", onAppearanceInput);
  lineHeightInput.addEventListener("input", onAppearanceInput);
  saveAppearanceBtn.addEventListener("click", saveAppearance);

  deleteSelectedCacheBtn.addEventListener("click", handleDeleteSelectedCache);
  selectAllCheckbox.addEventListener("change", handleSelectAllChange);

  const clearLogsBtn = document.querySelector("#clearLogsBtn");
  if (clearLogsBtn) clearLogsBtn.addEventListener("click", handleClearAllLogs);
  loadLogsList();
}

async function loadLayout() {
  try {
    const res = await fetch("layout.html");
    const html = await res.text();
    const container = document.querySelector("#layout-container");
    if (container) {
      container.innerHTML = html;
      navBtns = document.querySelectorAll(".nav-btn");
      setupSidebarDrawer();
    }
  } catch (err) {
    console.error("Gagal memuat layout sidebar:", err);
  }
}

function setupSidebarDrawer() {
  const aside = document.querySelector("#appSidebar");
  const dockBtn = document.querySelector("#sidebarDockBtn");
  const overlay = document.querySelector("#overlay");

  if (!aside || !dockBtn || !overlay) return;

  const toggleSidebar = (force) => {
    const isOpen = typeof force === "boolean" ? force : !aside.classList.contains("open");
    aside.classList.toggle("open", isOpen);
    overlay.classList.toggle("active", isOpen);
    dockBtn.textContent = isOpen ? "✕" : "⚙";
    dockBtn.title = isOpen ? "Tutup Sidebar" : "Buka Sidebar";
  };

  dockBtn.addEventListener("click", () => toggleSidebar());
  overlay.addEventListener("click", () => toggleSidebar(false));

  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (window.innerWidth <= 1024) toggleSidebar(false);
    });
  });

  // Set default button icon on load
  dockBtn.textContent = "⚙";
}

function setupNavigation() {
  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      navBtns.forEach((b) => b.classList.toggle("active", b === btn));
      tabPanes.forEach((p) => p.classList.toggle("active", p.id === `tab-${target}`));
      if (target === "cache") loadCacheList();
      if (target === "logs") loadLogsList();
    });
  });
}

async function setupAppVersionAndUpdates() {
  const manifest = chrome.runtime.getManifest();
  const currentVersion = manifest?.version || "0.1.1";
  const versionEl = document.querySelector("#optionsVersion");
  if (versionEl) versionEl.textContent = `v${currentVersion}`;

  try {
    let latestTag = "";
    let htmlUrl = "https://github.com/assasakiy/Smart-Subtitle/releases";
    let downloadUrl = "";

    // 1. Coba fetch latest GitHub Release
    const relRes = await fetch("https://api.github.com/repos/assasakiy/Smart-Subtitle/releases/latest", {
      headers: { Accept: "application/vnd.github.v3+json" },
    });

    if (relRes.ok) {
      const release = await relRes.json();
      latestTag = String(release.tag_name || "").replace(/^v/i, "").trim();
      htmlUrl = release.html_url || htmlUrl;
      downloadUrl = release.zipball_url || "";
    } else if (relRes.status === 404) {
      // 2. Fallback: Cek git tags jika belum dibuat GitHub Release formal
      const tagRes = await fetch("https://api.github.com/repos/assasakiy/Smart-Subtitle/tags", {
        headers: { Accept: "application/vnd.github.v3+json" },
      });
      if (tagRes.ok) {
        const tags = await tagRes.json();
        if (Array.isArray(tags) && tags.length > 0) {
          latestTag = String(tags[0].name || "").replace(/^v/i, "").trim();
          htmlUrl = `https://github.com/assasakiy/Smart-Subtitle/releases/tag/v${latestTag}`;
          downloadUrl = tags[0].zipball_url || "";
        }
      }
    }

    if (latestTag && isNewerVersion(latestTag, currentVersion)) {
      const updateBox = document.querySelector("#updateNoticeBox");
      const changeLogBtn = document.querySelector("#changeLogBtn");
      const triggerNativeUpdateBtn = document.querySelector("#triggerNativeUpdateBtn");
      const nativeUpdateStatus = document.querySelector("#nativeUpdateStatus");

      if (updateBox && changeLogBtn) {
        changeLogBtn.href = htmlUrl;
        changeLogBtn.textContent = `Change (v${latestTag}) ↗`;
        updateBox.style.display = "flex";

        if (triggerNativeUpdateBtn) {
          triggerNativeUpdateBtn.addEventListener("click", () => {
            nativeUpdateStatus.textContent = "Menghubungi helper updater...";
            triggerNativeUpdateBtn.disabled = true;

            chrome.runtime.sendNativeMessage(
              "com.aisubtitle.updater",
              { action: "update", downloadUrl },
              (response) => {
                if (chrome.runtime.lastError) {
                  nativeUpdateStatus.textContent = "Jalankan updater/install.bat dulu di komputer Anda.";
                  triggerNativeUpdateBtn.disabled = false;
                  return;
                }
                if (response?.success) {
                  nativeUpdateStatus.textContent = "Sukses! Memuat ulang ekstensi...";
                  setTimeout(() => {
                    chrome.runtime.reload();
                  }, 1200);
                } else {
                  nativeUpdateStatus.textContent = `Gagal: ${response?.error || "Unknown"}`;
                  triggerNativeUpdateBtn.disabled = false;
                }
              }
            );
          });
        }
      }
    }
  } catch (err) {
    // Silent fail jika offline/rate-limit
  }
}

function isNewerVersion(latest, current) {
  const lParts = latest.split(".").map((n) => parseInt(n, 10) || 0);
  const cParts = current.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(lParts.length, cParts.length); i++) {
    const l = lParts[i] || 0;
    const c = cParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

async function restoreGeneral() {
  const settings = await chrome.storage.local.get({ ...DEFAULTS, cachedModels: [] });
  
  const models = settings.cachedModels.length ? settings.cachedModels : [settings.textModel || "gpt-4o-mini"];
  if (settings.textModel && !models.includes(settings.textModel)) {
    models.unshift(settings.textModel);
  }
  textModelSelect.replaceChildren(
    ...models.map((id) => Object.assign(document.createElement("option"), { value: id, textContent: id }))
  );
  textModelSelect.value = settings.textModel || models[0] || "";

  if (settings.targetLanguage) {
    targetLanguageSelect.value = settings.targetLanguage;
  }

  initialGeneral = {
    baseUrl: settings.baseUrl || "",
    apiKey: settings.apiKey || "",
    textModel: textModelSelect.value || "",
    targetLanguage: targetLanguageSelect.value || "id",
  };

  const urlInput = formGeneral.elements.namedItem("baseUrl");
  if (urlInput) urlInput.value = initialGeneral.baseUrl;
  const keyInput = formGeneral.elements.namedItem("apiKey");
  if (keyInput) keyInput.value = initialGeneral.apiKey;

  initCustomSelectsOptions();
  checkGeneralChanged();
}

function checkGeneralChanged() {
  const current = Object.fromEntries(new FormData(formGeneral));
  const changed = (current.baseUrl || "") !== initialGeneral.baseUrl ||
    (current.apiKey || "") !== initialGeneral.apiKey ||
    (textModelSelect.value || "") !== initialGeneral.textModel ||
    (targetLanguageSelect.value || "") !== initialGeneral.targetLanguage;
  saveGeneralBtn.disabled = !changed;
}

async function requestOrigin(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Endpoint URL tidak valid.");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Endpoint wajib memakai HTTP atau HTTPS.");
  }
  const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
  if (!granted) throw new Error("Izin akses endpoint ditolak.");
}

async function loadModels() {
  loadModelsStatus.textContent = "Memuat model…";
  const data = Object.fromEntries(new FormData(formGeneral));
  try {
    await requestOrigin(data.baseUrl);
    const response = await chrome.runtime.sendMessage({
      type: "LIST_MODELS",
      baseUrl: data.baseUrl,
      apiKey: (data.apiKey || "").trim(),
    });
    if (!response?.ok) throw new Error(response?.error || "Model gagal dimuat.");
    await chrome.storage.local.set({ cachedModels: response.models, modelsUpdatedAt: Date.now() });
    textModelSelect.replaceChildren(
      ...response.models.map((id) => Object.assign(document.createElement("option"), { value: id, textContent: id }))
    );
    if (response.models.length) textModelSelect.value = response.models[0];
    syncCustomSelectOptions(textModelSelect);
    checkGeneralChanged();
    loadModelsStatus.textContent = `${response.models.length} model diperbarui dan disimpan.`;
  } catch (error) {
    loadModelsStatus.textContent = error.message;
  }
}

async function saveGeneral(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(formGeneral));
  try {
    await requestOrigin(data.baseUrl);
    await chrome.storage.local.set({
      baseUrl: data.baseUrl.replace(/\/+$/, ""),
      apiKey: (data.apiKey || "").trim(),
      textModel: textModelSelect.value.trim(),
      targetLanguage: targetLanguageSelect.value,
    });
    initialGeneral = {
      baseUrl: data.baseUrl.replace(/\/+$/, ""),
      apiKey: (data.apiKey || "").trim(),
      textModel: textModelSelect.value.trim(),
      targetLanguage: targetLanguageSelect.value,
    };
    checkGeneralChanged();
    generalStatus.textContent = "Konfigurasi tersimpan.";
    setTimeout(() => { generalStatus.textContent = ""; }, 3000);
  } catch (error) {
    generalStatus.textContent = error.message;
  }
}

async function restoreAppearance() {
  const settings = await chrome.storage.local.get({
    fontSize: DEFAULTS.fontSize,
    positionBottom: DEFAULTS.positionBottom,
    maxWidthPercent: DEFAULTS.maxWidthPercent,
    lineHeight: DEFAULTS.lineHeight,
  });
  initialAppearance = {
    fontSize: Number(settings.fontSize) || 24,
    positionBottom: Number(settings.positionBottom) || 8,
    maxWidthPercent: Number(settings.maxWidthPercent) || 90,
    lineHeight: Number(settings.lineHeight) || 1.35,
  };
  fontSizeInput.value = initialAppearance.fontSize;
  positionBottomInput.value = initialAppearance.positionBottom;
  maxWidthInput.value = initialAppearance.maxWidthPercent;
  lineHeightInput.value = initialAppearance.lineHeight;
  updateAppearancePreview();
  checkAppearanceChanged();
}

function onAppearanceInput() {
  updateAppearancePreview();
  checkAppearanceChanged();
}

function checkAppearanceChanged() {
  const size = Number(fontSizeInput.value);
  const bottom = Number(positionBottomInput.value);
  const width = Number(maxWidthInput.value);
  const lh = Number(lineHeightInput.value);

  const changed = size !== initialAppearance.fontSize ||
    bottom !== initialAppearance.positionBottom ||
    width !== initialAppearance.maxWidthPercent ||
    Math.abs(lh - initialAppearance.lineHeight) > 0.001;

  saveAppearanceBtn.disabled = !changed;
}

function updateAppearancePreview() {
  const size = fontSizeInput.value;
  const bottom = positionBottomInput.value;
  const width = maxWidthInput.value;
  const lh = lineHeightInput.value;
  fontSizeVal.textContent = `${size} px`;
  positionBottomVal.textContent = `${bottom} %`;
  maxWidthVal.textContent = `${width} %`;
  lineHeightVal.textContent = `${Number(lh).toFixed(2)}`;

  if (previewWrap) {
    previewWrap.style.bottom = `${bottom}%`;
    previewWrap.style.maxWidth = `${width}%`;
  }
  if (previewSubtitle) {
    previewSubtitle.style.fontSize = `${size}px`;
    previewSubtitle.style.lineHeight = `${lh}`;
  }
}

async function saveAppearance() {
  const fontSize = Number(fontSizeInput.value) || 24;
  const positionBottom = Number(positionBottomInput.value) || 8;
  const maxWidthPercent = Number(maxWidthInput.value) || 90;
  const lineHeight = Number(lineHeightInput.value) || 1.35;
  await chrome.storage.local.set({ fontSize, positionBottom, maxWidthPercent, lineHeight });
  // Broadcast ke tab youtube yang aktif jika ada
  chrome.tabs.query({ url: "https://www.youtube.com/*" }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: "UPDATE_STYLE", fontSize, positionBottom, maxWidthPercent, lineHeight }).catch(() => {});
    });
  });
  initialAppearance = { fontSize, positionBottom, maxWidthPercent, lineHeight };
  checkAppearanceChanged();
  appearanceStatus.textContent = "Tampilan disimpan & diterapkan.";
  setTimeout(() => { appearanceStatus.textContent = ""; }, 3000);
}

async function loadCacheList() {
  cacheList.innerHTML = '<div class="cache-empty">Memuat daftar cache...</div>';
  selectAllCheckbox.checked = false;
  deleteSelectedCacheBtn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: "LIST_CACHE" });
    if (!res?.ok || !Array.isArray(res.items)) throw new Error(res?.error || "Gagal membaca cache.");

    cacheCountBadge.textContent = `${res.items.length} Video`;
    if (!res.items.length) {
      cacheList.innerHTML = '<div class="cache-empty">Belum ada subtitle tersimpan di lokal.</div>';
      return;
    }

    cacheList.innerHTML = "";
    res.items.forEach((item) => {
      const el = document.createElement("div");
      el.className = "cache-item";

      const dateStr = new Date(item.updatedAt).toLocaleString("id-ID", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const videoLink = item.videoId && item.videoId !== "unknown"
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`
        : "#";

      const titleDisplay = item.videoTitle
        ? escapeHtml(item.videoTitle)
        : `Video ID: ${escapeHtml(item.videoId)}`;

      const isOriginal = item.processing === "smart" || !item.textModel;
      const typeBadge = isOriginal
        ? `<span class="badge" style="background:rgba(250,204,21,.15);color:#facc15;">ORIGINAL · SMART</span>`
        : `<span class="badge" style="background:rgba(248,104,0,.15);color:var(--accent);">AI · ${escapeHtml(item.textModel || "LLM")}</span>`;

      el.innerHTML = `
        <input type="checkbox" class="item-checkbox cache-checkbox" data-key="${escapeHtml(item.key)}">
        <div class="cache-info">
          <h4>
            <a href="${videoLink}" target="_blank" rel="noopener" title="${titleDisplay}">${titleDisplay}</a>
            <span class="cache-badges">
              <span class="badge">${escapeHtml(item.targetLanguage.toUpperCase())}</span>
              ${typeBadge}
            </span>
          </h4>
          <div class="cache-meta">
            <span>ID: <code>${escapeHtml(item.videoId)}</code></span>
            <span>Tipe: ${isOriginal ? "Smart Segmentation (Lokal)" : `AI (${escapeHtml(item.textModel || "LLM")})`}</span>
            <span>${item.segmentCount} Segmen</span>
            <span>Diperbarui: ${dateStr}</span>
          </div>
        </div>
      `;

      el.querySelector(".item-checkbox").addEventListener("change", updateSelectedState);

      cacheList.appendChild(el);
    });
  } catch (err) {
    cacheList.innerHTML = `<div class="cache-empty" style="color:var(--danger)">${escapeHtml(err.message)}</div>`;
  }
}

function updateSelectedState() {
  const checkboxes = cacheList.querySelectorAll(".item-checkbox");
  const selected = Array.from(checkboxes).filter((cb) => cb.checked);
  deleteSelectedCacheBtn.disabled = selected.length === 0;
  deleteSelectedCacheBtn.textContent = selected.length > 0 ? `Hapus Terpilih (${selected.length})` : "Hapus Terpilih";
  selectAllCheckbox.checked = checkboxes.length > 0 && selected.length === checkboxes.length;
}

function handleSelectAllChange() {
  const isChecked = selectAllCheckbox.checked;
  const checkboxes = cacheList.querySelectorAll(".item-checkbox");
  checkboxes.forEach((cb) => { cb.checked = isChecked; });
  updateSelectedState();
}

async function handleDeleteSelectedCache() {
  const checkboxes = cacheList.querySelectorAll(".item-checkbox:checked");
  const keys = Array.from(checkboxes).map((cb) => cb.dataset.key).filter(Boolean);
  if (!keys.length) return;
  if (!confirm(`Hapus ${keys.length} cache subtitle yang dipilih?`)) return;

  await chrome.runtime.sendMessage({ type: "DELETE_BATCH_CACHE", keys });
  loadCacheList();
}

async function handleClearAllCache() {
  if (!confirm("Hapus SELURUH cache subtitle dari browser?")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_ALL_CACHE" });
  loadCacheList();
}

async function loadLogsList() {
  const logListEl = document.querySelector("#logList");
  const logCountBadge = document.querySelector("#logCountBadge");
  const clearLogsBtn = document.querySelector("#clearLogsBtn");
  if (!logListEl) return;

  logListEl.innerHTML = `<div class="cache-empty">Memuat catatan error...</div>`;
  const res = await chrome.runtime.sendMessage({ type: "GET_LOGS" });
  const logs = res?.logs || [];

  if (logCountBadge) logCountBadge.textContent = `${logs.length} Log`;
  if (clearLogsBtn) clearLogsBtn.disabled = logs.length === 0;

  if (!logs.length) {
    logListEl.innerHTML = `<div class="cache-empty">Belum ada catatan error. Sistem berjalan normal.</div>`;
    return;
  }

  logListEl.innerHTML = "";
  logs.forEach((log) => {
    const item = document.createElement("div");
    item.className = "cache-item";
    const timeStr = new Date(log.timestamp).toLocaleString("id-ID", {
      dateStyle: "medium",
      timeStyle: "medium",
    });

    item.innerHTML = `
      <div class="cache-info">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span class="badge" style="background:var(--danger-dim);color:var(--danger);">${escapeHtml(log.source.toUpperCase())}</span>
          <span style="font-size:12px;color:var(--muted);">${timeStr}</span>
        </div>
        <h4 style="color:#ff8e9b;margin-bottom:4px;font-family:monospace;font-size:13px;">${escapeHtml(log.message)}</h4>
        ${
          log.explanation
            ? `<div style="background:rgba(255,255,255,0.05);padding:8px 12px;border-radius:8px;margin:6px 0 8px;font-size:12px;color:#cfd9e8;">
                <strong>Penyebab & Solusi:</strong> ${escapeHtml(log.explanation)}
               </div>`
            : ""
        }
        ${
          log.details
            ? `<pre style="background:#070d18;padding:8px;border-radius:6px;font-size:11px;color:var(--muted);overflow-x:auto;margin:4px 0 0;">${escapeHtml(
                typeof log.details === "object" ? JSON.stringify(log.details, null, 2) : log.details
              )}</pre>`
            : ""
        }
      </div>
      <button class="danger delete-single-log-btn" data-id="${log.id}" style="padding:6px 10px;font-size:11px;" title="Hapus log ini">Hapus</button>
    `;

    item.querySelector(".delete-single-log-btn").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "DELETE_LOG", id: log.id });
      loadLogsList();
    });

    logListEl.appendChild(item);
  });
}

async function handleClearAllLogs() {
  if (!confirm("Hapus semua riwayat error?")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_LOGS" });
  loadLogsList();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Custom Select Component for Dashboard Options
function initCustomSelectsOptions() {
  document.querySelectorAll(".select-wrap select").forEach((select) => {
    buildCustomSelectOption(select);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".c-select-container")) {
      document.querySelectorAll(".c-select-menu.open").forEach((m) => m.classList.remove("open"));
      document.querySelectorAll(".c-select-trigger.active").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".select-wrap.is-open").forEach((w) => w.classList.remove("is-open"));
    }
  });
}

function buildCustomSelectOption(select) {
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

  syncCustomSelectOptions(select);
}

function syncCustomSelectOptions(select) {
  const wrap = select.closest(".select-wrap");
  if (!wrap) return;
  const container = wrap.querySelector(".c-select-container");
  if (!container) {
    buildCustomSelectOption(select);
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
      checkGeneralChanged();
    });

    menu.append(item);
  });
}
