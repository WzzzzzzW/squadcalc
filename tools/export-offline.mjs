/**
 * SquadCalc 全量离线数据导出
 *
 * 数据源：官方 https://squadcalc.app/api
 *        可用环境变量 SRC_API 覆盖（例如换成自建镜像）。
 *
 * 地图底图：默认全部从 API 下载。若本地已有一批 4K 原图，可设置环境变量
 *          LOCAL_MAPS_DIR（目录）与 LOCAL_MAPS_JSON（索引 json）复用它们，缺的再走 API。
 *
 * 3D 资源（3d/landscape.png、props、trees）：不打包进安装包，只生成 public/api/3d-manifest.json
 *          清单（含每个文件体积），由应用内按需下载，可在应用里管理/卸载。
 *          下载源就是上面的官方 API，不设备用源。
 *
 * 用法：
 *   node tools/export-offline.mjs --dry            仅盘点，不下载
 *   node tools/export-offline.mjs --no-images      只导出 JSON（图层清单/明细）
 *   node tools/export-offline.mjs                  全量导出
 *
 * 产出（与官方 API 路径一一对应，供本地静态访问）：
 *   public/api/health.json
 *   public/api/get/layers/<MapName>.json
 *   public/api/get/layer/<rawName>.json
 *   public/api/3d-manifest.json
 *   public/api/img/maps/<slug>/basemap.webp | topomap.webp | terrainmap.webp | heightmap.png
 *   public/api/img/thumbnails/<rawName>.webp
 */
import { MAPS } from '../src/data/maps.js';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'api');
const API = process.env.SRC_API || 'https://squadcalc.app/api';
const VER = '46.1.0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 可选的本地 4K 原图目录与索引（两个都提供且存在时才会复用，否则全部走 API） */
const LOCAL_MAPS_DIR = process.env.LOCAL_MAPS_DIR || '';
const LOCAL_MAPS_JSON = process.env.LOCAL_MAPS_JSON || '';
/** 本地 slug -> SquadCalc slug 的差异项 */
const SLUG_RENAME = { pacificprovinggrounds: 'pacific' };

const ALL_MODS = [
  'SuperMod',
  'InfiniteWarefare',
  'SteelDivision',
  'SquadAdminTools',
  'GalacticContention',
  'WarZone',
];

const DRY = process.argv.includes('--dry');
const NO_IMAGES = process.argv.includes('--no-images');
const NO_HEIGHTMAP = process.argv.includes('--no-heightmap');
const NO_3D = process.argv.includes('--no-3d');
const CONC = Number(process.env.CONC || 4);

const HEAD = { 'X-App-Version': VER, 'User-Agent': UA, Accept: '*/*' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 遇到 429 时全局暂停，避免所有 worker 一起撞墙 */
let cooldownUntil = 0;
async function waitCooldown() {
  while (Date.now() < cooldownUntil) await sleep(1000);
}

async function fetchText(url, tries = 8) {
  for (let i = 1; i <= tries; i++) {
    await waitCooldown();
    try {
      const r = await fetch(url, { headers: HEAD });
      if (r.status === 429) {
        cooldownUntil = Date.now() + 15000;
        await sleep(2000 * i);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === tries) break;
      await sleep(600 * i);
    }
  }
  throw new Error(`重试耗尽 ${url}`);
}

async function fetchBuf(url, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    await waitCooldown();
    try {
      const r = await fetch(url, { headers: HEAD });
      if (r.status === 429) {
        cooldownUntil = Date.now() + 15000;
        await sleep(2000 * i);
        continue;
      }
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch {
      if (i === tries) return null;
      await sleep(600 * i);
    }
  }
  return null;
}

/** 只取体积：先 HEAD（要求 identity，避免 gzip 导致没有 content-length），
 *  拿不到就用 2 字节 Range 读 content-range。失败返回 0 */
async function headSize(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    await waitCooldown();
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { ...HEAD, 'Accept-Encoding': 'identity' } });
      if (r.status === 429) {
        cooldownUntil = Date.now() + 15000;
        await sleep(2000 * i);
        continue;
      }
      if (!r.ok) return 0;
      const cl = r.headers.get('content-length');
      if (cl) return Number(cl);
      const r2 = await fetch(url, { headers: { ...HEAD, Range: 'bytes=0-1' } });
      const cr = r2.headers.get('content-range');
      if (cr && cr.includes('/')) return Number(cr.split('/').pop());
      return 0;
    } catch {
      if (i === tries) return 0;
      await sleep(400 * i);
    }
  }
  return 0;
}

