/**
 * 3D 资源按需下载与本地管理
 *
 * 清单来自数据目录（sqdata 协议）的 3d-manifest.json；实际文件由 Tauri 命令下载到本地目录，
 * 并在窗口内拦截 3D 代码对 .../img/maps/.../3d/... 的请求，改读本地文件。
 *
 * 打开 3D 时会先检查当前地图资源是否已下载，未下载则弹出引导对话框，可直接下载。
 */

import { App } from "../app.js";
import { MAPS } from "../data/maps.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const ROOT_KEY = "settings-3d-root";
const MANIFEST_URL = `${process.env.API_URL}/3d-manifest.json`;

const t = (key, def) => (window.i18next ? window.i18next.t(key, { defaultValue: def }) : def);
const esc = (s) => App.sanitize(String(s ?? ""));
const isTauri = () => !!window.__TAURI_INTERNALS__;
const mb = (bytes) => `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;

let manifest = null;            // 3D 清单
let root = null;                // 存储根目录
let downloaded = new Map();     // rel -> { rel, bytes, files }
let scanPromise = null;         // 首次扫描兜底（供 fetch 拦截 await）
let initialised = false;
let onlyDownloaded = false;     // 只看已下载
let els = null;
let promptEls = null;
let promptEntry = null;         // 引导下载对应的清单项
let promptResolve = null;       // 引导下载的 resolver
let progressHook = null;        // 引导下载时的进度回调
const downloading = new Set();  // 正在下载的 rel
const rowErrors = new Map();    // rel -> 错误信息（就地显示，避免用户看不到）

/* ---------------- 本地文件 URL ---------------- */

function localPath(rel, file) {
    const base = (root || "").replace(/[\\/]+$/, "");
    return `${base}/${rel}/${file}`;
}

function toLocalUrl(absPath) {
    const convert = window.__TAURI_INTERNALS__?.convertFileSrc;
    if (typeof convert === "function") return convert(absPath);
    return `http://asset.localhost/${encodeURIComponent(absPath.replace(/\\/g, "/"))}`;
}

/* ---------------- fetch 拦截（模块加载即安装） ---------------- */

const originalFetch = window.fetch ? window.fetch.bind(window) : null;

