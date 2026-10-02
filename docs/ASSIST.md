# Assist: a local thinking room

Imagine's **Assist** tab adds a local language model to the image studio. It can help with reasoning, writing, coding and research. The model runs through Ollama on your Mac; optional tools give it carefully scoped access to the web, saved memory, this project's files, the screen and WhatsApp.

Imagine opens into **Chat**. The sidebar holds New conversation, saved conversations and search; **Create** and **Edit** open the image studio. Open the model/settings control beneath the composer to change models, routes, budgets or tools. **? What can I do** opens the capability guide. Local use needs no cloud language-model account.

Enter sends a message; Shift + Enter adds a line. Local answers stream as they are generated, and formatted responses can contain headings, lists, links and copyable code blocks. Conversations and drafts survive a reload in the same browser. **Stop** cancels the ongoing request and clears pending approvals; completed computer actions or WhatsApp sends are not rolled back. Expand a response's details to see its route, tool names and status messages.

Source cards distinguish **Search snippet** from **Page read**. Finished answers and run status are also recorded locally on this Mac. If a reload interrupted the connection, **Check saved response** retrieves a completed answer or explains whether the run was cancelled, failed or interrupted. **Run details** shows its ID and state. This is answer recovery, **not** automatic task continuation or action replay.

## Get started

