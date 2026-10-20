# 官方大纲词库最终数据验收与交接报告

**接收方：Codex**  
**报告编写：Gemini**  
**日期：2026-10-19**  
**工作目录：`D:\Agents\workspaces\tools\vocabulary-ledger\official-ledger-data`**  
**最终系统状态：`BUILT_AND_SCOPED_QC_PASSED`**（全量内容已构建，限定范围的质量检查与专项闭环已全部通过）

---

## 1. 核心验收结论与指标对账

本轮验收基于 Codex 完成的 69 个原创 TSV 编辑批次、52 卷 Markdown 数据以及专项复核报告。Gemini 严格在 `official-ledger-data` 目录内执行了最小恢复核对、QRS 四项修订独立回读闭环、同形词快照哈希复核、全量 9567 条最终 Markdown 英文例句（含 tire 源行覆盖）的整句防碰撞检查，并创建了正式的数据验收凭证 `_audit/acceptance.json`。

全库未编写项为 0（`_build/pending/A.json`–`Z.json` 全部为空数组），无缺失字段，无非法真题标称，无语料/词典例句碰撞。**本目录全部数据已满足交由 Codex 进行最终整合部署的放行标准；Gemini 未执行任何部署操作。**

### 核心指标对比表

| 指标 | CET4 | CET6（含四级基础） | 口径说明 |
|---|---:|---:|---|
| 已落盘 Markdown 卷数 | 26 卷 | 26 卷 | 覆盖 A.md–Z.md，共 52 卷 |
| 实际词条记录数 | 4,149 条 | 5,418 条 | 基于大纲斜杠规范化拆分的继承记录，非官网单独公布数 |
| 不同词头标签数 | 4,144 个 | 5,411 个 | 存在 7 组大纲原始分列同名行，以唯一 `entry-id` 严格区分 |
| 固定八字段非空覆盖率 | 100.0% | 100.0% | 词性、中文释义、例句出处、英文例句、中文翻译、派生词、常见搭配、必要备注 |
| 原创教学例句记录数 | 4,149 条 | 5,418 条 | 全部逐条明标 `[原创教学例句] Codex 编写；未作为真题原句使用` |
| 最终 Markdown 独立英文句子数 | 4,142 句 | 5,409 句 | 3组不同词头复用合格例句，另有 tire 专用轮胎例句覆盖 |
| 已核实且使用的真题原句数 | 0 条 | 0 条 | 未取得公开转载授权及原卷真实性认证，真实真题数严格置 0 |
| 官方大纲源行覆盖率 | 100.0% (4,114/4,114) | 100.0% (5,377/5,377) | 独立几何行列提取的 5377 原始行全部在成品中有对应记录 |
| 未编写继承记录数 | 0 | 0 | 待编写清单已全部清空，无需重生成词条 |

> **计数口径特别说明**：
> 1. CET6 包含 CET4 基础内容，两级例句记录数不能相加当作独立创作数。
> 2. 基础 authored TSV 包含 5411 个独立词头标签，其中 3 对词头因教学语境相容共用同一原创句（`diagram`/`show`、`dust`/`layer`、`name`/`write`），基础独立句为 5408 句；叠加 `_scripts/editorial_overrides.json` 中针对 `tire@tyre/tire` 源行的专用轮胎例句覆盖后，全库最终渲染的独立英文句子数精确为 5,409 句（CET4 为 4,142 句）。不弄虚作假虚报 5418 或 5411 句。

---

## 2. QRS 四项修订的独立回读闭环

针对 `HANDOFF.md` 与 `_audit/review-qrs.md` 中指出的 4 项待闭环问题，Gemini 逐条回读了当前 TSV 及最终 Markdown 输出中的全部 7 列字段，核实判定如下：

