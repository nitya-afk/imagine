# Assist: a local thinking room

Imagine's **Assist** tab adds a local language model to the image studio. It can help with reasoning, writing, coding and research. The model runs through Ollama on your Mac; optional tools give it carefully scoped access to the web, saved memory, this project's files, the screen and WhatsApp.

The app's first screen introduces **Create**, **Edit** and **Assist**. Select **Assist** to open the model picker and tool switches. Nothing in this guide requires a cloud language-model account.

## Get started

Install [Ollama](https://ollama.com/download), then choose a model that fits your Mac:

```bash
ollama pull qwen3.5:4b     # recommended starting point for 8 GB Macs; ~3.4 GB on disk
ollama pull qwen3.5:9b     # stronger option for 16 GB or more; ~6.6 GB on disk
imagine ui
```

The app picks an installed 9B model by default when enough memory is available, otherwise the 4B model. It lists only chat models whose stored weights leave memory headroom. A model's [advertised context limit](https://ollama.com/library/qwen3.5/tags) is **not** its practical limit on an 8 GB Mac: Assist currently uses an 8K working context. The first response may include a model-loading delay.

An optional, community-tuned 4B model can be installed with `ollama pull huihui_ai/qwen3.5-abliterated:4b` and selected as **less-filtered**. It is not the default and is not guaranteed to reason better, produce better code, or comply with every request. No custom fine-tuning is included in Imagine.

## What you can ask

| Need | Example | What to enable |
|---|---|---|
| Reasoning and writing | “Compare these two approaches and draft a concise recommendation.” | Nothing extra |
| Coding help | “Explain this TypeScript error and propose a patch.” | Project files if it needs to inspect this folder |
| Recent facts | “Find the current release notes and cite the source.” | Internet lookup; a Brave API key for broad search |
| Persistent preferences | “Remember that I prefer concise answers.” | Nothing extra; you must explicitly ask it to remember |
| A second pass | “Use a specialist worker to critique your answer.” | Specialist workers |
| On-screen help | “Read my screen and explain what this dialog means.” | Computer control, then approve the screen read |
| WhatsApp | “Show my recent messages” or “Send this text to this number.” | Connect WhatsApp, enable access, approve each send |

The model may make mistakes. Check generated code, current facts, recipient numbers and on-screen actions before relying on them.

## Tool switches and approvals

- **Deep reasoning** allows a longer thinking pass. It is usually slower; the model can still be wrong.
- **Internet lookup** searches Wikipedia without a key and reads public HTTPS text pages. Set `BRAVE_SEARCH_API_KEY` before starting Imagine for broader search. Turn the switch off to prevent Assist from making web requests. Web content is treated as untrusted data.
- **Specialist workers** are bounded extra conversations with the same local model. They run sequentially to conserve unified memory; they are not parallel processes or independent computers.
- **Project files** provides read-only access beneath the directory from which you started `imagine ui`. It is off by default and does not grant file editing, shell execution, or access outside that directory.
- **Computer control** is off by default. It supports a screenshot, opening an app, a screen-coordinate click, typing text, or a keypress. **Every action requires approval** in Imagine. macOS may separately request Accessibility or Screen Recording permission. The assistant has no arbitrary shell or AppleScript tool.
- **WhatsApp access** is off by default. Click **Connect WhatsApp** and scan the QR in **WhatsApp → Linked devices**. The [Baileys](https://github.com/WhiskeySockets/docs/blob/main/quickstart.mdx) connection is unofficial. Assist can read recently received text after you enable access and can send one text to an individual number only after approval. It cannot automatically reply, broadcast to groups, or send bulk messages.

The approval prompt shows the specific proposed computer action or the WhatsApp recipient and message. Denying it prevents that action. Do not approve a send or a screen action whose effect you do not understand.

## Where data goes

| Data | Location or destination |
|---|---|
| Model inference | Your local Ollama server, normally `127.0.0.1:11434` |
| Saved facts | `~/.imagine/assistant-memory.json` on this Mac; view/remove them in Assist |
| WhatsApp pairing credentials | `~/.imagine/whatsapp-auth/` on this Mac; connecting also exchanges data with WhatsApp |
| Recent received WhatsApp text | At most the latest 30 messages in the running app's memory |
| Chat conversation | Current browser page session; reloading starts a new transcript |
| Web lookup | Wikipedia or, if configured, Brave Search; reading a URL contacts that website |
| Project files and screenshots | Given to the local model only when the relevant tool is enabled and called |

Image generation itself remains local. Optional internet lookup and WhatsApp are **not offline**. The browser UI listens on `127.0.0.1:11437`, uses a session token for its API, and queues assistant and image jobs so they do not fight over the GPU. On small Macs it unloads the chat model after an answer; before any image job it asks Ollama to release chat models used by the UI.

## Scope and limits

Assist is a helpful local model with bounded tools, not an unattended agent or a guarantee of frontier-level reasoning. It cannot run arbitrary commands, modify project files, or silently control the Mac or send WhatsApp messages. You can use it for authorized security learning and testing, but model behavior and refusal rates depend on the selected weights; there is no guarantee of an entirely “unrestricted” model.

WhatsApp sending and macOS computer actions require your own account/permissions and should be tried after setup. The automated test suite covers permission gates and UI routes; it does not prove that your particular macOS permissions or WhatsApp pairing will work without a live check.

For image models, photo editing, CLI, OpenAI-compatible API and MCP tools, return to the [main README](../README.md).
