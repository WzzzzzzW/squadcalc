// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct MapDownloadInfo { rel: String, bytes: u64, files: u32 }

#[derive(Serialize, Clone)]
struct ProgressPayload { rel: String, file: String, index: u32, total: u32, received: u64, size: u64 }

/// 更新检测结果（字段以 camelCase 传给前端）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current: String,
    latest: String,
    has_update: bool,
    url: String,
    name: String,
}

/// 递归复制目录（迁移旧版下载目录用；已存在的文件不覆盖）
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if !to.exists() {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// 自动查找旧版遗留的 3D 下载目录（%LOCALAPPDATA%\<含 squadcalc 的目录>\3d），
/// 搬到 <exe 目录>\3d 后删除原目录，避免用户重新下载。
fn migrate_legacy_3d(target: &Path) {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return };
    let Ok(entries) = std::fs::read_dir(PathBuf::from(local)) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !name.contains("squadcalc") {
            continue;
        }
        let legacy = entry.path().join("3d");
        if !legacy.is_dir() || legacy == *target {
            continue;
        }
        if copy_tree(&legacy, target).is_ok() {
            let _ = std::fs::remove_dir_all(&legacy);
        }
    }
}

/// 3D 资源默认目录：<exe 目录>\3d（全部落在安装目录，不写 C 盘）
#[tauri::command]
fn three_d_default_root() -> Result<String, String> {
    let dir = exe_dir().join("3d");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 把旧版目录里的 3D 资源搬过来并清掉原目录（已存在的文件会跳过，可安全重复执行）
    migrate_legacy_3d(&dir);
    Ok(dir.to_string_lossy().to_string())
}

/// 扫描某个存储根目录下已下载的地图（<root>/<rel>/...）
#[tauri::command]
fn three_d_scan(root: String) -> Result<Vec<MapDownloadInfo>, String> {
    let root = PathBuf::from(&root);
    if !root.is_dir() { return Ok(vec![]); }
    let mut out = Vec::new();
    collect_maps(&root, &root, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn collect_maps(base: &Path, dir: &Path, out: &mut Vec<MapDownloadInfo>) -> std::io::Result<()> {
    // 只认“含 3d 子目录”的目录为一张已下载地图；rel 用 / 分隔
    let has_3d = dir.join("3d").is_dir();
    if has_3d {
        let mut bytes = 0u64;
        let mut files = 0u32;
        for e in std::fs::read_dir(dir.join("3d"))? {
            let e = e?;
            if e.file_type()?.is_file() {
                bytes += e.metadata()?.len();
                files += 1;
            }
        }
        let rel = dir.strip_prefix(base).unwrap_or(dir).to_string_lossy().replace('\\', "/");
        out.push(MapDownloadInfo { rel, bytes, files });
        return Ok(());
    }
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        if e.file_type()?.is_dir() {
            collect_maps(base, &e.path(), out)?;
        }
    }
    Ok(())
}

/// 删除某张地图已下载的 3D 资源
#[tauri::command]
fn three_d_delete(root: String, rel: String) -> Result<(), String> {
    let dir = PathBuf::from(&root).join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if dir.is_dir() { std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?; }
    Ok(())
}

/// 下载某张地图的 3D 文件（先 apiBase，失败回落 apiFallback），逐个文件发进度事件
#[tauri::command]
async fn three_d_download(
    app: AppHandle,
    root: String,
    rel: String,
    api_base: String,
    api_fallback: Option<String>,
    files: Vec<String>,
) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let rel_dir = PathBuf::from(&root).join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    tokio::fs::create_dir_all(&rel_dir).await.map_err(|e| e.to_string())?;
    let total = files.len() as u32;
    let mut written = 0u64;
    let mut failed: Vec<String> = Vec::new();
    for (i, f) in files.iter().enumerate() {
        let mut last_err = String::from("未知错误");
        let mut done = false;
        // 单个文件最多尝试 3 轮，交替使用主源 / 备用源；失败的继续下后面的文件
        for attempt in 0..3u32 {
            let mut urls: Vec<String> = vec![format!("{}/{}/{}", api_base.trim_end_matches('/'), rel, f)];
            if let Some(fb) = &api_fallback {
                let u2 = format!("{}/{}/{}", fb.trim_end_matches('/'), rel, f);
                if attempt % 2 == 1 { urls.insert(0, u2); } else { urls.push(u2); }
            }
            for url in urls {
                let resp = match client.get(&url).header("X-App-Version", env!("CARGO_PKG_VERSION")).send().await {
                    Ok(r) if r.status().is_success() => r,
                    Ok(r) => { last_err = format!("HTTP {} {}", r.status(), url); continue; }
                    Err(e) => { last_err = format!("{} {}", e, url); continue; }
                };
                let dest = rel_dir.join(f.replace('/', std::path::MAIN_SEPARATOR_STR));
                if let Some(p) = dest.parent() {
                    tokio::fs::create_dir_all(p).await.map_err(|e| e.to_string())?;
                }
                match resp.bytes().await {
                    Ok(bytes) => {
                        tokio::fs::write(&dest, &bytes).await.map_err(|e| e.to_string())?;
                        written += bytes.len() as u64;
                        done = true;
                    }
                    Err(e) => last_err = format!("{} {}", e, url),
                }
                if done { break; }
            }
            if done { break; }
        }
        if !done {
            failed.push(format!("{} ({})", f, last_err));
        }
        let _ = app.emit("three-d-progress", ProgressPayload { rel: rel.clone(), file: f.clone(), index: i as u32 + 1, total, received: written, size: 0 });
    }
    if !failed.is_empty() {
        return Err(format!("{} 个文件下载失败: {}", failed.len(), failed.join("; ")));
    }
    let _ = app.emit("three-d-done", rel);
    Ok(written)
}

