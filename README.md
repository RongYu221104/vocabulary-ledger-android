# CET Vocabulary Ledger — Android 离线版 (`android-offline`)

本项目基于 `cloud/public` 最新网页端源码，使用 **Capacitor 6 + Android 原生持久层** 构建可独立安装、100% 离线运行的 Android 应用（包名：`site.chatgpt.rongyu1104.cetledger`，应用名：`四六级词汇账本`，当前版本：`1.1` / `versionCode 2`）。

项目独立位于 `cet-vocabulary-ledger/android-offline/`，与 `cet-vocabulary-ledger/cloud/` 并列，拥有自己的 Git 仓库。2026-10-18 已同步网页端最新 `main`（`2eb15e4`）的全部离线可用功能与 UI 更新（含 FSRS-6 智能复习与遗忘曲线图表、30 天背诵趋势、五段记忆分布、SRS 设置容错归一化、词条录入框单行自适应与间距对齐、非破坏性旧数据迁移），完成 `versionCode 2` 升级构建并通过全部 8 项离线单元/WebView E2E 测试与 3 项 JUnit 4 原生存储测试。

## 1. 目录结构

- `capacitor.config.json` — Capacitor 工程配置（`webDir: "www"`）
- `scripts/sync-web.mjs` — 从同级网站工程的 `../cloud/public` 同步网页静态资源到 `www/` 并注入离线适配层（不改动网站源码）
- `scripts/build-apk.mjs` — 一键同步网页资源、执行 `cap sync android`、运行 JUnit 单元测试并构建 Debug APK
- `src/android-offline.css` — Android 触控、安全区、软键盘弹窗高度、离线状态徽标及窄屏防溢出样式
- `src/android-offline.js` — 离线存储适配器（`OfflineLedgerStore` + `OfflineReviewStore`）、登录/云端功能拦截提示、JSON 原生导出桥接、软键盘聚焦滚动与系统返回手势状态机
- `android/` — 完整 Android Gradle 工程源码
  - `app/src/main/java/site/chatgpt/rongyu1104/cetledger/MainActivity.java` — WebView 宿主 Activity、系统文件选择器（`ACTION_CREATE_DOCUMENT`）JSON 导出、系统返回手势分发（`OnBackPressedCallback`）与状态栏配色
  - `app/src/main/java/site/chatgpt/rongyu1104/cetledger/OfflineStorageBridge.java` — `@JavascriptInterface` 原生双写持久化引擎（`files/ledger_state_v1.json` 原子 `fsync` 文件写入 + `cet_offline_store.db` SQLite 镜像 + `files/backups/` 恢复前自动备份）
  - `app/src/test/java/site/chatgpt/rongyu1104/cetledger/OfflineStorageBridgeTest.java` — 原生持久层 JUnit 4 单元测试（含崩溃恢复与损坏回退测试）
- `tests/android-offline.test.mjs` — 离线包完整性、CRUD + FSRS-6 持久化、JSON v1/v2 导入导出与合并、云端拦截提示及返回手势集成测试
- `tests/browser-e2e.test.mjs` — 基于真实 Chromium/WebView 内核（CDP）的端到端测试与 7 档屏幕宽度（`320px`–`1280px`）零横向溢出验证
- `releases/cet-vocabulary-ledger-offline-debug.apk` — 构建输出的独立可安装 Debug APK

## 2. 常用命令

```bash
# 同步 ../cloud/public 网页源码到 www/ 并注入 Android 离线层
npm run sync:web

# 运行离线集成测试 + Chromium WebView 端到端测试
npm run test:offline

# 一键同步、运行 JUnit 测试并构建 Debug APK
npm run apk:debug
```