async function pool(items, limit, fn) {
  const it = items[Symbol.iterator]();
  let done = 0;
  let fail = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let n = it.next(); !n.done; n = it.next()) {
      try {
        await fn(n.value);
      } catch (e) {
        fail++;
        console.log(`  ! ${n.value}: ${e.message}`);
      }
      done++;
      if (done % 20 === 0) process.stdout.write(`\r  进度 ${done}/${items.length}   `);
    }
  });
  await Promise.all(workers);
  process.stdout.write(`\r  进度 ${done}/${items.length}（失败 ${fail}）   \n`);
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/** 本地可选底图：SquadCalc slug -> 本地 jpg 绝对路径 */
async function localBasemaps() {
  const map = new Map();
  if (!LOCAL_MAPS_DIR || !LOCAL_MAPS_JSON || !existsSync(LOCAL_MAPS_JSON)) return map;
  const data = JSON.parse(await readFile(LOCAL_MAPS_JSON, 'utf8'));
  for (const m of data.maps) {
    const slug = SLUG_RENAME[m.slug] || m.slug;
    const file = path.join(LOCAL_MAPS_DIR, path.basename(m.image));
    if (existsSync(file)) map.set(slug, file);
  }
  return map;
}

// ---------------------------------------------------------------- 0. 本地底图
const localMap = await localBasemaps();
/** 所有地图图片的相对路径，例如 img/maps/albasrah/ 与 img/maps/MODS/GC/coruscant/ */
const mapRels = [
  ...new Set(
    MAPS.map((m) => (m.mapURL || '').replace(/^\//, '')).filter((s) => s.startsWith('img/maps/')),
  ),
];
console.log(`源 API    : ${API}`);
console.log(`本地 4K 图: ${localMap.size} 张（可直接复用，不下载）`);
console.log(`SquadCalc : ${MAPS.length} 张地图 / ${mapRels.length} 个图片目录`);

// ---------------------------------------------------------------- 1. health
const health = await fetchText(`${API}/health`);
console.log('health    :', health.trim());
if (!DRY) {
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'health.json'), health, 'utf8');
  // 服务器列表不打包快照：联机多人服务器改为直连官方在线接口（实时数据）
}

// ---------------------------------------------------------------- 2. 每图图层清单
console.log(`\n[1/4] 图层清单（${MAPS.length} 张地图）…`);
const modsParam = ALL_MODS.join(';');
const layerIndex = new Map(); // rawName -> shortName
const perMap = [];
await pool(MAPS, CONC, async (map) => {
  const url = `${API}/get/layers?map=${encodeURIComponent(map.name)}&mods=${encodeURIComponent(modsParam)}`;
  const list = JSON.parse(await fetchText(url));
  perMap.push({ name: map.name, mod: map.mod || null, count: list.length, list });
  for (const l of list) if (l?.rawName) layerIndex.set(l.rawName, l.shortName || l.rawName);
});
perMap.sort((a, b) => a.name.localeCompare(b.name));
console.log(`  地图 ${perMap.length} 张，去重图层 ${layerIndex.size} 个`);
if (!DRY) {
  await mkdir(path.join(OUT, 'get', 'layers'), { recursive: true });
  for (const m of perMap) {
    await writeFile(path.join(OUT, 'get', 'layers', `${m.name}.json`), JSON.stringify(m.list), 'utf8');
  }
}

const names = [...layerIndex.keys()];
if (DRY) {
  let sum = 0;
  const sample = [names[0], names[(names.length / 3) | 0], names[(names.length / 2) | 0], names[names.length - 1]];
  for (const n of sample) {
    const t = await fetchText(`${API}/get/layer?name=${encodeURIComponent(n)}`);
    sum += t.length;
  }
  console.log(`\n抽样 4 个图层平均 ${(sum / 4 / 1024).toFixed(0)} KB`);
  console.log(`预计总量：图层JSON ≈ ${mb((sum / 4) * names.length)}，缩略图 ≈ ${mb(200 * 1024 * names.length)}`);
  console.log(`本地可复用底图 ${localMap.size} 张；其余 ${mapRels.length - localMap.size} 张需下载`);
  process.exit(0);
}

// ---------------------------------------------------------------- 3. 图层明细
console.log(`\n[2/4] 图层明细（${names.length} 个）…`);
await mkdir(path.join(OUT, 'get', 'layer'), { recursive: true });
await pool(names, CONC, async (n) => {
  const dest = path.join(OUT, 'get', 'layer', `${n}.json`);
  if (existsSync(dest)) return;
  const t = await fetchText(`${API}/get/layer?name=${encodeURIComponent(n)}`);
  await writeFile(dest, t, 'utf8');
});

if (NO_IMAGES) {
  console.log('\n已跳过图片（--no-images）');
  process.exit(0);
}

