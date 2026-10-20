# 1.2.0 发布检查点历史

> **最终状态：1.2.0 已于 2026-10-20 正式发布。** 同签名覆盖验收、APK 上传后下载校验完成；tag v1.2.0 指向 501cf08c9ccd6ca421c3d2e71d54ca44a1f5c253。实际记录见 [release.json](../releases/release.json) 与 [正式 Release](https://github.com/RongYu221104/vocabulary-ledger-android/releases/tag/v1.2.0)。下文“尚未/待验证”属于当时暂停或恢复时间点的历史状态，不代表当前结果。

> 恢复更新：用户已确认 9eb66f1d 包可同签名覆盖安装，词库、个人词条、学习记录及每小时 UTC 设置退出重开均正常。网站 v29 已在原 Site 正式部署，源码 7125f5b73cc314bc8307eb9fcdc260bac91317f8；本文件以下暂停描述保留历史审计用途，当前版本以 releases/RELEASE-1.2.0.md 为准。

> **2026-10-20 已恢复（下文为保留的历史暂停记录）。** 手机为 Mate 70 / HarmonyOS 7.0，使用卓易通运行 APK。HDC 3.2.0c 经用户信任指纹后 Connected，只读 shell 已成功；未验证到 Android instrumentation 桥。禁止继续把 ADB 空列表当成手机未连接。
>
> c8f78510 候选已由用户手动安装并完成两组人工验收：官方词库、断网复制与持久化、JSON 导出/合并成功；复习和 UTC 整组未见明显异常。按新要求改为每小时一档后，9eb66f1d 同密钥候选已构建，离线 10/10、JUnit 6/6、签名 v1/v2 通过，等待覆盖安装保留数据确认。完整 SHA-256 为 9eb66f1d30f7ddf62f37d8597cd09c90c8624f54a8582f0202e790fac929758b。正式 Release 尚未创建。
>
> 当前网页源固定到 Git 7125f5b73cc314bc8307eb9fcdc260bac91317f8，每小时选择器及旧偏移保留已完成网页自动化。Sites 新版本保存待返回；当前最后确认生产仍为 v28。最终部署证据应以完成后的发布说明和 QA 报告为准。

2026-10-20 用户要求保存并等待额度重置。源码、签名候选和测试已保留，尚未完成 Android 设备验收，未创建 GitHub Release。

网站已发布并验收 v28；web-source 固定到 6fb989e（v28 加 UTC 帮助文字修正候选），该文字候选尚未确认部署。UPSTREAM.json 不将其标成已发布 v29。

签名候选：releases/vocabulary-ledger-android-1.2.0.apk，SHA-256 475989e7ce487acc503455fc8a2d20d57b2991f0ea21f83062fcc08a9245d0aa。此包构建后又更新了 UPSTREAM 元数据和测试空数据保护，继续发布前必须重新构建并记录新 hash。禁止将它描述为已完成真机验证的最终包。

本地离线 VM/桌面浏览器 10/10、后续 VM 9/9、原生 JUnit 6/6，Release 构建及签名校验通过。设备测试尚未运行，软件模拟器未能启动；最后只读 ADB 检查仍未检测到用户连接的手机。

续接：先检查手机现有包和数据；不卸载、不清数据。完整复制 instrumentation 只适用于空的授权测试实例。设备测试通过后才推送并创建公开仓库 https://github.com/RongYu221104/vocabulary-ledger-android 的正式 Release。仓库已创建，当前仅设置 origin，未推送本轮源码。

密钥 .signing/ 和 DPAPI 密码仅留本机，禁止覆盖或加入 Git。证书 SHA-256 06682961dead953cbbae7afdd30b6859c12f256be9456a0a0183e482eae79a87。现有 Debug 安装不能用新密钥直接覆盖；不能为运行测试卸载用户旧包。

完整阶段记录：兄弟目录 ../qa/integration-20261019/CHECKPOINT-20261020.md 及 ../cloud/qa/integration-20261019/REPORT.md。正式功能对齐文档、最终发布记录和工程清理均尚未完成。
