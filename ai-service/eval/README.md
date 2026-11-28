# 企业知识库 RAG 评测工具（Bank RAG Benchmark）

本目录提供针对 [Bank RAG Benchmark](https://github.com/sjtu-suzhou-ai-zhiwei-tech/bank-rag-benchmark)（100 份中文企业 PDF + 450 道评测题）的双模式自动化批量导入、评测与清理脚本 [bank_rag_eval.py](bank_rag_eval.py)。

## 评测指标
1. **召回率**：拆分为粗排（双路合并 Top 60）、精排（`rank_candidates` Top 4）与最终实引（`prune_uncited_sources` 后）三层文档召回率、Hit Rate、多文档全命中率与 MRR。
2. **准确率**：检索来源精确率、LLM-as-a-Judge 综合/严格准确率、预期行为匹配率（直接回答/要求补充/拒答）、回答忠实度（无幻觉率）。
3. **错误引用率**：结构性检测（越界引用、未引用残留来源、漏标引用）+ 逐句引用支持度核验（引用级 & 问答级错误引用率）。
4. **延迟分布**：Query Embedding、向量检索、全文检索、重排过滤、纯检索总延迟、LLM 生成与端到端 P50/P95/P99。

## 用法

### 1. `local` 模式（本机直接复用 `ai-service` 生产代码，无需 PG/Docker）
```powershell
ai-service\.venv\Scripts\python.exe ai-service\eval\bank_rag_eval.py `
  --mode local `
  --dataset-dir <bank-rag-benchmark目录> `
  --output-dir <报告输出目录> `
  --per-type 12
```
- 首次运行会解析并向量化全部 100 份 PDF 并写入 `local_index_cache.json`，后续调参重跑直接复用缓存（0 Embedding 费用）。
- `--per-type 0` 表示跑全量 450 题。

### 2. `api` 模式（连接本地 / staging / 线上后端全链路）
```powershell
# 1) 批量导入 100 份 PDF（默认 PRIVATE 私有，不污染团队资料，支持断点续传）
ai-service\.venv\Scripts\python.exe ai-service\eval\bank_rag_eval.py `
  --mode api --action import `
  --base-url https://your-staging-host `
  --email tester@example.com --password '***' `
  --dataset-dir <bank-rag-benchmark目录>

# 2) 运行端到端问答评测
ai-service\.venv\Scripts\python.exe ai-service\eval\bank_rag_eval.py `
  --mode api --action eval `
  --base-url https://your-staging-host `
  --email tester@example.com --password '***' `
  --dataset-dir <bank-rag-benchmark目录> `
  --per-type 12

# 3) 测完一键清理导入的测试 PDF
ai-service\.venv\Scripts\python.exe ai-service\eval\bank_rag_eval.py `
  --mode api --action cleanup `
  --base-url https://your-staging-host `
  --email tester@example.com --password '***' `
  --dataset-dir <bank-rag-benchmark目录>
```
