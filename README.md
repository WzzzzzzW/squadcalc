# SquadCalc 桌面离线版

将官方网页版 [SquadCalc](https://squadcalc.app) 封装为 Windows 桌面应用，内置全部地图与点位数据，断网也能看图、查点位。

## 特性

- 完全离线：地图底图、图层、高程图、缩略图全部本地化，看图不需要联网
- 一键安装：主程序与离线数据打包成单个安装包，装完即用
- 联机功能保留：服务器列表、热力图、多人协作等在线功能仍直连 squadcalc.app
- 3D 地形按需下载：资源在应用内下载，可查看已下载列表并单独卸载
- 数据可分离：主程序通过自定义协议 `sqdata://` 读取数据目录，位置由程序目录下的 `sqdata.txt` 指定，便于迁移到其它磁盘

## 下载

到 [Releases](https://github.com/WzzzzzzW/squadcalc/releases) 页面下载最新版安装包 `SquadCalc_46.1.2_x64-setup.exe`（已内置离线数据，约 600 MB）。

系统要求：Windows 10 / 11（64 位）。依赖 WebView2 运行时，Win10 1809 之后与 Win11 一般已内置，缺失时安装程序会提示安装。

## 从源码构建

### 依赖

- Node.js 22.13 或更高
- Rust（rustup）与 MSVC 工具链
- NSIS 3.x，用于生成安装程序

### 步骤

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

产物为仓库根目录下的 `SquadCalc_46.1.2_x64-setup.exe`。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/` | 前端源码（webpack + jQuery + Leaflet） |
| `src-tauri/` | Rust 后端（Tauri v2）、自定义协议、安装脚本 |
| `tools/export-offline.mjs` | 离线数据导出脚本 |
| `public/` | 前端静态资源，其中 `public/api` 是离线数据，不提交到仓库 |

## 数据来源

地图数据与在线接口均来自官方 [squadcalc.app](https://squadcalc.app)，本项目不修改其内容。

## 致谢

- 原项目 [sh4rkman/SquadCalc](https://github.com/sh4rkman/SquadCalc)：本项目的全部功能与数据都建立在其之上，感谢作者 Maxime "sharkman" Boussard 及所有贡献者
- 地图与在线数据：[squadcalc.app](https://squadcalc.app)
- 桌面化改造过程使用了 DeepSeek V4.1 Flash 模型辅助开发（[deepseek-ai](https://github.com/deepseek-ai)）

## 许可

本项目基于 [sh4rkman/SquadCalc](https://github.com/sh4rkman/SquadCalc) 修改，沿用其 MIT（非商用）许可，版权归原作者所有。详见 [LICENSE](./LICENSE)。
