# 1.2.0 离线功能对齐与验收范围

网页源基线、候选状态见 `web-source/UPSTREAM.json`；本文件随最终设备反馈更新。独立 Android 工程无需兄弟 cloud 目录即可从固定源构建。

| 网页模块 | 离线实现 | 当前验证依据与边界 |
|---|---|---|
| 账本及词条 CRUD、备注、双语例句、掌握状态 | 同一 model/app/UI，本地 OfflineLedgerStore 保存 | VM、桌面真实 Chromium；手机反馈另列 |
| 考试子账本、多维自定义分组、搜索/排序/筛选 | 同一 groups/order/folios 结构，保存于既有 JSON envelope | 全部静态业务源同步；旧结构持久化集成检查 |
| 官方分类、搜索、A–Z、预览、分页 | 同一 official.js/official-ui.js，52 个 JSON 分块随包 | APK 内 57 个词库和来源文件字节一致；4,149 / 5,418 源记录 |
| 整本独立复制 | 同一 importTag 模型，保存到本机，不调用云 API | 完整词库 VM 复制共 9,551 个个人词条，无截断；Mate 70 卓易通用户实测断网浏览、复制、退出重开整组通过 |
| 遗忘曲线 | 同一 curve.js，1/2/3/5/7 天，之后每 7 天；保留旧 FSRS 卡片 | 网页算法确定性测试和离线持久化集成通过；不在手机上改日期伪造七天验收 |
| 四档统计、今日进度、30 天趋势、学习记录 | 同一 review/review-ui，离线 review envelope | 未学习/记忆中/巩固中/已掌握互斥；桌面 UI 及模型检查 |
| 每日新词、UTC/GMT 统计重置、倒计时 | 同一设置 UI；偏移与进度本地持久化 | 选择器 -12 到 +14、每小时一档；保留旧非整点设置；历史日聚合不重写；首轮手机整组未见明显异常，新包待覆盖验收 |
| JSON v1/v2、合并/覆盖预览、自动备份 | 同一模型及 review 分节；系统导入选择器、原生 ACTION_CREATE_DOCUMENT 导出 | VM/桌面流程通过；卓易通用户确认实际导出文件及合并导入成功，不清空数据 |
| 数据持久化与故障恢复 | 原子同目录替换、备份、SQLite 镜像、IndexedDB；较新镜像 savedAt 选择 | 原生存储 JUnit 5 项通过，外加模板 1 项；本地双写都失败时显示提示 |
| 移动 UI、触摸、动画、返回键、键盘避让 | 网页资源 + android-offline.css 与 MainActivity 返回桥 | 桌面 Chromium 七档视口通过；实际手机仅按真实反馈记录 |
| 字体和图形 | 本地 Source Han Serif SC Regular、OFL 与 NOTICE，SVG/图标随包 | 无需运行时网络；不分发 Georgia 字体文件 |
| ChatGPT 登录/身份会话 | 不提供，显示离线限制 | 不伪造在线账号；手机容器本身的登录与本应用无关 |
| 账号云同步、D1、跨设备保存 | 不提供；使用 JSON 手动迁移 | 应用 Manifest 不申请 INTERNET，不以本地存储称云同步 |
| 在线社区、公开账本发布、分享链接、在线头像/资料 | 不提供；在线入口由适配层隐藏或拦截 | 不新增云账号和在线 API；原始已发布社区内容不受 APK 操作影响 |

## HarmonyOS / 卓易通

用户设备为华为 Mate 70、HarmonyOS 7.0，APK 通过卓易通安装。该环境的实际通过项属于兼容层验收，不是原生 HarmonyOS HAP，也不是原生 Android instrumentation。HDC 能识别鸿蒙宿主不意味着能安装 Android APK 或访问容器内的 Android 测试运行器。

2026-10-20 用户信任电脑指纹后，HDC 3.2.0c 实际显示 Connected，只读 shell 返回 CLS-AL00 / OpenHarmony-7.0.0.105。宿主有 aa/bm 等鸿蒙工具，未检测到 adb/am/pm；尚无已验证的卓易通 APK 调试桥。c8f78510 签名候选由用户手动安装并确认能打开，官方词库及持久化人工测试通过；复习、UTC 整组反馈“感觉没什么问题”，JSON 导出及合并整组“均成功”。改为每小时一档后，用户对指定 9eb66f1d 新包覆盖安装、数据/记录保留、每小时列表及 +8 设置退出重开保留整组回复“均正常，可覆盖安装”。该包本机 VM/桌面回归 10/10、JUnit 6/6、签名 v1/v2 通过；没有对它重新运行全部首轮手机流程。不能把 HDC 连接成功写成 APK 自动化通过。

系统文件管理的 `我的手机/Download`，在卓易通文件选择器中可能对应 `MyHarmonyDevice（我的设备(鸿蒙)）/Download`。按华为支持说明和设备实际表现验收，不假定两个文件选择器完全等同。

完整真实设备过程记录在完整工程 `qa/integration-20261019/HARMONY-DEVICE-QA.md`；发布说明将列出最终通过项和未验证项。当前未运行 Release instrumentation，不能用构建成功替代运行成功。

## 构建与数据保护

包名、WebView origin、IndexedDB/SQLite 和 JSON 标识保留。1.2.0 首次引入经用户批准的独立 Release 密钥，和旧 Debug 签名不同；不能直接覆盖旧 Debug 包。禁止为测试擅自卸载或清除已有数据。后续同正式证书版本使用覆盖升级，并验证本地数据保留。

全量复制 instrumentation 明确要求目标实例为空；已有内容时断言失败，不调用清理 API。不要将此 fixture 用在真实个人账本上。

大词库限制 DOM 数量，但原生持久层仍写整份快照；该实现的磁盘/序列化成本没有被重构成逐词数据库。APK 约 25 MB，具体 SHA-256 和最终尺寸以实际 Release 附件为准。