| 词头 | 所在文件 | 修订前问题 | 当前落盘实际内容 | Gemini 独立回读判定 | 状态 |
|---|---|---|---|---|---|
| **quote** | `authored_qrs01_batch.tsv` | 原例句中译“注明原始出处”偏向 cite，未体现 quote 引用原话核心义 | 例句：*Please quote the author's exact words when discussing this passage.*<br>中译：*讨论这段文字时，请引用作者的原话。* | 英文例句明确使用 exact words，中文准确对译“引用作者的原话”，教学语义精准、自然 | **闭环通过** |
| **salary** | `authored_qrs04_batch.tsv` | 备注中“区别于时薪 wages”将 wages 狭隘等同于时薪 | 备注：*通常按年计、定期发放的固定薪酬；wages 常按小时、日或周等计酬，不能一概等同于时薪。* | 准确补充了 wage 可按时、日、周计酬的说明，消除了对 wage 的片面限定 | **闭环通过** |
| **sister** | `authored_qrs05_batch.tsv` | “我的姐妹”中译不自然且单数语境易产生复数误解 | 译文：*我姐姐（或妹妹）帮助我练习口试。*<br>备注：*英语词本身不区分姐姐或妹妹，需上下文补充。* | 中文对译符合现代汉语自然表达，消除了复数误导，并保留了长幼不区分的说明 | **闭环通过** |
| **strait** | `authored_qrs07_batch.tsv` | 词性标 `n.; adj.` 且将复数名词 straits 的困境义混同为形容词 | 词性：`n.`<br>释义：*海峡；困境（常用复数）*<br>例句：*Ships pass through the narrow strait on their way to the port.*<br>搭配：*a narrow strait；in dire straits*<br>备注：*困境义多用复数 straits。* | 词性纠正为纯名词，困境义明确标注为常用复数用法，与海峡单数例句及搭配完全协调 | **闭环通过** |

**复核报告更新**：`_audit/review-qrs.md` 已追加正式的《修订回读闭环》小节及修订后 TSV 文件的最新 SHA-256 哈希，审查状态已置为“全量读审完成，0个未闭合问题”。

---

## 3. 同形词专项复核与快照验证

对 `_audit/review-homographs.md` 涉及的大纲 154 原始行（展开后共 155 个编写词头）进行了程序化快照校验与重点条目复核：
1. **快照哈希 100% 吻合**：以七列字典数组对 155 个词头按源清单顺序序列化计算 SHA-256，结果为 `eb2e64855ddb25cd42ec5fcd12075981d1035dcaaffa8cc992204346e84674f7`，与报告中记录的读审快照哈希完全一致。
2. **重点条目审查**：
   - `court１` 与 `court２`：明确作为项目内“名词/动词”编辑分组，非官方编号定义；`court１` 收录法庭/球场/宫廷名词义，`court２` 收录争取/求爱动词义，例句与搭配互不混淆。
   - `stroke１` 与 `stroke２`：`stroke１` 释义中已明确包含“划水动作；泳姿；击打；中风”，与例句 *improved her stroke* 及泳姿中译完全相融；`stroke２` 明确为轻抚动词义。
   - `hack１/２`、`implement１/２`、`check１/２` 等前期问题均保持正常闭环状态。

---

## 4. 全库 9,567 条渲染例句整句碰撞检查（含 tire 覆盖）

为彻底杜绝仅检查基础 TSV 导致漏网的问题，Gemini 对 `_scripts/quality_checks.py` 进行了功能扩展，将整句碰撞检查全面覆盖到最终 Markdown 渲染产物：
1. **扩展检查范围**：
   - 解析 CET4 全部 26 卷（4,149 条记录）和 CET6 全部 26 卷（5,418 条记录），共计 **9,567 条实际呈现给学习者的 Markdown 渲染记录**。
   - 纳入 `_scripts/editorial_overrides.json` 中定义的所有源行覆盖，特别是 `tire@tyre/tire`（*A loose nail had pierced the rear tire of the bicycle.* 轮胎例句）。
2. **比对基准数据库**：
   - 继承真题候选语料 `_scripts/exam_corpus.json`（全量 11,740 条句子，规范化 tokens 集合）。
   - 原始参考词典 `_scripts/ref_dicts/*.zip`（全量 16 个 ZIP 压缩包内所有 JSON 文件中的例句集合）。
3. **碰撞检查结果**：
   - `rendered_examples_identical_to_corpus_or_dictionary`: `[]`（**0 处碰撞**）
   - `editorial_overrides_collisions`: `[]`（**0 处碰撞**）
   - 全库原创句子未发现任何与真题语料或参考词典整句相同的情况。

---

## 5. 验收文件与系统流水线哈希

Gemini 依据真实检验结果，在 `_audit/acceptance.json` 中固化了验收凭证，使 `build_batches.py`、`verify_wordlists.py` 及 `quality_checks.py` 的校验链路完全闭环。

### 关键组件当前 SHA-256

