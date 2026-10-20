# 数据来源与使用边界

本文件由 Codex 于 2026-10-19 接手审计后重写。原交接版本完整保存在 `_audit/legacy-handoff/SOURCES.md`；旧报告中的统计不能直接作为验收结论。

## 官方大纲

- 官网当前英语大纲入口：[教育部教育考试院 CET 考试大纲索引](https://cet.neea.edu.cn/html1/folder/16113/1588-1.htm)。该索引仍列《全国大学英语四、六级考试大纲（2016年修订版）》。这是本轮能核实的最新官网列示英语大纲，不将其他语种新大纲误作英语更新。
- [官方 PDF](https://cet.neea.edu.cn/res/Home/1704/55b02330ac17274664f06d9d3db8249d.pdf)。下载副本 `_audit/official-syllabus.pdf` 与原有 `cet_syllabus_2016.pdf` 字节数均为 12070155，SHA-256 均为 `9166d3c03b7bc43abd9d9df91bd2ef8085b4419286f1e5ca100dea68f3cfd1f1`。
- 官网索引 HTML、实际获取 URL、状态码、哈希：`_audit/official-index.html`、`_audit/web-sources.json`。可读取快照复查，不依赖搜索摘要。
- PDF 物理第20页说明：词表仅列词形，不给词性、释义及读音；六级词加★；同形词可分列。故成品里的中文释义、例句、搭配不是官方给出的内容。
- PDF 物理第21–149页：独立几何提取出5377条原始词形行，其中四级基础4114行、六级新增1263行。全部原始行与继承JSON逐行匹配，无新增或缺失源行；证据 `_audit/syllabus-independent-rows.json`、`syllabus-row-diff.json`。

### 计数与兼容约定

继承词表按全词斜杠变体拆分为5418条记录（四级4149、六级新增1269）。其中 `apartment/apt.`、`barbecue/BBQ`、`Internet/internet`、`television/TV` 保留合并形式，后缀替换及括号拼写也保留一个词头。这是**可复现的继承计数约定**，并不是官网单独公布的四级4149词、六级1269新增词统计。

记录含5411个不同词头标签；7组重复标签可追溯到原书不同源行及交叉拼写。它们保留不同 `Sxxxxx` ID，不能用同名键覆盖。`tire` 的使疲倦义与 `tyre/tire` 源行的轮胎义须分别绑定。两套词库的记录数不能相加当作独立词汇量，六级包含四级基础内容。

原PDF页脚印有5418词目、2551派生词。继承数据中的派生词实际上是2521个原始字符串单元，不是报告中的2523；独立按表格单元重新读取并修复两处碎片后为2519个单元。原书印刷统计与字符串单元的计数口径尚未独立解释，不强行拆分凑数。已对比所有源行的派生词单元，差异只有 `age: ag(e)+ing → ag(e)ing` 与 `marvel: marvel(+l)ous → marvel(l)ous`，且已看原页图像核对。证据 `_audit/derivative-cell-extraction.json`、`derivative-corrections.json`、`age-source.png`、`marvel-source.png`。构建层修复，继承JSON不改写。

## 2024-06至2026-06真题候选资料

- 继承语料 `_scripts/exam_corpus.json` 共有11740条，8263种不同英文；6002条中文为空，5738条非空。非空不代表双语对齐正确。
- 本地源文件30份，覆盖2024-06、2024-12、2025-06、2025-12、2026-06五考季，每季四/六级各三套。原资料位于 `D:/Agents/workspaces/documents/projects/cet-papers/`，本任务仅只读查看，未写入该目录。
- 主要镜像网站为 [懒笔记英语考试](https://english-exam.lazynote.cn/)，并非教育考试院发布的原卷。部分语料含自动补空、译注或范文；不能一律标成真题原句。
- `_audit/exam-local-source-checks.json` 给出每份镜像PDF的SHA-256、页数及候选语料的文本匹配；8972条可在镜像合并文本中找到规范化匹配，仍有2768条不能按该方法直接匹配。规范化匹配会忽略标点和空白，并不证明完全逐字相同。
- `_audit/exam-word-candidates.jsonl` 保留逐词、逐级别的候选命中索引；不复制原句作为正式例句。屈折匹配只是词形检索，未证明某个义项匹配。
- 未取得这些真题原句的公开转载授权证据，也未完成镜像到实际原卷的全量真实性核验。因此本版正式例句全部使用原创教学句，真题原句使用数与核实覆盖率均为0。没有将镜像可下载误当成可公开转载。

## 参考词典

- [kajweb/dict](https://github.com/kajweb/dict)：README说明其数据从背单词应用抓取，不能据“仓库公开”推定上游内容有转载授权。原始16个ZIP保留在 `_scripts/ref_dicts/`；均经ZIP CRC及逐行JSON解析检查。
- [KyleBing/english-vocabulary](https://github.com/KyleBing/english-vocabulary)：仓库当前声明BSD-3-Clause，README同时说明其上游来自上述词典的派生链。已保存README与LICENSE快照；仓库许可证不在本报告中被解释为对所有上游出版内容权利的独立证明。
- `_scripts/merged_lex_db.json` 的 kaj 子库13398词头、kyle 子库12594词头，词头并集16375。两个子库直接相加并非独立词数。
- 合并释义、短语及相关词仅作为编辑参考；不将合并库或其例句未经核实直接导出为完成词库。没有继承其零散助记法及可能错配的全部同根词。

## 本次原创编辑内容

- 可追溯编辑批：`_scripts/authored_*_batch.tsv`。每个批次记录实际词头、词性、编辑释义、原创英文例句、中文翻译、搭配和用法备注。
- `_scripts/editorial_overrides.json` 是源行级覆盖，解决同名不同义；它不是对原始JSON的修改。
- Markdown逐条标为 `[原创教学例句]`。同形词角标的具体义项归属是编辑判读，大纲并未提供对应释义；优先参考同列派生词，不能按普通词典的义项顺序直接套编号。
- `_audit/quality-checks.json` 检查原创句与继承真题候选、原始参考词典例句有无整句规范化相同。这种比对仅排除已知材料的整句重合，不能证明全球语料唯一性。
- 成品不宣称含已获授权真题例句。网站、Git、Claude Worktree与生产数据库均不属于本次写入范围。
