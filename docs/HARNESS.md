# Assistant harness assessment

Assessment of the implementation as of 2026-10-01. The harness is the code around the model: conversation state, routing, tool execution, budgets, recovery and verification. Model reasoning quality is a separate concern.

Imagine currently provides a useful bounded local assistant. It does **not** yet have enough durability, execution isolation or outcome evidence to call the harness world class. Passing integration tests proves specific behavior, not autonomous task quality.

| Area | Implemented | Remaining work |
|---|---|---|
| Conversation experience | Chat-first UI, browser-local conversations/drafts, safe Markdown rendering, local response streaming, Stop, visible response activity | Cross-browser/server conversation storage, transcript export/import, branching |
| Run lifecycle | Serialized jobs, per-call timeouts, cancellation on disconnect, pending-approval cleanup | Durable run IDs, checkpoints, crash/restart recovery, resumable jobs, overall wall-time budget |
| Tool boundary | Execution checks against the tools actually offered; required argument/type checks; project root containment; approval before computer actions/sends | Central tool registry with fuller schemas, filesystem/process isolation, structured result contracts |
| Workers | Sequential specialist conversations on the same model; bounded turns; execution prevents workers from using parent write permissions | Task graph, shared overall worker budget, independent evaluation of worker usefulness |
| Context and memory | Local explicit fact storage, 8K working context, most recent 12 messages | Token-aware packing, context compaction, retrieval, provenance and long-task tests |
| Model selection | Local/Smart/Frontier; transparent heuristic; three OpenAI tiers | Routing evaluated on representative tasks, more providers, model-specific capability negotiation |
| Token controls | Local response ceiling; cloud input counting, response cap, conservative in-memory reservation | Persistent accounting, dollar budgets, per-project limits and durable usage records |
| Coding execution | Read-only project inspection | Isolated workspace, edit/apply tools, sandboxed shell, test execution and change review |
| Computer use | Screenshot, app open, click, typing and keypress through macOS | Structured UI observation, action verification, robust recovery; real permission/device evaluations |
| Observability | Browser-local route/status/tool-name records | Authoritative server traces, latency/error metrics, replay with sensitive-data handling |
| Evaluation | Unit and integration tests for routing, budgets, streams, permission gates, workers and cancellation | Repeatable reasoning/coding/writing tasks, scoring, regression baselines, measured 8 GB and 16 GB runs |

## Changes in this iteration

The dispatcher now rejects a forged call to a disabled tool even when the model invents it. The same enforcement blocks worker write actions despite the parent's permissions. Local streaming follows [Ollama's accumulation guidance](https://docs.ollama.com/capabilities/streaming) to preserve tool calls and model state before continuing a tool loop, while showing only answer text. Disconnect/Stop propagates cancellation to model and web requests and clears waiting approvals. Completed external actions cannot be reversed by cancellation.

Browser conversations and activity are saved UI records, **not** replayable agent checkpoints. Stop prevents future work after cancellation is observed; it does not guarantee that an action already started can be interrupted. Cloud requests keep their token reservation when their completion is uncertain.

## Next milestones for a stronger harness

1. Introduce durable runs and a centralized tool registry: run IDs, structured events, state transitions, cancellation and overall budgets shared with workers.
2. Add token-aware context management and repeatable task evaluations before claiming reasoning or routing quality improvements.
3. Add coding execution in isolated workspaces, with reliable action/result verification and recovery.
4. Measure completion rate, latency, memory use and failure recovery on actual 8 GB and 16 GB devices. Exercise provider accounts, macOS permissions and WhatsApp pairing with real integrations.

The current frontend is a conversation interface. Matching a familiar chat layout does not establish parity with another product's agent runtime.