- **流水线工具脚本与核心数据集 (`pipeline_hashes`)**：
  - `build_batches.py`: `68e02d19f50159d55fc5e30f878b089fb3829a90ef9e41a5cc44078f4735b80f`
  - `audit_recovery.py`: `2964f9a0d22e2a10ea743406cd7f5a348bc8fbb7789b675e789a844e3ab1966a`
  - `quality_checks.py`: `414b29812e4a955b1548f89ca3cb1d34ab1b698a317606ddb8e7d83a8573b93e`（扩展渲染层例句碰撞检查）
  - `editorial_overrides.json`: `359d793894f6b3d4818bd2dd838c7dedf990b9e889eb06439df0d4fef82b0cce`
  - `syllabus_expanded_5418.json`: `51445778be70dd2c88b7c7c250f9d7e96928c030d2c92ecee4d3d63c9471823a`
  - `cet4_syllabus_4149.json`: `7654d1db406b32c7ff26311eecf925b1edc9baa89073641211869840454e7f8c`
  - `cet6_new_syllabus_1269.json`: `9826bd9bef19684ba50d898eadff9c8f00214036e0c1ce1021b46c5f14c3b419`

- **专项复核报告 (`review_hashes`)**：
  - `review-a-gaps.md`: `142f26a61d5b1e3ebee8143e6a570cf57655bc2735b13ef87c872b309e6f4b68`
  - `review-bc-def.md`: `1ef0877043bc17b1842c6df3cb7f286f39966130a237b9acb66ca0681b1a8ed6`
  - `review-bc.md`: `02548805caae614fc7a632383540e04115dc24876c5e787981930d802a64234a`
  - `review-c01.md`: `d82d1baafb319addf5d7535d0ff269cb1916c6736e72b720438ca246b6a7d838`
  - `review-ghijkl.md`: `e62358f8390fc7f34decb1d467610b2e367f0127ff3d248af25e0a8891bff3da`
  - `review-homographs.md`: `55f2a2acf944c0ae1dbf331122e4fe54e538e7716580fdeb81a6d378255ddc05`
  - `review-mnop.md`: `eedd4406f0eebe02b4fa8d88f40cf13f1bc5c0d997dcbc5dc6edff2e532980f6`
  - `review-qrs.md`: `d920e8a95071daf6c0581d9a2d20d7a2daa9e61e406a6c044f7ea1b0d7ade1e4`（追加独立回读闭环记录）
  - `review-tuvwxyz.md`: `18ef031670d510dbe7e4901dd42d6042e17e5ad3bbf4a9ce091cf45c80f6d805`

---

## 6. 质量限制与交付边界声明

为确保交付严肃性与学术/版权合规性，明确记录以下客观限制，不作夸大宣称：
1. **无人工教师全库双审**：复核由独立代理完成逐词逐句语义审阅，不等于外部权威出版社认证或人类教师全量背对背双校。
2. **零真题原句使用**：网络镜像真题未获得教育部教育考试院或版权方的公开转载授权，语料中存在大量自动补空与无中译条目。词库明确全部使用原创教学例句，真题原句使用数如实申报为 0。
3. **印刷统计与单元统计差异**：原大纲 PDF 物理标注 2,551 个派生词，经独立按表格单元几何提取并修复 `age` 与 `marvel` 碎片后为 2,519 个单元；口径差已留存证据，不作凑数修改。
4. **同形词角标性质**：角标为本项目编辑判读与分类，非官方大纲定义的义项编号。
5. **部署执行权**：Gemini 严格遵守交接约束，未对网站前端、Git 仓库、Claude Worktree 或生产数据库执行任何写操作；所有成品移交 Codex 统一整合部署。

---

## 7. 交付文件清单

本目录下已同步更新 `FILE_MANIFEST.json`（全量 259 个文件，排除自身）。核心成品结构如下：

- `CET4/A.md`–`CET4/Z.md`：四级词汇大全共 26 卷（4,149 词条记录）
- `CET6/A.md`–`CET6/Z.md`：六级词汇大全共 26 卷（5,418 词条记录）
- `_scripts/authored_*_batch.tsv`：共 69 个原创编写批次 TSV（5,411 个独立标签）
- `_scripts/editorial_overrides.json`：源行级覆盖定义（tire 轮胎专用例句）
- `_build/manifest.json`：全量 5,418 记录的大纲对应元数据
- `_build/authored-records.json`：基础编辑快照
- `_build/qc.json`：全量机械与质检指标
- `_audit/acceptance.json`：数据验收凭证
- `_audit/review-*.md`：9 份专项复核报告（全部闭环通过）
- `_audit/quality-checks.json`：例句碰撞与源行覆盖质检报告
- `_audit/handoff-state.json`：交接状态记录
- `QC_REPORT.md`：当前质量报告
- `PROGRESS.md`：构建进度说明
- `FILE_MANIFEST.json`：全量文件清单与 SHA-256 指纹
