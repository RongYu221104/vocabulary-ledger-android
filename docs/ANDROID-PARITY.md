# Android 1.3.0：网页 v33 功能对齐与验收范围

核实日期：2026-10-22。网页源码固定 `7abd627af0798821eb37f982ce0e439954af365b`，Android 发布源码/tag为 `0da4a256c0c7b99ff689f76a26b7ea7b36654fde` / `v1.3.0`。发布状态以 `releases/release.json` 及公开 Release 实际记录为准，不用本文件宣称尚未完成的上传。

独立工程 `web-source/UPSTREAM.json` 和 `SOURCE_MANIFEST.json` 锁定完整84文件；生成89文件随APK打包，不依赖兄弟cloud目录或运行时网络。

| 网页模块 | Android 1.3.0 对齐 | 本轮证据及限制 |
|---|---|---|
| 账本/词条新增、编辑、删除、掌握、双语备注 | 相同app/model/UI；本机OfflineLedgerStore | VM及真实Edge个人编辑/退出重开；不改用户旧数据 |
| 主账本/子账本、多维分组、排序/筛选/搜索 | 完整groups/order/folios；全局只搜英文与中文释义，局部保留例句 | 上游84文件pin、生成适配断言、旧JSON/结构持久化检查 |
| 官方浏览、分类、搜索、A–Z、分页 | 完整CET4/CET6、来源provenance，最多4路分块预取、每页50条 | 4149+5418=9567；5080真题+4487原创；12项测试含全量数据检查 |
| 官方整本复制为个人账本 | 本地原子模型追加；同形合并保留所有内容 | VM与实际Edge复制4068+5331=9399；重开后9399仍在 |
| 词条排版 | 词头不带词性，释义前缀POS，双语分别加粗；精简真实试卷来源、有效派生备注 | 全量模型/跨度/来源检查；实际查看跨级真题卡与长文本 |
| 复习 | 相同1→2→3→5→7天、之后7天；忘记重排、翻阅/洗牌/提前巩固 | 纯曲线/持久化检查；Edge完成一次实际翻面/评分并重开 |
| 四档统计、今日/30天、每日新词 | 相同review/review-ui，互斥四档；0–9999设置 | Edge9398未学+1记忆中；新学/今日记录重开保留 |
| UTC/GMT设置与倒计时 | 每小时UI、底层兼容15分钟；统计日与调度日分开 | 所有15分钟偏移边界自动检查；Edge UTC+8重开保留；无新手机跨日实测 |
| JSON v1/v2、合并/覆盖预览、备份 | 兼容原format/字段；系统导入、ACTION_CREATE_DOCUMENT导出；本地辅助备份 | VM/原生委托与格式检查；桌面下载事件超时，未获新手机文件选择器实测 |
| 原生数据恢复 | 原子主/备份文件+SQLite镜像+IndexedDB，按较新有效savedAt恢复 | 原生存储JUnit5+模板1；双写失败反馈保留 |
| 最新暖色漫画UI、字体、触摸、返回/键盘 | 全资源本地；适配层保留原生返回/键盘，页脚改为本机备份提示 | Edge官方/复习7档320–1440共14组合无横溢出、console无warn/error；不是所有设备结论 |
| ChatGPT身份/云同步/D1 | 离线不提供 | 禁止网络API，Manifest无INTERNET；不伪造账号或称本地存储为云同步 |
| 社区/资料/在线分享 | 在线入口禁用或拦截 | JSON是手动跨端迁移方式；不改变网页上的既有公开内容 |

## 构建、签名与真实设备范围

版本1.3.0 / code5，包名 `site.chatgpt.rongyu1104.cetledger`；26,423,912字节；APK SHA-256 `5c306867523fe7c1ac9dd0e3ac8f099982ff5e04647aa8a611bedcacf947d441`。

沿用1.2.0同一证书 `06682961dead953cbbae7afdd30b6859c12f256be9456a0a0183e482eae79a87`、https://localhost origin、数据库/文件名及JSON。Release构建和设备测试APK构建成功，v1/v2签名通过、non-debuggable、包内89文件一致；instrumentation **未执行**。签名私钥、DPAPI与用户数据不公开。

鸿蒙7.0/卓易通新包真机测试：用户表示本轮不方便测试，故覆盖升级/断网/原生JSON文件选择器未实测。HDC没有目标，不假定可用ADB；软件模拟器无硬件加速，隔离设置后仍0xC0000005崩溃，未进入可安装状态。没有卸载或清数据。旧1.2.0真实反馈保留在 [历史记录](history/ANDROID-PARITY-1.2.0.md)，不能算本版新验收。

完整本轮本地证据位于项目根 `qa/android-v33-20261022/`。构建复现：`node scripts/sync-web.mjs`、`node --test tests/android-offline.test.mjs tests/v33-parity.test.mjs`、`scripts/build-release.ps1 -Instrumentation`。已发布同名APK必须冻结；之后验证用Gradle build输出，不覆盖正式releases文件。详见附件安装说明和更新日志。
