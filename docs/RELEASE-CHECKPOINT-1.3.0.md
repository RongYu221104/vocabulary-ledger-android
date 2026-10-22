# Android 1.3.0 发布检查点

核实日期2026-10-22。网页v33 Git为7abd627af0798821eb37f982ce0e439954af365b，本任务不改其源码、不重新部署、不触碰生产D1。

Android发布tag v1.3.0固定0da4a256c0c7b99ff689f76a26b7ea7b36654fde；后续main维护提交不移动tag。冻结APK为releases/vocabulary-ledger-android-1.3.0.apk，26,423,912字节，SHA-256 5c306867523fe7c1ac9dd0e3ac8f099982ff5e04647aa8a611bedcacf947d441。同既有正式1.2.0证书，包名、https origin、文件/SQLite/IDB和JSON兼容标识不改。

现有正式v1.3.0已补齐四附件：APK、SHA256SUMS.txt、RELEASE-1.3.0.md、INSTALL-1.3.0.md。GitHub API确认draft=false/prerelease=false，四项state=uploaded。2026-10-22实际公开无登录下载全部文件，大小和完整SHA-256均与本地及GitHub digest一致；发布验收通过。releases/release.json与README已更新；旧1.2.0元数据原样保留在releases/history/release-1.2.0.json。

离线12项、原生JVM6项、签名与Release构建通过；完整适配输出89文件，Capacitor另加2个空Cordova占位文件，共91项public资产均与冻结包/验证包一致。清理后重跑全部相关检查；网页202通过/1既有skip、tsc/build通过，393个受控源码字节未变。验证重构建ZIP577文件内容均与冻结包相同，但容器SHA不同，不覆盖冻结APK。

真机用户本轮不方便测试，模拟器软件启动崩溃，instrumentation只构建未运行；桌面JSON下载事件超时，不声称原生文件选择器或覆盖升级实测通过。详细对齐范围见ANDROID-PARITY.md；1.2.0历史证据单独保留在docs/history。

跨仓库技术说明位于项目根docs/AI-PROJECT-CONTEXT.md，本轮QA位于qa/android-v33-20261022；这些父目录文件不随此独立仓库push。该QA清单仅删除9个本轮空模拟器磁盘/重复下载验证文件，原有worktree、密钥、工具链、源词库、正式APK、Git及报告全部保留。

恢复发布时使用已有GitHub登录会话或正常授权的CLI，不探取Git传输凭据用于API。浏览器扩展曾拒绝本地文件读取，最终由用户手动完成四附件上传；Codex验证公开下载，不将用户上传操作冒称自动上传成功。重复空草稿untagged-aadf7197a0f8815ee204独立保留；删除虽经用户授权但被自动审批拒绝，未绕过。不要误删正式Release或tag。