/* ---------------- 更新检测 ---------------- */

/// 把 "v46.1.0" 拆成 [46, 1, 0]，按段做数值比较
fn version_key(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(|c| c == 'v' || c == 'V')
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<u64>().ok())
        .collect()
}

/// 查询 GitHub 上的最新 Release，与当前版本比较
#[tauri::command]
async fn check_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let client = reqwest::Client::builder()
        .user_agent("SquadCalc-Desktop")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.github.com/repos/WzzzzzzW/squadcalc/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let latest = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start_matches(|c| c == 'v' || c == 'V')
        .to_string();
    let has_update = !latest.is_empty() && version_key(&latest) > version_key(&current);
    Ok(UpdateInfo {
        current,
        latest,
        has_update,
        url: json.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        name: json.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    })
}

/// 用系统默认浏览器打开链接（仅允许 http/https）
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("仅允许 http/https 链接".to_string());
    }
    std::process::Command::new("explorer")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ---------------- 离线数据协议（数据独立于 exe） ----------------
 * 数据根目录按以下顺序解析：
 *   1) <exe 目录>\sqdata.txt —— 一行纯文本，内容是数据根目录（由“数据包”安装程序写入）
 *   2) <exe 目录>\data
 * 数据根目录下应有 api\ 子目录，因此页面按 http://sqdata.localhost/api/... 访问。
 */

/// exe 所在目录（进程内只解析一次）
fn exe_dir() -> &'static Path {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|x| x.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    })
}

/// 数据根目录（进程内只解析一次，避免每个资源请求都读一遍 sqdata.txt）
fn data_root() -> &'static Path {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let dir = exe_dir();
        if let Ok(text) = std::fs::read_to_string(dir.join("sqdata.txt")) {
            let p = text.trim();
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
        dir.join("data")
    })
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "json" => "application/json",
        "webp" => "image/webp",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "html" => "text/html; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "css" => "text/css",
        "js" => "text/javascript",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

fn deny(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}

/// 把 http://sqdata.localhost/xxx 映射到 <数据根目录>/xxx
fn serve_data(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    if request.method() == tauri::http::Method::OPTIONS {
        return tauri::http::Response::builder()
            .status(204)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            .header("Access-Control-Allow-Headers", "*")
            .body(Vec::new())
            .unwrap();
    }
    let uri_path = request.uri().path().to_string();
    // 防目录穿越
    if uri_path.contains("..") || uri_path.contains('\\') {
        return deny(400);
    }
    let rel = uri_path.trim_start_matches('/').replace('/', std::path::MAIN_SEPARATOR_STR);
    if rel.is_empty() {
        return deny(404);
    }
    let file = data_root().join(&rel);
    // HEAD 只要长度，直接看元数据，避免把整个大图读进内存又丢掉
    if request.method() == tauri::http::Method::HEAD {
        return match std::fs::metadata(&file) {
            Ok(md) if md.is_file() => tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime_of(&file))
                .header("Content-Length", md.len())
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-cache")
                .body(Vec::new())
                .unwrap(),
            _ => deny(404),
        };
    }
    match std::fs::read(&file) {
        Ok(bytes) => {
            let len = bytes.len();
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime_of(&file))
                .header("Content-Length", len)
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-cache")
                .body(bytes)
                .unwrap()
        }
        Err(_) => deny(404),
    }
}

fn main() {
    // WebView2 的用户数据（缓存/GPU 缓存等）默认会写到 C 盘用户目录，
    // 这里改到 exe 同目录，保证程序不在 C 盘留任何东西。
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        let dir = exe_dir().join("webview2");
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
    }

    // 关掉本应用用不到的后台服务（翻译/组件更新/域可靠性/崩溃上报/后台联网/同步），
    // 并收紧 JS 堆与磁盘缓存上限，减少进程数、内存与 CPU 占用。
    // 采用“追加”方式，保留外部/调试已设置的参数（例如 --remote-debugging-port）。
    const EXTRA_ARGS: &str = "\
--disable-background-networking \
--disable-component-update \
--disable-domain-reliability \
--disable-breakpad \
--disable-crash-reporter \
--disable-sync \
--no-first-run \
--no-default-browser-check \
--disable-features=Translate,msSmartScreenProtection,msWebOOUI,msPdfOOUI,BackForwardCache \
--disk-cache-size=134217728 \
--js-flags=--max-old-space-size=1024";
    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let merged = format!("{existing} {EXTRA_ARGS}");
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged.trim());

    tauri::Builder::default()
        // 离线数据走自定义协议，数据目录可与 exe 分离安装
        .register_uri_scheme_protocol("sqdata", |_ctx, request| serve_data(request))
        .invoke_handler(tauri::generate_handler![
            three_d_default_root, three_d_scan, three_d_delete, three_d_download,
            check_update, open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running squadcalc desktop application");
}
