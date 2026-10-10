/**
 * 图层速查（缩略图选择器）
 * 仿「战术小队辅助台」的地图缩略图墙：先用缩略图定位地图，再点图层缩略图直接切换。
 */

import { App } from "../app.js";
import { MAPS } from "../data/maps.js";

let indexCache = null; // [{ name, mod, layers: [{rawName, shortName, mod}] }]
let activeMap = null;
let query = "";
let dialogMapName = null;

const t = (key, def) => (window.i18next ? window.i18next.t(key, { defaultValue: def }) : def);

const thumbUrl = (rawName) =>
    `${process.env.API_URL}/img/thumbnails/${encodeURIComponent(rawName)}.webp`;

const esc = (s) => App.sanitize(String(s ?? ""));

/** 读取全部地图的图层清单（本地静态 JSON，53 个小文件） */
async function buildIndex() {
    if (indexCache) return indexCache;
    const out = [];
    await Promise.all(
        MAPS.map(async (m) => {
            try {
                const r = await fetch(`${process.env.API_URL}/get/layers/${encodeURIComponent(m.name)}.json`);
                if (!r.ok) return;
                const list = await r.json();
                if (!Array.isArray(list) || !list.length) return;
                out.push({ name: m.name, mod: m.mod || null, layers: list.filter((l) => l && l.rawName) });
            } catch {
                /* 单张地图缺失不影响整体 */
            }
        })
    );
    out.sort((a, b) => a.name.localeCompare(b.name));
    indexCache = out;
    return out;
}

/** 地图封面缩略图（用该图第一个图层的缩略图，体积小，避免加载 4K 底图） */
const mapCover = (m) => thumbUrl(m.layers[0].rawName);

/** 供外部（地图下拉）取封面图；索引未就绪时返回空串 */
export function getMapCover(mapName) {
    const m = indexCache?.find((x) => x.name === mapName);
    return m && m.layers.length ? mapCover(m) : "";
}

/** 供外部预加载索引 */
export function ensureIndex() {
    return buildIndex();
}

function renderMapStrip(root, data) {
    root.innerHTML = data
        .map(
            (m) => `
    <button type="button" class="lf-map${m.name === activeMap ? " is-active" : ""}" data-map="${esc(m.name)}" title="${esc(m.name)}">
        <img loading="lazy" draggable="false" src="${mapCover(m)}" alt="" onerror="this.style.visibility='hidden'">
        <span>${esc(m.name)}${m.mod ? `<i>${esc(m.mod)}</i>` : ""}</span>
    </button>`
        )
        .join("");
}

function layerCard(mapName, l) {
    return `
    <button type="button" class="lf-layer" data-map="${esc(mapName)}" data-layer="${esc(l.rawName)}" title="${esc(l.rawName)}">
        <img loading="lazy" draggable="false" src="${thumbUrl(l.rawName)}" alt="" onerror="this.style.visibility='hidden'">
        <span>${esc(l.shortName || l.rawName)}</span>
    </button>`;
}

function renderLayers(root, data) {
    const q = query.trim().toLowerCase();
    let list;
    if (q) {
        // 搜索时跨全部地图
        list = [];
        for (const m of data) {
            for (const l of m.layers) {
                if (
                    l.shortName?.toLowerCase().includes(q) ||
                    l.rawName.toLowerCase().includes(q) ||
                    m.name.toLowerCase().includes(q)
                ) {
                    list.push({ mapName: m.name, l });
                }
            }
        }
        dialogMapName.textContent = `${t("common:lfSearchResults", "搜索结果")} · ${list.length}`;
    } else {
        const m = data.find((x) => x.name === activeMap) || data[0];
        list = m ? m.layers.map((l) => ({ mapName: m.name, l })) : [];
        dialogMapName.textContent = m ? `${m.name} · ${list.length} ${t("common:lfLayersUnit", "个图层")}` : "";
    }
    root.innerHTML = list.length
        ? list.slice(0, 400).map((x) => layerCard(x.mapName, x.l)).join("")
        : `<div class="lf-empty">${t("common:lfNoResult", "没有匹配结果")}</div>`;
}

/** 初始化（由 squadCalc.js 调用一次） */
export function initLayerFinder() {
    const dialog = document.getElementById("layerFinder");
    const btn = document.getElementById("layerFinderBtn");
    if (!dialog || !btn) return;

    dialogMapName = dialog.querySelector("#lfMapName");
    const mapsRoot = dialog.querySelector("#lfMaps");
    const layersRoot = dialog.querySelector("#lfLayers");
    const searchEl = dialog.querySelector("#lfSearch");
    const loadingEl = dialog.querySelector("#lfLoading");
    const totalEl = dialog.querySelector("#lfTotal");
    const scrollEl = dialog.querySelector("#lfScroll");

    function paint(data) {
        totalEl.textContent = `${data.length} ${t("common:lfMapsUnit", "张地图")} / ${data.reduce((a, m) => a + m.layers.length, 0)} ${t("common:lfLayersUnit", "个图层")}`;
        renderMapStrip(mapsRoot, data);
        renderLayers(layersRoot, data);
    }

    btn.addEventListener("click", async () => {
        dialog.showModal();
        if (indexCache) {
            paint(indexCache);
            return;
        }
        loadingEl.style.display = "block";
        scrollEl.style.visibility = "hidden";
        const data = await buildIndex();
        loadingEl.style.display = "none";
        scrollEl.style.visibility = "visible";
        if (!activeMap) activeMap = data[0]?.name ?? null;
        paint(data);
    });

    // 点地图 -> 切到该图的图层墙
    mapsRoot.addEventListener("click", (e) => {
        const card = e.target.closest(".lf-map");
        if (!card || !indexCache) return;
        activeMap = card.dataset.map;
        renderMapStrip(mapsRoot, indexCache);
        renderLayers(layersRoot, indexCache);
        scrollEl.scrollTop = 0;
    });

    // 点图层 -> 直接切图并关闭
    layersRoot.addEventListener("click", (e) => {
        const card = e.target.closest(".lf-layer");
        if (!card) return;
        App.jumpToLayer(card.dataset.map, card.dataset.layer);
        dialog.close();
    });

    searchEl.addEventListener("input", () => {
        query = searchEl.value;
        if (indexCache) renderLayers(layersRoot, indexCache);
    });

    dialog.addEventListener("close", () => {
        searchEl.value = "";
        query = "";
        // 关掉后释放缩略图 DOM（几十张 webp，留着会一直占内存）
        layersRoot.innerHTML = "";
        mapsRoot.innerHTML = "";
    });
}
