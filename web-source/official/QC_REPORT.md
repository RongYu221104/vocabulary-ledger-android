# 质量检查报告

**状态：全量内容已构建，限定范围的质量检查通过；交由 Codex 整合评审，未部署。**

| 级别 | 继承目标记录 | 已写 Markdown | 已写字段非空率 | 全表已编写率 | 已核实真题例句 | 原创例句 |
|---|---:|---:|---:|---:|---:|---:|
| CET4 | 4149 | 4149 | 100% | 100.0% | 0 | 4149 |
| CET6 | 5418 | 5418 | 100% | 100.0% | 0 | 5418 |

字段非空率仅针对已写出的子集，不能解读为全表完成率。
CET6 包含 CET4 基础词条，跨两套重复的原创例句不能相加当作独立创作数。
独立已编写标签：5411；剩余继承记录：0。

## 已通过的机械检查
- TSV required fields
- headword used in example (basic inflection)
- Markdown round trip and exact authored text
- stable IDs and level boundaries
- no unverified exam attribution
- complete authored subset represented in both levels

## 尚未通过的验收
- No human full-corpus double review
- No true-exam authenticity/rights acceptance; output uses original teaching examples
- 5418/4149 follow documented inherited expansion; source physical rows and unique labels are reported separately
- Independent semantic review scope is documented in _audit/review-*.md

恢复审计详见 `_audit/recovery-audit.json`；全部机器指标详见 `_build/qc.json`。
