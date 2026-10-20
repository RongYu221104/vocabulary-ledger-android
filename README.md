# Vocabulary Ledger Android 离线版

> **1.2.0：Mate 70 / HarmonyOS 7.0 / 卓易通人工验收及同签名覆盖升级通过。** 原生 Android instrumentation 未运行。实际测试范围见 [功能对齐](docs/ANDROID-PARITY.md) 和 [版本说明](releases/RELEASE-1.2.0.md)；历史暂停过程保留在 [检查点](docs/RELEASE-CHECKPOINT.md)。

Android 1.2.0（versionCode 4），包名 `site.chatgpt.rongyu1104.cetledger`。使用 Capacitor 6 与 Android 原生持久层，所有内置词库和字体随 APK 打包；Manifest 不申请 INTERNET 权限。

网页源码基线记录在 `web-source/UPSTREAM.json`。该目录是可独立构建的受版本管理输入，`www/` 和 Android assets 为生成目录。网站的 ChatGPT 登录、云端同步、社区发布/分享与在线个人资料不在离线功能范围内，入口会显示离线限制提示。

## 功能

- 四级词汇大全 4,149 条、六级词汇大全 5,418 条，均为只读、扁平官方账本。六级包含四级基础内容；搜索、分类、A–Z、分页和预览使用相同网页组件。
- 整本复制到本机账本后可编辑、背诵和删除。按个人账本的大小写/空格去重规则分别得到 4,142 / 5,409 个词条，两本同时复制共 9,551 个。不同源记录的内容合并，无字段截断；官方源保持不变。
- 个人账本、考试子账本、自定义多维分组、词条搜索/排序、中文释义、双语例句、备注、掌握状态、批量管理及 JSON v1/v2 导入导出。
- 固定 1/2/3/5/7 天、之后每 7 天的遗忘曲线；保留旧 FSRS 卡片兼容。四档分布：未学习、记忆中、巩固中、已掌握。保留今日进度、30 天趋势和学习记录。
- 每日新词上限、固定 UTC/GMT -12 至 +14 的统计重置（每小时一档）、倒计时；自动模式使用设备本地日历。旧数据中保存的非整点偏移不自动取整，手动选择新偏移时再替换。固定偏移不随夏令时变化，设置与复习状态保存在本机。历史按日汇总保留原标签，不伪造事件，复习日期不因统计偏移改变。
- 本地原子文件 + 备份 + SQLite 镜像 + IndexedDB，沿用既有存储与 JSON 标识。复习保存失败会提示导出备份。系统文件选择器用于导入/导出，Android 返回手势处理弹窗与复习页面。

例句均如实标注“原创教学例句”；可核实真题原句为 0。来源、版权边界与限定质量检查报告随词库保留在 `web-source/official/`。并非逐条人工语言校对，不能将词性、释义和原创教学内容称为官方大纲原文。

## 安装和备份

正式 APK、SHA-256 和更新说明见本仓库 GitHub Releases。安装前核对校验值，并仅为可信安装来源允许系统安装。以后使用同一正式密钥的版本可直接覆盖升级；升级前仍建议导出 JSON。

1.2.0 首次使用独立 Release 密钥。旧测试版使用 Debug 密钥，Android 不允许直接覆盖：如仍有旧测试数据，请先导出 JSON，由用户自行卸载旧包、安装正式包并导入。本次发布不会自动卸载或清空旧应用。

“离线版”没有账号登录或云同步；网页端与离线端通过 JSON 手动迁移。卸载、清除应用数据或丢失设备可能丢失本地内容，内部恢复副本不能替代外部 JSON 备份。

## 开发和构建

需要 Node.js 22+、JDK 21、Android SDK（compileSdk 34 / targetSdk 34）和已安装的 Gradle 构建依赖。首次 `npm ci`，执行：

```powershell
npm run sync:web
npm run test:offline
# 设置 JAVA_HOME / ANDROID_HOME 后，用既有密钥构建
powershell -NoProfile -File scripts/build-release.ps1 -Instrumentation
```

`sync:web` 从受版本管理的 `web-source/` 生成离线页面，不读取生产 API。只有更新网站基线时才在完整项目中执行 `node scripts/update-web-source.mjs`，确认该脚本的目标 Sites 版本并审查差异。不要误把未发布版本标为已发布。

正式签名脚本从 `.signing/` 读取密钥和当前 Windows 用户的 DPAPI 加密密码，密码只进入当前构建进程环境；这些文件被 Git 忽略。`new-release-key.ps1` 仅用于已明确授权的首次签名初始化，拒绝覆盖现有密钥。其他环境可用 Gradle 的 `VOCAB_RELEASE_STORE_FILE`、`VOCAB_RELEASE_STORE_PASSWORD`、`VOCAB_RELEASE_KEY_ALIAS`、`VOCAB_RELEASE_KEY_PASSWORD` 环境变量接入安全签名流程。

必须安全保留密钥和恢复密码。DPAPI 密文依赖当前 Windows 用户配置，复制密文本身不构成跨设备恢复方案；迁移前应由密钥保管人通过安全流程导出恢复材料。不要将密钥、密码、DPAPI 文件或本机配置提交到 GitHub。当前未设 CI 自动签名或云端密钥托管。

## 源码和测试

- `web-source/`：固定网站版本的静态源、官方 JSON 分块及字体许可。
- `src/android-offline.js`、`.css`：离线适配和移动交互。
- `scripts/sync-web.mjs`：可审查的离线页面补丁；上游模式不匹配即失败。
- `android/app/src/main/java/site/chatgpt/rongyu1104/cetledger/`：宿主 Activity、原子文件、SQLite、系统导出桥接。
- `tests/android-offline.test.mjs`：VM 桥接与旧数据恢复、完整词库复制、UTC 及双写失败测试。
- `tests/browser-e2e.test.mjs`：真实桌面 Chromium UI 测试，不能当作 Android 设备验收。
- `android/app/src/test/`：原生文件持久层 JUnit 测试。
- `android/app/src/androidTest/`：针对正式 Release 包的设备测试；完整复制旅程与覆盖安装后的数据保留分开运行。
- `releases/`：忽略的 APK、本次校验文件和版本说明；GitHub Release 才是分发入口。

设备测试会写入独立 QA 账本，仅在新建的测试模拟器或明确可丢弃的测试设备运行，切勿对真实用户数据执行。软件模拟器性能不能代表真实手机；物理设备、低端设备和不同系统 WebView 仍需独立验收。

## 已知边界

大词库使用分块和分页限制 DOM，但本机持久层仍以整份 JSON 快照写入，复习时会验证并序列化当前账本；接近上限或低端设备需关注暂停与磁盘占用。数据上限沿用网页模型，并非无限容量。JSON 导入兼容不能代表任意旧版程序都能接受新增 UTC 字段。

功能对齐、版本、APK 校验值和实际验证范围见 `docs/ANDROID-PARITY.md` 与 `releases/RELEASE-1.2.0.md`。工程总说明在完整项目的 `cloud/docs/AI-PROJECT-CONTEXT.md`，APK 仓库无需该兄弟目录也能构建。