Install [Ollama](https://ollama.com/download), then choose a model that fits your Mac:

```bash
ollama pull qwen3.5:4b     # recommended starting point for 8 GB Macs; ~3.4 GB on disk
ollama pull qwen3.5:9b     # stronger option for 16 GB or more; ~6.6 GB on disk
imagine ui
```

The app picks an installed 9B model by default when enough memory is available, otherwise the 4B model. It lists only chat models whose stored weights leave memory headroom. A model's [advertised context limit](https://ollama.com/library/qwen3.5/tags) is **not** its practical limit on an 8 GB Mac: Assist currently uses an 8K working context. The first response may include a model-loading delay.

Local context packing uses a cautious UTF-8 byte estimate, not the model's exact tokenizer. It reserves room for tool schemas and the answer, omits complete old exchanges first, and shortens large tool results only when necessary. Vision uses an estimated allowance for the latest screenshot, not its base64 transport length; stale screenshots are omitted. The browser sends up to 48 recent messages within a request-size limit. These omissions appear in response details; the saved transcript is unchanged. An oversized current message fails explicitly rather than being silently sliced. The model can forget omitted exchanges; there is no semantic long-term conversation summary yet.

An optional, community-tuned 4B model can be installed with `ollama pull huihui_ai/qwen3.5-abliterated:4b` and selected as **less-filtered**. It is not the default and is not guaranteed to reason better, produce better code, or comply with every request. No custom fine-tuning is included in Imagine.

## Choosing local or frontier intelligence

Assist starts in **Local only** mode. For optional frontier text chat, set `OPENAI_API_KEY` in the environment that starts `imagine ui`; the key is server-side and never appears in the browser page. You can then choose:

- **Smart**: a simple, inspectable heuristic keeps focused requests local and proposes OpenAI for longer coding, analysis or multi-step requests. The route is shown in the conversation. The heuristic does not make an extra model call.
- **Frontier**: use the selected tier—Fast/GPT-6 Luna, Balanced/GPT-6.1 Sol, or Best/GPT-6 Astra—or Auto choose. Model access depends on your account. See [official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model).

Each proposed cloud request needs your approval **before** any text is sent. By default, the current message goes to OpenAI, plus public retrieval evidence when **Internet lookup** is enabled and the question triggers lookup. You can opt in to include up to 12 previous chat turns; these may contain private information. Cloud mode is text-only: it does not automatically attach saved memories, project files, screenshots, WhatsApp messages or private local tool results. Web lookup works in both routes; other local tool switches do not run in Frontier mode. A second cloud request to improve an uncertain or uncited answer needs a separate approval and consumes additional capped tokens.

The two token fields in Assist have different jobs. **Max cloud input tokens** is checked with OpenAI's [token-counting endpoint](https://developers.openai.com/api/docs/guides/token-counting) before a response request. **Max answer tokens** is a provider-enforced ceiling for each response, including hidden reasoning tokens, so a very low cap can produce no visible answer. A server-side session budget defaults to 20,000 total tokens, reserves counted input plus the maximum possible output, then reconciles reported usage. `IMAGINE_FRONTIER_SESSION_TOKENS` changes that budget at launch. It resets when the UI server restarts and is **not** an account-level spending cap; configure billing limits with your provider separately.

## What you can ask

| Need | Example | What to enable |
|---|---|---|
| Reasoning and writing | “Compare these two approaches and draft a concise recommendation.” | Nothing extra |
| Coding help | “Explain this TypeScript error and propose a patch.” | Project files if it needs to inspect this folder |
| Recent facts / public people | “Find the current release notes” or “Who is Nitya Prakhar?” | Internet lookup (on by default); no search key required |
| Persistent preferences | “Remember that I prefer concise answers.” | Nothing extra; you must explicitly ask it to remember |
| A second pass | “Use a specialist worker to critique your answer.” | Specialist workers |
| On-screen help | “Read my screen and explain what this dialog means.” | Computer control, then approve the screen read |
| WhatsApp | “Show my recent messages” or “Send this text to this number.” | Connect WhatsApp, enable access, approve each send |

The model may make mistakes. Check generated code, current facts, recipient numbers and on-screen actions before relying on them.

## Tool switches and approvals

- **Deep reasoning** allows a longer thinking pass. It is usually slower; the model can still be wrong.
- **Internet lookup** uses Brave's official API when `BRAVE_SEARCH_API_KEY` is set, then best-effort public Brave search and [DuckDuckGo HTML](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript). Wikipedia is only a final, explicitly limited fallback. Public-person/current-information questions are searched before generation; uncertain answers that skipped lookup get one public-source retry. Empty results may trigger a shorter entity query. Providers can block requests or change page layouts; a search key improves reliability but is optional. Errors and provider attempts appear in response details. Turn it off to prevent web requests.
- **Specialist workers** are bounded extra conversations with the same local model. They run sequentially to conserve unified memory; they are not parallel processes or independent computers.
- **Project files** provides read-only access beneath the directory from which you started `imagine ui`. It is off by default and does not grant file editing, shell execution, or access outside that directory.
- **Computer control** is off by default. It supports a screenshot, opening an app, a screen-coordinate click, typing text, or a keypress. **Every action requires approval** in Imagine. macOS may separately request Accessibility or Screen Recording permission. The assistant has no arbitrary shell or AppleScript tool.
- **WhatsApp access** is off by default. Click **Connect WhatsApp** and scan the QR in **WhatsApp → Linked devices**. The [Baileys](https://github.com/WhiskeySockets/docs/blob/main/quickstart.mdx) connection is unofficial. Assist can read recently received text after you enable access and can send one text to an individual number only after approval. It cannot automatically reply, broadcast to groups, or send bulk messages.

The approval prompt shows the specific proposed computer action or the WhatsApp recipient and message. Denying it prevents that action. Do not approve a send or a screen action whose effect you do not understand.

## Reading the public internet

The assistant can read arbitrary **public HTTPS** sites, not a fixed website allowlist. It follows up to four redirects, checks and pins public DNS addresses on every hop, and returns readable text plus links it can follow. Supported formats include HTML, plain text, JSON, XML/RSS/Atom, and text PDFs under 2 MB. PDF extraction requires `pdftotext` from Poppler (`brew install poppler`); scanned PDFs need OCR, which is not included. Downloads, page excerpts, search queries and provider timeouts are bounded to avoid runaway tasks.

When initial pages fail, it tries two alternative result pages. For identity questions, discovered self-authored professional profiles take priority over ambiguous contact/company directories. Search snippets are useful leads but are not proof that a page was read. A citation/identity guard asks for one correction if an answer lacks a selected retrieved source citation, cites an unretrieved URL or makes specific unsupported identity claims. If correction still fails, it shows actual source links instead. This guard is **not** a comprehensive factual verifier: even cited answers can be wrong.

“Anywhere” does not mean access to login-only content, bypassing paywalls/CAPTCHAs, private networks, or arbitrary videos and binary files. JavaScript-only pages may have no readable text. Automatic lookup uses only the current short public question, not saved memory/history/files, and avoids obviously private or secret-bearing prompts. Model-initiated queries are also screened for common secret patterns; this is not a complete data-loss-prevention system. Disable Internet lookup when handling sensitive material.

## Where data goes

| Data | Location or destination |
|---|---|
| Model inference | Your local Ollama server, normally `127.0.0.1:11434` |
| Saved facts | `~/.imagine/assistant-memory.json` on this Mac; view/remove them in Assist |
| WhatsApp pairing credentials | `~/.imagine/whatsapp-auth/` on this Mac; connecting also exchanges data with WhatsApp |
| Recent received WhatsApp text | At most the latest 30 messages in the running app's memory |
| Chat conversation and drafts | This browser's local storage under `imagine-conversations-v1`; survive reloads, removable from the sidebar or by clearing browser data |
| Run journal | `~/.imagine/assistant-runs/`: prompt, state, source/activity records (including approval descriptions), final answer and bounded diagnostic context excerpts; owner-only file permissions, **not encrypted**. No screenshots/internal thinking; raw project/WhatsApp tool outputs omitted. Prompts, approval descriptions and final answers may still contain private information. Deleting a sidebar conversation removes associated run records; clearing browser storage alone does **not** remove them |
| Web lookup | Brave API/public search, DuckDuckGo HTML or limited Wikipedia; reading a URL contacts that website |
| Approved frontier text chat | Current message and applicable public evidence go to OpenAI; up to 12 previous chat turns only if you opt in; `store: false` is requested |
| Project files and screenshots | Given to the local model only when the relevant tool is enabled and called |

Image generation itself remains local. Optional internet lookup and WhatsApp are **not offline**. The browser UI listens on `127.0.0.1:11437`, uses a session token for its API, and queues assistant and image jobs so they do not fight over the GPU. On small Macs it unloads the chat model after an answer; before any image job it asks Ollama to release chat models used by the UI.

Assistant runs have a 10-minute overall time budget (including UI queue/approvals), at most 12 local model calls and 24 tool calls shared with workers, plus 8 search queries and 8 page reads. Cached results do not repeat downloads. After a crash, unfinished dead-owner records become **interrupted** when the server starts. Diagnostic checkpoints do not contain enough state for safe replay, and no actions are automatically resumed.

## Scope and limits

Assist is a helpful local model with bounded tools, plus optional frontier text chat—not an unattended agent or a guarantee of frontier-level reasoning. It cannot run arbitrary commands, modify project files, or silently control the Mac or send WhatsApp messages. You can use it for authorized security learning and testing, but model behavior and refusal rates depend on the selected weights; there is no guarantee of an entirely “unrestricted” model.

WhatsApp sending and macOS computer actions require your own account/permissions and should be tried after setup. The automated test suite covers permission gates and UI routes; it does not prove that your particular macOS permissions or WhatsApp pairing will work without a live check.
The frontier route is tested with mocked API responses, not your credentials or account. A provider error, account limit or model unavailability is reported in the chat; Imagine does not silently switch to another paid model.

For image models, photo editing, CLI, OpenAI-compatible API and MCP tools, return to the [main README](../README.md).

For the runtime's current engineering strengths and gaps, see [the harness assessment](HARNESS.md).
