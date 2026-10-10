# SquadCalc 桌面离线版

把官方网页版 [SquadCalc](https://squadcalc.app) 做成 Windows 桌面应用，可离线浏览地图。

## 与原版的区别

- 地图底图、图层、高程图、缩略图全部本地化，看图不需要联网
- 服务器列表、热力图、多人协作等在线功能仍直连 squadcalc.app
- 3D 地形资源在应用内按需下载，可查看已下载列表并卸载
- 主程序与离线数据分离：主程序按自身目录下的 `sqdata.txt` 定位数据目录，通过自定义协议 `sqdata://` 读取
- 打包为 Windows 安装程序，主程序与离线数据一次装完

## 下载

在 Releases 页面下载 `SquadCalc_46.1.0_x64-setup.exe`（已内置离线数据，约 600 MB）。

系统要求：Windows 10 / 11。依赖 WebView2 运行时，Win10 1809 之后与 Win11 一般已内置，缺失时需要自行安装。

## 构建

依赖：

- Node.js 22.13 或更高
- Rust（rustup）与 MSVC 工具链
- NSIS 3.x，用于生成安装程序

步骤：

1. 安装前端依赖

```
npm install
```

2. 复制 `.env.template` 为 `.env`。默认值已指向 squadcalc.app，无需改动。

3. 生成离线数据（约 1 GB，输出到 `public/api`）

```
node tools/export-offline.mjs
```

4. 生成安装程序，双击 `编译安装包.bat`。等价于依次执行：

```
npm run build
cargo build --release --manifest-path src-tauri/Cargo.toml
makensis src-tauri/installer/squadcalc-full.nsi
```

产物为仓库根目录下的 `SquadCalc_46.1.0_x64-setup.exe`。

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/` | 前端源码（webpack + jQuery + Leaflet） |
| `src-tauri/` | Rust 后端（Tauri v2）、自定义协议、安装脚本 |
| `tools/export-offline.mjs` | 离线数据导出脚本 |
| `public/` | 前端静态资源，其中 `public/api` 是离线数据，不提交到仓库 |

## 数据来源

地图数据与在线接口均来自官方 squadcalc.app，本项目不修改其内容。

## 开发说明与致谢

本项目的桌面化改造与开发过程使用了 **DeepSeek V4.1 Flash** 模型（`deepseek-flash`）。

感谢 DeepSeek 提供模型与技术支持：

- 官方网站：https://www.deepseek.com
- GitHub：https://github.com/deepseek-ai
- 模型发布说明：https://www.deepseek.com/news/deepseek-v4-1-flash/

## 许可

本项目基于 [sh4rkman/SquadCalc](https://github.com/sh4rkman/SquadCalc) 修改，沿用其 MIT（非商用）许可，版权归原作者所有。详见 [LICENSE](./LICENSE)。