// ---------------------------------------------------------------- 4. 图片
console.log(`\n[3/4] 底图（本地复用 + 代理补缺）…`);
const imgRoot = path.join(OUT, 'img');
let reused = 0;
let downloaded = 0;
for (const rel of mapRels) {
  const dir = path.join(OUT, rel); // rel 形如 img/maps/... -> 落到 public/api/img/maps/...
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, 'basemap.webp');
  if (existsSync(dest)) continue;
  const slug = rel.replace(/\/$/, '').split('/').pop();
  // 仅原版地图（一级路径）复用本地 4K 图；模组地图本地没有
  const local = !rel.includes('/MODS/') ? localMap.get(slug) : null;
  if (local) {
    await writeFile(dest, await readFile(local)); // 直接复用本地 4K 原图
    reused++;
    continue;
  }
  const buf = await fetchBuf(`${API}/${rel}basemap.webp`);
  if (buf) {
    await writeFile(dest, buf);
    downloaded++;
  } else {
    console.log(`  ! 缺底图 ${rel}`);
  }
}
console.log(`  本地复用 ${reused} 张，下载 ${downloaded} 张`);

// 地图图层变体：topomap（等高线图）/ terrainmap（地形图）；HD 瓦片体量过大不内置
console.log('[3.2] 图层变体 topomap / terrainmap …');
let variants = 0;
for (const rel of mapRels) {
  for (const name of ['topomap.webp', 'terrainmap.webp']) {
    const dest = path.join(OUT, rel, name);
    if (existsSync(dest)) continue;
    const buf = await fetchBuf(`${API}/${rel}${name}`);
    if (buf) {
      await writeFile(dest, buf);
      variants++;
    }
  }
}
console.log(`  变体下载 ${variants} 个`);

// 3D 资源：不打包进安装包，只生成清单（含体积），由应用内按需下载
if (!NO_3D) {
  console.log('[3.3] 生成 3D 资源清单（只探测体积，不下载）…');
  const THREED_FILES = ['3d/landscape.png', '3d/props.json', '3d/props.bin', '3d/trees.json', '3d/trees.bin'];
  const manifestMaps = [];
  let probed = 0;
  for (const rel of mapRels) {
    const files = [];
    for (const name of THREED_FILES) {
      const size = await headSize(`${API}/${rel}${name}`);
      if (size > 0) files.push({ path: name, size });
      probed++;
    }
    if (files.length) {
      const mapName = MAPS.find((m) => (m.mapURL || '').replace(/^\//, '').replace(/\/$/, '') === rel.replace(/\/$/, ''))?.name;
      manifestMaps.push({
        name: mapName || rel,
        rel: rel.replace(/\/$/, ''),
        files,
        total: files.reduce((a, f) => a + f.size, 0),
      });
    }
    process.stdout.write(`\r  探测 ${probed}/${mapRels.length * THREED_FILES.length}   `);
  }
  process.stdout.write('\n');
  const manifest = {
    generatedAt: new Date().toISOString(),
    apiBase: API,
    files: THREED_FILES,
    maps: manifestMaps,
  };
  await writeFile(path.join(OUT, '3d-manifest.json'), JSON.stringify(manifest), 'utf8');
  const grand = manifestMaps.reduce((a, m) => a + m.total, 0);
  console.log(`  可用 3D 的地图 ${manifestMaps.length} 张，合计 ${mb(grand)}`);
}

if (!NO_HEIGHTMAP) {
  console.log('[3.5] 高程图…');
  for (const rel of mapRels) {
    const dest = path.join(OUT, rel, 'heightmap.png');
    if (existsSync(dest)) continue;
    const buf = await fetchBuf(`${API}/${rel}heightmap.png`);
    if (buf) await writeFile(dest, buf);
  }
} else {
  console.log('  已跳过高程图（加 --no-heightmap 可跳过）');
}

console.log(`\n[4/4] 图层缩略图（${names.length} 个）…`);
await mkdir(path.join(imgRoot, 'thumbnails'), { recursive: true });
await pool(names, CONC, async (n) => {
  const dest = path.join(imgRoot, 'thumbnails', `${n}.webp`);
  if (existsSync(dest)) return;
  const buf = await fetchBuf(`${API}/img/thumbnails/${encodeURIComponent(n)}.webp`);
  if (buf) await writeFile(dest, buf);
});

// ---------------------------------------------------------------- 汇总
async function dirStat(p) {
  let total = 0;
  let count = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        total += (await stat(full)).size;
        count++;
      }
    }
  };
  if (existsSync(p)) await walk(p);
  return { total, count };
}
const s = await dirStat(OUT);
console.log(`\n完成：${s.count} 个文件，${mb(s.total)} → ${OUT}`);
