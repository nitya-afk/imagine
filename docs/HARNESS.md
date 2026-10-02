# Assistant harness assessment

Assessment of the implementation as of 2026-10-02. The harness is the code around the model: conversation state, routing, tool execution, budgets, recovery and verification. Model reasoning quality is a separate concern.

Imagine currently provides a useful bounded local assistant. It does **not** yet have enough durability, execution isolation or outcome evidence to call the harness world class. Passing integration tests proves specific behavior, not autonomous task quality.

| Area | Implemented | Remaining work |
|---|---|---|
| Conversation experience | Chat-first UI, browser-local conversations/drafts, safe Markdown rendering, local response streaming, Stop, visible response activity | Cross-browser/server conversation storage, transcript export/import, branching |
| Run lifecycle | Durable local run IDs/states/events/final answers, bounded diagnostic checkpoints, dead-owner interruption marking, answer recovery; serialized jobs, disconnect cancellation, approval cleanup, 10-minute overall timeout | Safe resumable execution checkpoints, restart continuation, transaction/idempotency handling for external effects |
| Tool boundary | Execution checks against the tools actually offered; required argument/type checks; project root containment; approval before computer actions/sends | Central tool registry with fuller schemas, filesystem/process isolation, structured result contracts |
| Workers | Sequential specialist conversations; bounded turns; parent/worker shared model/tool/web budgets; dispatcher blocks worker write permissions | Task graph, independent evaluation of worker usefulness |
| Context and memory | Local explicit facts, 8K working context, cautious byte-estimated packing with answer/schema reserve, complete old-exchange omission and disclosed tool excerpt shortening | Exact model tokenizers, semantic compaction/retrieval, evaluated long-task memory quality |
| Public research | Automatic public/current-question lookup, uncertainty fallback, keyless broad providers plus optional Brave API, alternative-page attempts, source provenance, citation/identity guard, redirects and readable feeds/PDFs | Reliable browser-rendered/authenticated retrieval, richer extraction/ranking, full factual verification, larger research evaluations |
| Model selection | Local/Smart/Frontier; transparent heuristic; three OpenAI tiers | Routing evaluated on representative tasks, more providers, model-specific capability negotiation |
| Token controls | Local response ceiling; cloud input counting, response cap, conservative in-memory reservation | Persistent accounting, dollar budgets, per-project limits and durable usage records |
| Coding execution | Read-only project inspection | Isolated workspace, edit/apply tools, sandboxed shell, test execution and change review |
| Computer use | Screenshot, app open, click, typing and keypress through macOS | Structured UI observation, action verification, robust recovery; real permission/device evaluations |
| Observability | Owner-only atomic run journal, source/provider failure records, bounded diagnostic context excerpts; browser-local transcripts | Aggregate latency/error metrics, encrypted retention, replay with sensitive-data handling |
| Evaluation | Unit and integration tests for routing, budgets, streams, permission gates, workers and cancellation | Repeatable reasoning/coding/writing tasks, scoring, regression baselines, measured 8 GB and 16 GB runs |

## Changes in this iteration

Broad internet lookup no longer depends on Wikipedia coverage or on a small model deciding to call a tool. Public/current questions retrieve before generation, uncertain public answers get one retrieval retry, and unavailable pages lead to alternative sources. Search snippets and actual page reads are distinguished. The citation/identity guard checks specific failure patterns, not every factual claim. Public HTML fallback is best effort and can break or be blocked; no CAPTCHA or paywall bypass is implemented.

Runs persist prompts, state, provenance, finished answers and bounded diagnostic excerpts locally. These files are not encrypted. System memory, screenshots, internal thinking and raw project/WhatsApp tool results are omitted, but prompts/final answers may contain private information. There is no automatic eviction; deleting a conversation removes its run records. Storage failure is surfaced, not silently ignored.

Installed chat-model discovery now consults Ollama's model information when the model list omits capabilities, so a real installed 9B model can appear in the dropdown. Memory headroom still limits the offered models.

The dispatcher rejects invented calls to disabled tools, and blocks worker writes despite parent permissions. Local streaming follows [Ollama's accumulation guidance](https://docs.ollama.com/capabilities/streaming). Shared local limits are 12 model calls, 24 tools, 8 searches and 8 page reads per run, with a 10-minute overall timeout. Disconnect/Stop cancels model/web requests and clears waiting approvals. Completed external actions cannot be reversed by cancellation.

Browser conversations and bounded server diagnostic checkpoints are **not** replayable execution state. Finished answers can be recovered; incomplete runs are not automatically continued. Stop prevents future work after cancellation is observed, not necessarily an action already started. Cloud requests keep their token reservation when completion is uncertain. Local context estimates are not exact token counts; omitted old exchanges are disclosed, not semantically summarized.

## Next milestones for a stronger harness

1. Extend durable inspection into safe resumable runs and centralize tool contracts, including pending-side-effect outcomes and idempotency.
2. Add exact-token context management, semantic compaction and repeatable task evaluations before claiming reasoning or routing quality improvements.
3. Add coding execution in isolated workspaces, with reliable action/result verification and recovery.
4. Measure completion rate, latency, memory use and failure recovery on actual 8 GB and 16 GB devices. Exercise provider accounts, macOS permissions and WhatsApp pairing with real integrations.

The current frontend is a conversation interface. Matching a familiar chat layout does not establish parity with another product's agent runtime.