if (originalFetch) {
    window.fetch = async (input, init) => {
        if (!isTauri()) return originalFetch(input, init);
        try {
            const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
            const m = url.match(/\/img\/maps\/(.+?)\/3d\/([^?#]+)/);
            if (m) {
                await ensureScanned();
                const rel = `img/maps/${m[1]}`;
                if (downloaded.has(rel)) {
                    // 磁盘布局是 <root>/<rel>/3d/<file>，这里必须补回 3d/ 这一段
                    const local = toLocalUrl(localPath(rel, `3d/${m[2]}`));
                    if (local) return originalFetch(local, init);
                }
            }
        } catch {
            /* 拦截异常时原样放行 */
        }
        return originalFetch(input, init);
    };
}

/* ---------------- 存储目录 / 扫描 ---------------- */

async function resolveRoot() {
    if (root) return root;
    root = localStorage.getItem(ROOT_KEY) || "";
    if (!root && isTauri()) {
        root = await invoke("three_d_default_root");
        localStorage.setItem(ROOT_KEY, root);
    }
    return root;
}

async function scan() {
    await resolveRoot();
    downloaded = new Map();
    if (isTauri() && root) {
        const list = await invoke("three_d_scan", { root });
        for (const item of list || []) downloaded.set(item.rel, item);
    }
    return downloaded;
}

/** 首次拦截时的按需扫描（只跑一次，失败则下次重试） */
function ensureScanned() {
    if (!scanPromise) {
        scanPromise = scan().catch(() => {
            scanPromise = null;
        });
    }
    return scanPromise;
}

async function rescan() {
    scanPromise = scan().catch(() => {});
    await scanPromise;
}

/* ---------------- 分组（原生地图 / 各 MOD） ---------------- */

function modOf(name) {
    const found = MAPS.find((m) => m.name === name);
    return (found && found.mod) || "";
}

function groupLabel(mod) {
    return mod || t("common:tdfGroupVanilla", "原生地图");
}

/* ---------------- 渲染 ---------------- */

async function loadManifest() {
    if (manifest) return manifest;
    const r = await fetch(MANIFEST_URL);
    if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
    manifest = await r.json();
    return manifest;
}

/** name -> 显示名（优先 i18next maps 翻译） */
function mapLabel(name) {
    const key = `maps:${name}`;
    const label = window.i18next ? window.i18next.t(key) : key;
    return label && label !== key ? label : name;
}

function stateOf(rel, m) {
    if (downloading.has(rel)) return "downloading";
    const info = downloaded.get(rel);
    if (!info) return "none";
    const need = (m?.files || []).length;
    // 文件数不足说明上次下载中断，按“不完整”处理，允许重下
    return need && info.files < need ? "partial" : "downloaded";
}

function rowHtml(m) {
    const rel = m.rel;
    const info = downloaded.get(rel);
    const state = stateOf(rel, m);
    const needFiles = (m.files || []).length;
    const hasData = needFiles > 0;
    const status =
        state === "downloading" ? t("common:tdfDownloading", "下载中")
        : state === "downloaded" ? `${t("common:tdfDownloaded", "已下载")} (${mb(info?.bytes ?? m.total)})`
        : state === "partial" ? `${t("common:tdfPartial", "不完整")} ${info?.files ?? 0}/${needFiles} · ${mb(info?.bytes ?? 0)}`
        : t("common:tdfNotDownloaded", "未下载");
    // 已下载的只留“删除”；未下载/不完整的才给“下载”
    const getBtn =
        state === "downloaded" || state === "downloading"
            ? ""
            : `<button type="button" class="tdf-btn tdf-get" data-rel="${esc(rel)}" data-act="download"${!hasData ? " disabled" : ""}>${t("common:tdfDownload", "下载")}</button>`;
    const delBtn =
        state === "downloaded" || state === "partial"
            ? `<button type="button" class="tdf-btn tdf-del" data-rel="${esc(rel)}" data-act="delete">${t("common:tdfDelete", "删除")}</button>`
            : "";
    const bar = state === "downloading" ? `<span class="tdf-bar"><i style="width:0%"></i></span>` : "";
    const err = rowErrors.get(rel);
    return `
    <div class="tdf-row" data-rel="${esc(rel)}">
        <div class="tdf-info">
            <span class="tdf-name">${esc(mapLabel(m.name))}</span>
            <span class="tdf-meta">${mb(m.total)} · ${status}${hasData ? "" : ` · ${t("common:tdfNoData", "该地图暂无 3D 数据")}`}</span>
            ${bar}
            ${err ? `<span class="tdf-err">${esc(err)}</span>` : ""}
        </div>
        <div class="tdf-side">${getBtn}${delBtn}</div>
    </div>`;
}

function renderRows() {
    if (!els || !manifest) return;
    let list = manifest.maps || [];
    if (onlyDownloaded) list = list.filter((m) => downloaded.has(m.rel));

    if (!list.length) {
        els.list.innerHTML = `<div class="tdf-empty">${
            onlyDownloaded ? t("common:tdfNoLocal", "还没有下载任何地图的 3D 资源") : t("common:tdfNoData", "该地图暂无 3D 数据")
        }</div>`;
    } else {
        // 按 MOD 分组：原生地图排最前，其余按名称排序
        const groups = new Map();
        for (const m of list) {
            const key = modOf(m.name);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(m);
        }
        const keys = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
        els.list.innerHTML = keys
            .map((key) => {
                const rows = groups.get(key);
                const done = rows.filter((m) => downloaded.has(m.rel)).length;
                return `<div class="tdf-group">
                            <span class="tdf-groupName">${esc(groupLabel(key))}</span>
                            <span class="tdf-groupCount">${done}/${rows.length}</span>
                        </div>${rows.map(rowHtml).join("")}`;
            })
            .join("");
    }

    if (els.summary) {
        const rels = [...downloaded.keys()];
        const bytes = rels.reduce((a, r) => a + (downloaded.get(r)?.bytes || 0), 0);
        els.summary.textContent = `${t("common:tdfDownloaded", "已下载")} ${rels.length} · ${mb(bytes)}`;
    }
}

async function refreshList() {
    if (!els) return;
    els.status.textContent = "";
    try {
        await loadManifest();
        await ensureScanned();
    } catch (e) {
        els.list.innerHTML = `<div class="tdf-empty">${esc(String((e && e.message) || e))}</div>`;
        return;
    }
    els.root.value = root || "";
    els.total.textContent = `${t("common:tdfTotal", "合计")}: ${mb((manifest.maps || []).reduce((a, m) => a + (m.total || 0), 0))}`;
    renderRows();
}

/* ---------------- 进度事件 ---------------- */

function updateProgress(p) {
    if (typeof progressHook === "function") progressHook(p);
    const row = els?.list?.querySelector(`.tdf-row[data-rel="${p.rel}"]`);
    if (!row) return;
    const bar = row.querySelector(".tdf-bar i");
    const meta = row.querySelector(".tdf-meta");
    const pct = Math.min(100, Math.round(((p.index || 0) / (p.total || 1)) * 100));
    if (bar) bar.style.width = `${pct}%`;
    if (meta) meta.textContent = `${t("common:tdfDownloading", "下载中")} ${p.index}/${p.total} · ${mb(p.received)}`;
}

/* ---------------- 操作 ---------------- */

/**
 * 下载一张地图的 3D 资源（失败自动重试一轮）
 * @returns {Promise<boolean>} 是否成功
 */
async function downloadMap(rel, options = {}) {
    if (downloading.has(rel)) return false;
    try {
        await loadManifest();
    } catch {
        return false;
    }
    const m = (manifest.maps || []).find((x) => x.rel === rel);
    if (!m) return false;

    downloading.add(rel);
    rowErrors.delete(rel);
    renderRows();
    progressHook = typeof options.onProgress === "function" ? options.onProgress : null;

    let ok = false;
    let lastErr = "";
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        try {
            await invoke("three_d_download", {
                root,
                rel,
                apiBase: manifest.apiBase,
                apiFallback: manifest.apiFallback ?? null,
                files: (m.files || []).map((f) => f.path),
            });
            ok = true;
        } catch (e) {
            lastErr = String((e && e.message) || e);
        }
    }

    progressHook = null;
    await rescan();
    downloading.delete(rel);
    if (!ok) {
        // 就地显示错误：对话框底部的状态栏容易被滚动遮住，用户会以为“没反应”
        rowErrors.set(rel, `${t("common:tdfFail", "下载失败，请检查网络后重试")} ${lastErr}`.trim());
        if (els) els.status.textContent = lastErr;
    }
    renderRows();
    return ok;
}

async function deleteMap(rel) {
    try {
        await invoke("three_d_delete", { root, rel });
        downloaded.delete(rel);
        rowErrors.delete(rel);
        renderRows();
    } catch (e) {
        rowErrors.set(rel, String((e && e.message) || e));
        renderRows();
    }
}

async function downloadAll() {
    if (!manifest) return;
    const todo = (manifest.maps || []).filter((m) => !downloaded.has(m.rel) && !downloading.has(m.rel));
    if (!todo.length) return;
    const bytes = todo.reduce((a, m) => a + (m.total || 0), 0);
    if (!window.confirm(`${t("common:tdfDownloadAll", "下载全部")} (${todo.length} · ${mb(bytes)})?`)) return;
    for (const m of todo) await downloadMap(m.rel);
}

async function clearAll() {
    const rels = [...downloaded.keys()];
    if (!rels.length) return;
    if (!window.confirm(`${t("common:tdfClearAll", "清理全部")} (${rels.length})?`)) return;
    for (const rel of rels) await deleteMap(rel);
}

/* ---------------- 打开 3D 前的引导下载 ---------------- */

function findEntry(mapName) {
    if (!manifest || !mapName) return null;
    return (manifest.maps || []).find((m) => m.name === mapName) || null;
}

/**
 * 打开 3D 前的检查：未下载则弹引导框让用户直接下载
 * @param {string} mapName 当前地图名（与 MAPS[].name 一致）
 * @returns {Promise<boolean>} true 表示可以继续打开 3D
 */
export async function ensureMapAssets(mapName) {
    if (!isTauri() || !mapName) return true;
    try {
        await loadManifest();
        await ensureScanned();
    } catch {
        return true;
    }
    const entry = findEntry(mapName);
    // 该地图本身没有 3D 资源：照常打开（3D 会自动回落到高度图）
    if (!entry || !(entry.files || []).length) return true;
    if (stateOf(entry.rel, entry) === "downloaded") return true;
    return await askDownload(entry);
}

function askDownload(entry) {
    const dialog = document.getElementById("tdfPrompt");
    if (!dialog || !promptEls) return Promise.resolve(true);
    promptEntry = entry;
    promptEls.text.textContent = `${mapLabel(entry.name)} · ${mb(entry.total)} · ${t("common:tdfNotDownloaded", "未下载")}`;
    promptEls.msg.textContent = "";
    promptEls.bar.style.display = "none";
    promptEls.bar.querySelector("i").style.width = "0%";
    promptEls.go.disabled = false;
    promptEls.skip.disabled = false;
    if (!dialog.open) dialog.showModal();
    return new Promise((resolve) => {
        promptResolve = resolve;
    });
}

function closePrompt(result) {
    const dialog = document.getElementById("tdfPrompt");
    if (dialog?.open) dialog.close();
    const resolve = promptResolve;
    promptResolve = null;
    promptEntry = null;
    if (resolve) resolve(result);
}

/* ---------------- 初始化 ---------------- */

function showDialog() {
    const dialog = document.getElementById("threeDFilesDialog");
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    refreshList();
}

/** 初始化（由 squadCalc.js 调用一次） */
export function initThreeDFiles() {
    if (initialised) return;
    const dialog = document.getElementById("threeDFilesDialog");
    const btn = document.getElementById("threeDFilesBtn");
    if (!dialog || !btn) return;
    initialised = true;

    els = {
        list: dialog.querySelector("#tdfList"),
        status: dialog.querySelector("#tdfStatus"),
        root: dialog.querySelector("#tdfRoot"),
        total: dialog.querySelector("#tdfTotal"),
        summary: dialog.querySelector("#tdfSummary"),
    };

    btn.addEventListener("click", showDialog);

    dialog.querySelector("#tdfSaveRoot").addEventListener("click", async () => {
        const value = els.root.value.trim();
        if (!value) return;
        root = value;
        localStorage.setItem(ROOT_KEY, root);
        await rescan();
        renderRows();
    });

    dialog.querySelector("#tdfRefresh").addEventListener("click", async () => {
        await rescan();
        renderRows();
    });

    dialog.querySelector("#tdfDownloadAll").addEventListener("click", downloadAll);
    dialog.querySelector("#tdfClearAll").addEventListener("click", clearAll);

    dialog.querySelector("#tdfOnlyDownloaded").addEventListener("change", (e) => {
        onlyDownloaded = e.target.checked;
        renderRows();
    });

    els.list.addEventListener("click", (e) => {
        const button = e.target.closest("button[data-act]");
        if (!button) return;
        const rel = button.dataset.rel;
        if (button.dataset.act === "download") downloadMap(rel);
        else if (button.dataset.act === "delete") deleteMap(rel);
    });

    // 打开 3D 时的引导下载对话框
    const prompt = document.getElementById("tdfPrompt");
    if (prompt) {
        promptEls = {
            text: prompt.querySelector("#tdfPromptText"),
            msg: prompt.querySelector("#tdfPromptMsg"),
            bar: prompt.querySelector("#tdfPromptBar"),
            go: prompt.querySelector("#tdfPromptGo"),
            skip: prompt.querySelector("#tdfPromptSkip"),
            cancel: prompt.querySelector("#tdfPromptCancel"),
        };
        promptEls.go.addEventListener("click", async () => {
            if (!promptEntry) return;
            const entry = promptEntry;
            promptEls.go.disabled = true;
            promptEls.skip.disabled = true;
            promptEls.bar.style.display = "block";
            promptEls.msg.textContent = t("common:tdfDownloading", "下载中");
            const ok = await downloadMap(entry.rel, {
                onProgress: (p) => {
                    const pct = Math.min(100, Math.round(((p.index || 0) / (p.total || 1)) * 100));
                    promptEls.bar.querySelector("i").style.width = `${pct}%`;
                    promptEls.msg.textContent = `${t("common:tdfDownloading", "下载中")} ${p.index}/${p.total} · ${mb(p.received)}`;
                },
            });
            if (ok) {
                closePrompt(true);
            } else {
                promptEls.msg.textContent = t("common:tdfFail", "下载失败，请检查网络后重试");
                promptEls.go.disabled = false;
                promptEls.skip.disabled = false;
            }
        });
        promptEls.skip.addEventListener("click", () => closePrompt(true));
        promptEls.cancel.addEventListener("click", () => closePrompt(false));
        // 直接按 ESC 关闭时，也要让 ensureMapAssets 收到“取消”，否则打开 3D 的点击会一直悬着
        prompt.addEventListener("close", () => {
            if (promptResolve) closePrompt(false);
        });
    }

    if (isTauri()) {
        listen("three-d-progress", (event) => updateProgress(event.payload));
        listen("three-d-done", () => rescan().then(renderRows));
    }
}

/** 供外部按钮调用：确保已初始化后打开对话框 */
export function openThreeDFiles() {
    initThreeDFiles();
    showDialog();
}
