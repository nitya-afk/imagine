# Imagine Assist: the complete user guide

Use this guide to get started, enable a capability, verify it really ran, or troubleshoot a result. It describes the current implementation—not a promise of autonomous or frontier-level behavior.

## Find your way

- [Your first five minutes](#your-first-five-minutes)
- [Get started and choose a model](#get-started)
- [Local or frontier intelligence](#choosing-local-or-frontier-intelligence)
- [Task examples](#what-you-can-ask)
- [Step-by-step walkthroughs](#step-by-step-walkthroughs)
- [Context and follow-up questions](#context-and-follow-up-questions)
- [Tool switches and approvals](#tool-switches-and-approvals)
- [Reading the public internet](#reading-the-public-internet)
- [Create and edit images](#create-and-edit-images)
- [Troubleshooting](#troubleshooting)
- [Capability checklist](#capability-checklist)
- [Data locations and privacy](#where-data-goes)
- [Scope and limits](#scope-and-limits)

## Your first five minutes

1. Start Ollama and install a chat model using the commands under **Get started**. Chat models and image models are different downloads.
2. Start `imagine ui`. The first screen is Chat; the app normally opens at `http://127.0.0.1:11437`.
3. Click the model/settings button beneath the message box. Choose **Local only** and an installed chat model. Leave optional tools off for your first writing or reasoning task.
4. Try: “Help me plan a small personal website. Ask three questions before suggesting a plan.” Enter sends; Shift + Enter inserts a line break.
5. Open **Response details** to see which route and tools actually ran. Text saying “I searched” or “I used a worker” is not evidence unless the corresponding activity is recorded.

The **? What can I do** button, or **Explore what’s possible** in a new chat, opens the ten-chapter in-app field guide. Its example buttons fill the composer but do not send. They ask before replacing an existing draft and do nothing while a job is running. Setting shortcuts open and focus the relevant control, without enabling it. **Full written guide** opens this bundled document locally as text; internet access is not required to read it.

Tools other than Internet lookup are off by default. Tool selections are not saved as lasting preferences: check them after a reload. The guide is available on demand; it is not an automatic first-visit walkthrough.

## The workspace

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

## Step-by-step walkthroughs

### Reason, write or review code

1. Choose **Local only** and give the model your goal, relevant material, constraints and desired output.
2. For a longer analysis, optionally enable **Deep reasoning**. It can be slower and does not guarantee correctness.
3. For code already in this project, enable **Project files**. The setting shows the permitted folder: the directory from which Imagine was launched.
4. Ask: “Read the relevant files in this project, explain how the request handler works, and propose a patch. Do not claim you applied it.”
5. Inspect `find_project_files` / `read_project_file` in response details. Review the proposed code before applying it yourself.

Project access is read-only. Imagine Assist does not have a file editor, terminal executor or sandboxed test runner. A proposed patch or test plan is not a completed change or an executed test. Start Imagine from a different project folder if you want that folder to be the read-only scope; enabling the switch does not grant arbitrary filesystem access.

### Research a public question

1. Keep **Internet lookup** on. For people, include a full name plus a company, role or location when you have one.
2. Ask: “Search the web for the latest stable TypeScript release. Cite the official release announcement and state the release date.” Alternatively, give a direct public HTTPS URL and ask for a summary.
3. Inspect the source cards and response details. Verify the query, provider, retrieval errors and whether the source is a **Search snippet** or **Page read**.
4. Open the relevant source to check important claims. If a page is inaccessible, provide another public source or an excerpt you are authorized to share.

Automatic preflight lookup uses the current question, not the full conversation. The model can also call search tools, but follow-up interpretation is not reliable. Current identity-source selection favors a narrow set of professional-profile sites and may exclude useful personal websites when those profiles appear. A direct personal-site URL is a useful workaround; this is an implementation gap, not proof that a person has no public information.

### Save and inspect a preference

1. Ask: “Remember that I prefer concise answers with a short example.” Explicitly requesting a save is required.
2. Look for a `remember` tool call, then open **Saved memory** in settings and verify the fact is listed.
3. Start a new local chat and ask for an answer where that preference applies. Stored facts are included in local context, though model adherence is not guaranteed.
4. Remove a fact through **Saved memory** when you no longer want it used.

Saved facts and chat history are separate. A conversation is not automatically mined into permanent memory. Never store credentials or highly sensitive information as a preference; secret screening is not comprehensive protection.

### Use a specialist worker

1. Select **Local only** and enable **Specialist workers**.
2. Give a specific, self-contained task: “Use a reasoning specialist worker to critique this plan: launch a personal website in one weekend. Identify three risks, then give me a revised plan.”
3. Look for `delegate` and a **Worker:** status in response details. If absent, the model did not actually delegate; a switch only makes the tool available.
4. Review the final synthesis. Provide more concrete material if the result is generic.

Workers use the **same local model sequentially**, not separate larger models or parallel processes. Each receives the task written by the parent model, **not the entire chat or its saved memories**. The parent must include needed context. Workers have bounded read-only tools; they cannot spawn further workers, save memories, control the computer or send WhatsApp. Their model/tool calls share the parent budget. This is a second pass, not a guarantee of stronger intelligence or faster completion.

### Explain your screen or perform a computer action

1. Select **Local only**, close private windows, and enable **Computer control**.
2. Begin with: “Read my screen and explain the visible dialog. Do not click, type or change anything.”
3. Read the action request and approve only the screenshot. Denying it prevents that screen read.
4. If macOS denies access, check **System Settings → Privacy & Security**. Screen Recording (sometimes named Screen & System Audio Recording) is needed for screenshots; Accessibility is needed for input. Grant access only to the process/app actually running Imagine, often the terminal used to launch it. Follow any macOS request to reopen the app.
5. After screen reading works, try a low-impact action such as “Open Calculator.” Inspect and approve its specific action prompt, then verify the app opened.

Available actions are screen capture, app opening, coordinate clicks, typing and supported key presses. Every action needs approval. There is no arbitrary shell/AppleScript execution, robust structured UI navigation or automatic post-action verification. Screen layouts and coordinates can be misinterpreted. Keep initial tasks small and supervised. **Stop** prevents future work but does not undo completed clicks or typing. This bridge is macOS-only; actual permissions must be tested on your device.

### Pair and use WhatsApp

1. Open settings and click **Connect WhatsApp**.
2. On your phone open **WhatsApp → Linked devices → Link a device**, then scan the QR shown by Imagine. Wait for connected status.
3. Select **Local only** and enable **WhatsApp access**. Pairing and granting the model access are separate steps.
4. Have someone you know send a new test message, then ask: “Show my recently received WhatsApp texts. Do not send any messages.”
5. To test sending, ask for one exact text to one individual number with country code. Verify the recipient and message in the approval prompt. Approve only when both are correct.

Recent messages are those received by the running connection, not a complete historical archive. The app holds at most 30 received texts in memory. It does not have automatic replies, bulk sends, group broadcasts or an inbox synchronization guarantee. Baileys is unofficial and pairing can fail or expire. To revoke the connection, unlink Imagine in your phone’s **Linked devices**; merely turning **WhatsApp access** off prevents model tool access but does not unpair the device.

### Choose a cloud route without losing track of privacy

1. Have the operator configure `OPENAI_API_KEY` in the server’s environment before starting Imagine. Never paste an API key into chat or saved memory.
2. Open settings and choose **Smart** or **Frontier**. Smart is a simple routing heuristic, not an independent reasoning judge.
3. For follow-up questions, consider **Include recent chat in cloud requests**. It is off by default; enabling it permits recent user/assistant text to leave the Mac.
4. Review the provider, selected model and data description in each approval. Denying approval sends nothing for that request.
5. Check response details and budgets. A retrieval-based second attempt needs another approval and can incur more usage.

Local workers, saved memories, project tools, computer actions and WhatsApp tools do not run in Frontier mode. Public web retrieval is available. Smart mode can route to cloud, so use **Local only** when you need local tools or want to prevent cloud requests. API availability, account access and billing limits remain provider-dependent.

## Context and follow-up questions

Stay in the same conversation for follow-ups, but make corrections explicit. For example:

> I meant Shoumitro Roye, not Roy. Research Shoumitro Roye and distinguish that person from the earlier results.

This is more reliable than a bare “roye”. The observed failure where that word was treated as a new subject occurred even though previous messages were present; context delivery alone does not guarantee correct interpretation.

The local working window is 8K tokens, including system instructions, tool definitions, recent chat, tool results and output allowance. The UI sends at most 48 recent messages within its size limit. Whole older exchanges can be omitted and large tool results shortened, with visible notices. There is no semantic conversation compaction or reliable structured topic/entity tracker. Use a concise restatement of goals and decisions when a chat grows long. Starting a new conversation does not carry the previous transcript; explicitly saved local facts are separate.

On the cloud route, recent chat is excluded unless you opt in. There is no automatic attachment of local memories, files or screenshots. See the route and tool activity rather than assuming the model received everything visible in the UI.

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

## Create and edit images

Chat assistance and the image studio are separate workflows. Asking a chat model for a picture does not invoke image generation; open **Create** or **Edit**.

### Create a first image

1. Open **Create**, select an installed image model, and start with one image rather than a batch.
2. Describe the subject, composition, lighting and style. Example: “A ceramic coffee cup on a wooden table beside a rainy window, soft natural light, documentary photograph, realistic texture.”
3. Choose a frame. For Qwen, choose the speed/quality preset appropriate to your goal. Smaller dimensions and lower step counts can reduce time, but may reduce detail or alter the image.
4. Generate and watch progress. Model loading and per-step generation are different phases. Chat and image jobs share a queue, so another job can delay the start.
5. Inspect the result at full size. Download anything worth keeping. Use a fixed seed and the same model/settings for reproducible comparisons; changes to presets, backend or model can change the result.

Disk size is not total memory usage. A model that fits on disk may still run slowly when memory pressure causes swapping. More steps are not a universal quality improvement; there is no preset that guarantees both maximum speed and maximum realism. Compare one change at a time using the same prompt and seed.

### Edit a photo

1. Open **Edit** and upload/paste a photo, or select a generated image from the contact sheet.
2. Describe the change and what must remain unchanged. Example: “Change the background to a quiet library. Keep the person’s identity, clothing, pose and lighting unchanged.”
3. Use dedicated controls for frame extension or a second face-reference photo when applicable.
4. Compare before and after. Use **Keep editing** to refine a result; repeated regeneration can drift fine details.

The contact sheet lets you download, vary or edit previous results. Image deletion is permanent and skips the Trash; download files before deleting. Terminal commands, model imports, quantization, LoRAs, the image API and MCP setup are covered in the [main README](../README.md).

## Troubleshooting

| Symptom | What to check | What it does not mean |
|---|---|---|
| No chat model in the dropdown | Start Ollama, install a chat-capable model, refresh. The app filters models that leave insufficient weight-size headroom. | Installing an image model does not install a chat model. |
| Ollama connection error | Ensure Ollama is running; check any custom `OLLAMA_HOST` in the launch environment. | Imagine cannot answer locally without a running model server. |
| Slow first response | Look for loading/queue status; allow model loading. Close memory-heavy apps and consider a smaller model. | Disk size alone is not a latency or RAM estimate. |
| Slow subsequent response | Disable Deep reasoning or workers for a simple task; use one job at a time; inspect searches and approvals. | Additional workers are not a speed boost. |
| Apparently stuck | Inspect response details for queue, provider wait or pending approval. Use Stop before retrying. | Refreshing does not safely resume actions. |
| Model ignores a tool request | Check its switch, use Local only, make the task explicit and inspect actual tool activity. | Tool availability does not force tool use. |
| Worker never appeared | Look for `delegate` and Worker status; give a self-contained delegated task. | The model saying it delegated is not proof. |
| Wrong topic after a short correction | Restate the full corrected subject and intended task in the same conversation. | Recent history can be present yet interpreted badly. |
| Old decisions forgotten | Check context-omission notices; restate key decisions concisely. | A saved transcript is not unlimited working memory. |
| Cloud follow-up has no context | Inspect **Include recent chat in cloud requests** and the approval description. | Cloud history is not enabled by default. |
| Only search snippets / links | Inspect retrieval errors; try a direct public HTTPS source or supply an authorized excerpt. | Snippets do not establish that a page was read. |
| Person’s personal website ignored | Current identity selection can prefer professional-profile sites; give the personal site’s direct URL in a fresh request. | This is a selection limitation, not evidence of no public presence. |
| Search provider blocks a request | Inspect the fallback/provider attempts. The operator can configure an optional `BRAVE_SEARCH_API_KEY` before launch. | Keyless retrieval is best-effort, not guaranteed. |
| PDF extraction fails | Install Poppler (`brew install poppler`); use a text PDF below 2 MB. | Scanned PDFs require OCR, which is not included. |
| Blank screenshot / permission denied | Check Screen Recording access for the app/process running Imagine; follow macOS reopen prompts. | In-app approval does not grant OS permission. |
| Click or typing denied / incorrect | Check Accessibility permissions and the visible screen; try one simple supervised action. | Coordinate-based control is not reliable autonomous navigation. |
| Project file unreadable | Verify the scope shown in settings and launch Imagine from the intended directory. | Project access is not whole-computer file access or write access. |
| WhatsApp has no old messages | Wait for connected status, enable access and test with a newly received text. | Pairing does not provide a complete historical archive. |
| WhatsApp pairing expired | Reconnect and scan a fresh QR; inspect the connection status. | Baileys pairing is not guaranteed to remain active. |
| Reload lost an answer | Use **Check saved response**, then inspect **Run details**. | Recovery retrieves completed output; it does not restart an interrupted task. |
| Cloud key/model/budget error | Read the error; check server key setup and provider account access; use Local only to avoid cloud use. | Imagine does not silently choose a different paid model. |
| Tiny or missing cloud answer | Increase an overly small answer cap; reasoning also uses output tokens. | A provider token cap is not a guarantee of a complete answer. |

### A safe verification sequence

Test one capability at a time after setup:

1. Plain local chat: a small writing task completes and shows the local route.
2. Web: an explicit public search shows the query and source activity.
3. Memory: an explicit save appears in Saved memory, then can be removed there.
4. Worker: a narrow critique shows `delegate` and Worker activity.
5. Project reading: a request for one known file shows a read tool and no claimed modification.
6. Computer: a screen-only request is approved and succeeds before trying any input action.
7. WhatsApp: a newly received test text is visible before attempting one verified, approved send.
8. Cloud (optional): check approval/data disclosure and the returned provider route; expect account-dependent costs.

These checks verify behavior on your device, not reasoning quality or comprehensive factual accuracy. Deny any approval that does not match the task. Do not use a real payment, destructive action or sensitive message as a first computer-control test.

## Capability checklist

| Capability | Available today | Requires / limitation |
|---|---|---|
| Local reasoning, writing, coding suggestions | Yes | Installed chat model; quality varies. No custom fine-tuning included. |
| Recent conversational context | Yes | Bounded local 8K window; no semantic compaction or dependable topic tracking. |
| Persistent local facts | Yes | Explicit save; separate from transcripts; not automatically sent to cloud. |
| Public web research | Yes, best-effort | Lookup on; providers and page access can fail; current identity selection has gaps. |
| Specialist workers | Yes, bounded | Local route, switch on; same model, sequential, task-only context. |
| Project inspection | Yes, read-only | Local route, switch on; limited to launch folder. |
| Apply code changes / execute tests | No assistant tool | Suggestions and manual application only. |
| Screen reading and basic Mac input | Yes, supervised | Local route, switch on; every action approved; OS permissions. |
| Reliable autonomous computer/browser agent | No | Basic bridge; no dependable navigation or action recovery. |
| WhatsApp recent text and one-message sends | Yes, conditional | Pairing, local access switch, individual send approval; unofficial connection. |
| Frontier text route and caps | Yes, optional | Server key, provider access, per-request approval; no local tool execution. |
| Saved final-answer recovery | Yes | Local run journal; not task continuation or action replay. |
| Image creation/editing | Yes, in image studio | Installed image model/backend; not exposed as a chat tool. |

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

Image generation itself remains local. Optional internet lookup and WhatsApp are **not offline**. For offline work, use Local only, disable Internet lookup and unlink any paired WhatsApp connection on your phone. Turning WhatsApp access off prevents model access but does not disconnect the running bridge. The browser UI listens on `127.0.0.1:11437`, uses a session token for its API, and queues assistant and image jobs so they do not fight over the GPU. On small Macs it unloads the chat model after an answer; before any image job it asks Ollama to release chat models used by the UI.

Assistant runs have a 10-minute overall time budget (including UI queue/approvals), at most 12 local model calls and 24 tool calls shared with workers, plus 8 search queries and 8 page reads. Cached results do not repeat downloads. After a crash, unfinished dead-owner records become **interrupted** when the server starts. Diagnostic checkpoints do not contain enough state for safe replay, and no actions are automatically resumed.

## Scope and limits

Assist is a helpful local model with bounded tools, plus optional frontier text chat—not an unattended agent or a guarantee of frontier-level reasoning. It cannot run arbitrary commands, modify project files, or silently control the Mac or send WhatsApp messages. You can use it for authorized security learning and testing, but model behavior and refusal rates depend on the selected weights; there is no guarantee of an entirely “unrestricted” model.

WhatsApp sending and macOS computer actions require your own account/permissions and should be tried after setup. The automated test suite covers permission gates and UI routes; it does not prove that your particular macOS permissions or WhatsApp pairing will work without a live check.
The frontier route is tested with mocked API responses, not your credentials or account. A provider error, account limit or model unavailability is reported in the chat; Imagine does not silently switch to another paid model.

For image models, photo editing, CLI, OpenAI-compatible API and MCP tools, return to the [main README](../README.md).

For the runtime's current engineering strengths and gaps, see [the harness assessment](HARNESS.md).
