# imagine

**Generate and edit images on your Mac, fully offline.** It uses FLUX.2 Klein image models on Apple silicon, from the terminal, from any app that speaks the OpenAI API, or from AI assistants over MCP. Nothing is uploaded anywhere.

```bash
imagine "a cat blasting off from the sun, cinematic"
imagine "make it night time with a full moon, keep the cat" -i cat.png
```

| Generate | Edit it |
|---|---|
| ![A cat blasting off from the sun](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/cat.jpg) | ![The same cat at night under a full moon](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/cat-night.jpg) |
| `imagine "a cat blasting off from the sun, cinematic"` | `imagine "make it night time with a full moon, keep the cat" -i cat.png` |
| ![A cozy reading nook on a rainy evening](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/nook-rainy.jpg) | ![The same reading nook on a sunny spring morning](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/nook-sunny.jpg) |
| `imagine "a cozy reading nook with a cat on a window seat, rainy evening, warm lamp light"` | `imagine "make it a sunny spring morning" -i nook.png` |
| ![A tiny robot watering a bonsai tree](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/robot.jpg) | ![The same scene as a watercolor painting](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/robot-watercolor.jpg) |
| `imagine "a tiny robot watering a bonsai tree, studio photo"` | `imagine "make it a watercolor painting" -i robot.png` |

All made on a MacBook Pro (M5 Pro, 24 GB) in 11–40 seconds each with FLUX.2 Klein 4B.

## What it can do

- **Generate images from text** with FLUX.2 Klein, fully offline, on any Apple silicon Mac.
- **Edit photos with words**, such as "make it night" or "turn it into a watercolor", using up to 4 reference images.
- **Write better prompts for you** (`--enhance`), using a local chat model.
- **Reproduce any image**: every PNG remembers its prompt, seed and model (`imagine again`).
- **Quantize models** to MXFP8, MXFP4, INT8, INT4 or NVFP4, all running on native Apple silicon kernels.
- **Add LoRAs**: bake trained styles, characters or skills into a model.
- **Plug into apps and AI assistants** through an OpenAI-compatible API and an MCP server.
- **Benchmark your Mac** and share the result.

![imagine in the terminal: an enhanced prompt and a benchmark](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/terminal.png)

## Contents

- [What it can do](#what-it-can-do)
- [Quick start](#quick-start)
- [Generate and edit](#generate-and-edit)
- [Better prompts, reproducible images](#better-prompts-reproducible-images)
- [Models and quantization](#models-and-quantization)
- [Benchmark your Mac](#benchmark-your-mac)
- [Use it from your apps (OpenAI API)](#use-it-from-your-apps-openai-api)
- [Use it from AI assistants (MCP)](#use-it-from-ai-assistants-mcp)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [All commands](#all-commands) · [Configuration](#configuration) · [Update and uninstall](#update-and-uninstall) · [Development](#development)

## Quick start

You need a **Mac with Apple silicon** (M1 or newer) and about **7 GB of free disk space**. You don't need Ollama. If you already have it, `imagine` uses the models you've downloaded.

**1. Check your Mac.** Open Terminal and run:

```bash
uname -m     # must print "arm64"
```

**2. Install Node.js 20 or newer**, if `node --version` doesn't already show v20 or higher. Either install it with [Homebrew](https://brew.sh) or use the installer from [nodejs.org](https://nodejs.org).

```bash
brew install node
```

**3. Install imagine:**

```bash
npm install -g https://github.com/nitya-afk/imagine/releases/latest/download/imagine-local.tgz
```

This gives you the `imagine` command. It always installs the latest release. If npm reports `EACCES`, your Node install needs admin rights for global packages: run the same command with `sudo`, or switch to Homebrew's Node.

**4. Download the image model** (FLUX.2 Klein 4B, 5.7 GB, one time):

```bash
imagine pull
```

**5. Make your first image:**

```bash
imagine "a red fox in a snowy forest at golden hour"
```

The first run also downloads the image engine (115 MB, one time) and loads the model, so allow a minute. After that, a 1024×1024 image takes about 15–25 seconds. Each image opens in Preview as soon as it's ready, and is saved to `~/Pictures/imagine`.

## Generate and edit

```bash
imagine "a red apple on a wooden table, soft window light"
imagine "neon city at night" --size 1536x1024           # landscape
imagine "a lighthouse at dusk" --seed 42                 # the same seed gives the same image
imagine "a teapot" -n 4 -o ~/Desktop/teapots             # four variations in a folder
```

**Edit** by giving it one or more pictures (up to 4) and describing the change:

```bash
imagine "make it a watercolor painting" -i photo.jpg
imagine "put this jacket on this person" -i person.jpg -i jacket.jpg
```

Without `--size`, the edited image keeps the input's shape. There's no mask or brush: describe the change in words.

| Option | Default | |
|---|---|---|
| `-m, --model` | `x/flux2-klein` | short names work: `flux2-klein:4b-fp8` |
| `-i, --image` | | picture to edit; repeat for more (up to 4) |
| `-s, --size` | `1024x1024` | 256–2048 per side, multiples of 16 |
| `--steps` | model default | denoising steps (4 for Klein) |
| `--seed` | random | written into the filename so you can reproduce an image |
| `-n, --count` | `1` | how many images to make |
| `-o, --out` | `~/Pictures/imagine` | a folder, or a `.png` file name |
| `--no-open` | | don't open the result in Preview (it opens automatically when you run `imagine` in Terminal) |

Only the saved file path goes to the terminal's output, and nothing pops open when `imagine` runs inside a script or pipe, so it's script-friendly: `path=$(imagine 'a fox')`. Add `--open` to open anyway, or set `IMAGINE_OPEN=0` to never open.

## Better prompts, reproducible images

**Let a local chat model write the prompt.** Short ideas make flat images. `--enhance` hands your idea to a chat model in your own Ollama, which writes a detailed prompt (subject, setting, lighting, style) before the image is made. It's still fully offline, and the chat model is unloaded straight afterwards so it doesn't slow the image model.

```bash
imagine "a cat astronaut" --enhance
# Prompt: A fluffy ginger tabby cat wearing a high-tech white and gold spacesuit, complete with a glass
# helmet. The cat is floating inside a futuristic spaceship cabin with glowing control panels…
```

![The same seed with and without --enhance](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/enhance.jpg)

`--enhance` needs Ollama running with a chat model, for example `ollama pull gemma4:12b`. It picks the largest one that loads comfortably, or you can set `IMAGINE_ENHANCE_MODEL`.

**Every image remembers how it was made.** The prompt, seed, model, size and steps are saved inside each PNG, along with your original idea when you used `--enhance`. Other image tools can read them too (the `parameters` field). Recreate or riff on any image:

```bash
imagine again fox.png            # the exact same image, byte for byte
imagine again fox.png --vary     # same settings, new seed
imagine again fox.png --vary -n 4 --size 1536x1024
```

Edits can be redone too: add the original picture with `-i`.

## Models and quantization

```bash
imagine models
```
```
This Mac has 24 GB of memory.

  MODEL                   SIZE      MEMORY    LICENCE         EDITS
● x/flux2-klein:4b-fp4    5.7 GB    fits      Apache-2.0      yes  (installed as x/flux2-klein:latest)
  x/flux2-klein:4b-fp8    9.4 GB    fits      Apache-2.0      yes
  x/flux2-klein:4b-bf16   16.0 GB   tight     Apache-2.0      yes
  x/flux2-klein:9b-fp4    12.0 GB   fits      non-commercial  yes
  x/flux2-klein:9b-fp8    20.2 GB   too big   non-commercial  yes
  x/flux2-klein:9b-bf16   34.7 GB   too big   non-commercial  yes
  x/z-image-turbo:fp8     12.8 GB   fits      Apache-2.0      no
  x/z-image-turbo:bf16    32.9 GB   too big   Apache-2.0      no

● installed · pull with: imagine pull flux2-klein:4b-fp8
```

The variants trade size for quality. `fp4` is 4-bit (smallest and fastest), `fp8` is 8-bit (a little sharper), and `bf16` is full precision. The 9B models are larger and more detailed, but their licence is non-commercial.

- `fits`: the model uses at most half your memory.
- `tight`: it loads, but leaves little room for other apps.
- `too big`: it's over the engine's limit of about ¾ of your memory, so `imagine pull` refuses it unless you add `--force`.

FLUX.2 Klein is the tested and recommended family. The Z-Image Turbo models are listed because the engine supports them, but they can't edit.

### Quantize your own

`imagine create` imports a FLUX.2 Klein model in diffusers format, from a local folder or straight from Hugging Face, and quantizes it:

```bash
imagine create klein-4b --from black-forest-labs/FLUX.2-klein-4B --quantize mxfp8
imagine "a watercolor fox" -m klein-4b
```

It supports all five formats Apple's MLX runs natively, including the new microscaling float formats (MXFP4, MXFP8, NVFP4). They run through native quantized matmul kernels, so the weights stay compressed in memory, not just on disk. These are FLUX.2 Klein 4B results at 768×768 on an M5 Pro:

| `--quantize` | Size | Time | Difference from `int8` | |
|---|---|---|---|---|
| `mxfp8` | 8.8 GB | 10.7 s | 17.8 | **best quality**: closest to full precision, and faster than `int8` |
| `mxfp4` | 5.0 GB | 10.0 s | 26.3 | **smallest and fastest** |
| `int8` | 9.0 GB | 12.1 s | reference | near-lossless integer |
| `int4` | 5.3 GB | 12.8 s | 21.7 | 4-bit integer |
| `nvfp4` | 5.3 GB | 10.3 s | 37.7 | 4-bit float; drifts the most in our tests |
| *(omitted)* | 16 GB | | | full precision (bf16) |

![The same prompt and seed in all five formats](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/quantization.jpg)

"Difference from `int8`" is the average per-pixel difference out of 255 for the same prompt and seed, so lower means closer. Importing takes 10 to 14 seconds once the files are on disk. The Hugging Face download (16 GB for FLUX.2 Klein 4B) resumes if it's interrupted, and it's kept in `~/.imagine/huggingface` so you can create other variants from it. Only the transformer and text-encoder layers are quantized; the VAE, embeddings and norms stay in full precision. For gated models such as FLUX.2 Klein 9B, accept the licence on Hugging Face and set `HF_TOKEN`.

### Add LoRAs

A LoRA adds a trained style, character, product or skill to a model. `imagine create --lora` bakes one or more LoRAs into the weights before quantizing. They then work with every format, and cost nothing extra per image.

```bash
imagine create klein-tryon --from black-forest-labs/FLUX.2-klein-4B \
  --lora xocialize/tryon-FLUX.2-klein-4B-lora --quantize mxfp8

imagine create klein-styled --from black-forest-labs/FLUX.2-klein-4B \
  --lora ./my-style.safetensors:0.8 --lora ./my-character.safetensors
```

![Virtual try-on with a LoRA: a person, a jacket and trousers in, the person wearing them out](https://raw.githubusercontent.com/nitya-afk/imagine/main/docs/examples/lora-tryon.jpg)

*Made with the [try-on LoRA](https://huggingface.co/xocialize/tryon-FLUX.2-klein-4B-lora): the person, top and bottom go in as references, and the result keeps the person's face and pose.*

- **Where LoRAs come from:** a local `.safetensors` file, or Hugging Face as `owner/name`. For a repo with several files, use `owner/name/path/file.safetensors`.
- **Strength:** set it with `:weight` after the name (the default is 1). Repeat `--lora` to stack them.
- **Formats:** both common layouts are understood, diffusers/PEFT (`transformer.…lora_A`) and ai-toolkit/BFL (`diffusion_model.double_blocks…`). Fused layers are split onto the model's own layers.
- **Safety:** a LoRA made for a different model is refused before anything is written, rather than half-applied.
- **Speed:** merging runs on all your CPU cores. A rank-32 LoRA takes about 26 seconds on FLUX.2 Klein 4B.

## Benchmark your Mac

```bash
imagine bench
```
```
imagine bench: Apple M5 Pro, 24 GB, x/flux2-klein

  load + first 512×512   18.3 s
  512×512                4.3 s per image (average of 2)
  1024×1024              18.0 s per image (average of 2)

Share your result:
| Apple M5 Pro | 24 GB | x/flux2-klein | 4.3 s | 18.0 s | imagine 1.2.0 |
```

It uses a fixed prompt and seeds, so results from different Macs are comparable. Close other heavy apps first: memory pressure (for example a large chat model still loaded) can make it several times slower. [Open an issue](https://github.com/nitya-afk/imagine/issues) with your row and it'll go in a results table here.

## Use it from your apps (OpenAI API)

```bash
imagine serve    # http://127.0.0.1:11436/v1 — keep this running
```

`POST /v1/images/generations` and `POST /v1/images/edits` follow OpenAI's format, so an app built on an OpenAI SDK only needs a new base URL:

```js
import OpenAI, { toFile } from 'openai';
import fs from 'node:fs';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:11436/v1', apiKey: 'local' });

const made = await client.images.generate({ prompt: 'an astronaut riding a horse on mars', size: '1024x1024' });
fs.writeFileSync('astronaut.png', Buffer.from(made.data[0].b64_json, 'base64'));

const edited = await client.images.edit({
  prompt: 'make it night time',
  image: await toFile(fs.createReadStream('astronaut.png'), 'astronaut.png', { type: 'image/png' }),
});
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:11436/v1", api_key="local")
made = client.images.generate(prompt="an astronaut riding a horse on mars", size="1024x1024")
edited = client.images.edit(prompt="make it night time", image=open("astronaut.png", "rb"))
```

```bash
curl http://127.0.0.1:11436/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"prompt": "a lighthouse at dusk", "size": "1024x1024"}'
```

How requests are handled:

- **`model`:** OpenAI names (`dall-e-*`, `gpt-image-*`) or no model at all use the local default. Anything else is used as a local model name.
- **`size`:** `WxH` or `auto`. For edits, `auto` keeps the input's shape.
- **`n`:** 1–4. Images are made one after another.
- **`response_format`:** `b64_json` (the default) or `url`. With `url`, the image is served from `/images/…`.
- **`seed` and `steps`:** accepted in addition to OpenAI's fields.
- **`quality`, `style` and similar fields:** ignored.
- **`mask`:** refused with a clear error.
- **`GET /v1/models`:** lists your installed image models.

The server only listens on your own Mac. To share it on your network, use `--bind 0.0.0.0 --api-key <key>`. To let web pages on other sites call it, add `--cors`; it's off by default so random websites can't use your GPU.

## Use it from AI assistants (MCP)

`imagine mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server with three tools: `generate_image`, `edit_image` and `list_image_models`. Your assistant can then make and edit images on your Mac. Results appear in the chat and are saved to `~/Pictures/imagine`.

Desktop apps don't see your terminal's `PATH`, so give them the full path to `imagine` and a `PATH` that includes Node. Run `which imagine` to find the path. It's usually `/opt/homebrew/bin/imagine` with Homebrew's Node, or `/usr/local/bin/imagine` with the nodejs.org installer.

**Claude Desktop**: Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "imagine": {
      "command": "/opt/homebrew/bin/imagine",
      "args": ["mcp"],
      "env": { "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }
    }
  }
}
```

Restart the app, then ask something like *"make an image of a lighthouse at dusk"*.

**Cursor** (`~/.cursor/mcp.json`), **VS Code**, **Zed** and other MCP apps: use the same `command`, `args` and `env`.

**Claude Code**:

```bash
claude mcp add imagine -- imagine mcp
```

## Troubleshooting

| You see | What to do |
|---|---|
| `zsh: command not found: imagine` | Run the install again (step 3 of the quick start) and open a new Terminal window. |
| `npm error code EACCES` while installing | Your Node needs admin rights for global packages: run the install command with `sudo` in front, or install Node with Homebrew. |
| `model 'x/flux2-klein' not found. Download it with: imagine pull x/flux2-klein` | Run the `imagine pull` command it shows. |
| `… needs about 20.2 GB and this Mac has 16 GB of memory, so it would not load` | Pick a smaller variant from `imagine models`, such as an `fp4` one. |
| `Port 11435 is already used by …` | Another program is on the engine's port. Stop it, or pick another port: `export IMAGINE_ENGINE_PORT=11445`. |
| `Could not download … Run the command again to resume.` | Your connection dropped. Run the same command again; it continues where it stopped. |
| `The image engine did not start. Its log is at ~/.imagine/engine.log` | Look at the end of that log, then run `imagine stop` and try again. |
| `--enhance needs a chat model in Ollama` | Install one, for example `ollama pull gemma4:12b`, and make sure Ollama is running. |
| `… doesn't carry imagine's settings` | `imagine again` only works on images made by imagine 1.2 or later. |
| `this model does not support image editing` | Only FLUX.2 Klein can edit. Leave out `-m`, or pick a `flux2-klein` model. |
| `imagine needs a Mac with Apple silicon` | The engine needs Apple's Metal GPU. Intel Macs, Windows and Linux aren't supported. |
| The first image is slow | That's the one-time engine download plus loading the model. Later images are much faster, and the model stays loaded for 5 minutes. |
| An AI assistant says the tool failed to start | Use the full path and the `env` `PATH` shown in [the MCP section](#use-it-from-ai-assistants-mcp). |

`imagine status` shows which engine is doing the work, where images go and where the log is.

## How it works

Ollama added image generation for macOS in early 2026 and then [removed it in v0.32.6](https://github.com/ollama/ollama/pull/16615) ("to be re-introduced on the new MLX runner in the future"). The [model pages](https://ollama.com/x/flux2-klein) still say macOS works, so newer versions of Ollama download the models and then reply `image generation models are not currently supported` ([ollama#17893](https://github.com/ollama/ollama/issues/17893)).

`imagine` doesn't depend on which Ollama you have, or whether you have it at all:

```
imagine (terminal, OpenAI API, MCP)
  ├─ generate ─► your Ollama, if it can still make images
  │              otherwise ─► imagine-engine (127.0.0.1:11435)
  └─ edit ─────► imagine-engine
                   └─ models live in ~/.ollama/models, shared with Ollama
```

- **imagine-engine** is Ollama 0.32.5's image engine built from source in this repo ([`engine/`](https://github.com/nitya-afk/imagine/tree/main/engine)) with three fixes:
  - **Image editing.** FLUX.2 Klein can edit, but 0.32.5 ignored your input images.
  - **Importing and quantizing models.** Ollama removed this, and its last releases that had it crash on current Macs.
  - **Native MXFP4, MXFP8 and NVFP4.** These formats used to be expanded at load, or misread.

  The engine is built on GitHub Actions with a signed build provenance attestation, downloaded once from this repo's release, checked against a pinned SHA-256, and runs in the background on its own port.
- **Your models are shared.** Anything you pulled with Ollama works here, and anything you pull or create here shows up in `ollama list`. Nothing is downloaded twice.
- **It steps aside when Ollama catches up.** Plain generation tries your own Ollama first. When a version that can make images again ships, `imagine` notices and uses it.

### Verify the engine

Every engine release is built from this repo's source by GitHub Actions ([`engine.yml`](https://github.com/nitya-afk/imagine/blob/main/.github/workflows/engine.yml)) and signed with a build provenance attestation. To check that a download came from that workflow and commit:

```bash
gh release download v1.3.0 -R nitya-afk/imagine -p 'imagine-engine-*.tar.gz'
gh attestation verify imagine-engine-*.tar.gz --repo nitya-afk/imagine
```

## All commands

```bash
imagine "<prompt>" [options]                         # generate, or edit with -i
imagine "<idea>" --enhance                           # a local chat model writes the full prompt
imagine again <image.png> [--vary]                   # recreate an image from its saved settings
imagine bench                                        # measure this Mac's speed
imagine models                                       # models, sizes, and what fits this Mac
imagine pull [model]                                 # download a model (default x/flux2-klein)
imagine create <name> --from <src> [--quantize fmt] [--lora src[:w]]   # import, quantize, add LoRAs
imagine serve [--port 11436] [--bind …] [--api-key …] [--cors]   # OpenAI-compatible API
imagine mcp                                          # MCP server for AI assistants
imagine status                                       # which engine is running, where files go
imagine stop                                         # stop the background engine
imagine --help                                       # every option
```

## Configuration

| Variable | Default | |
|---|---|---|
| `IMAGINE_MODEL` | `x/flux2-klein` | default model |
| `IMAGINE_OUTPUT_DIR` | `~/Pictures/imagine` | where images are saved |
| `IMAGINE_OPEN` | `1` | set to `0` to never open images in Preview |
| `IMAGINE_ENHANCE_MODEL` | largest chat model that fits | the Ollama chat model `--enhance` uses |
| `IMAGINE_ENGINE_PORT` | `11435` | port for imagine-engine |
| `IMAGINE_OLLAMA_HOST` | | always use this server instead (for example an Ollama that can make images) |
| `IMAGINE_HOME` | `~/.imagine` | engine, logs and downloads |
| `IMAGINE_API_KEY` | | same as `serve --api-key` |
| `HF_TOKEN` | | for gated Hugging Face models |
| `OLLAMA_HOST` | `127.0.0.1:11434` | your normal Ollama, read the same way Ollama reads it |
| `OLLAMA_MODELS` | `~/.ollama/models` | the model folder shared with Ollama |

## Update and uninstall

To update, run the install command from the quick start again.

To uninstall:

```bash
imagine stop
npm uninstall -g imagine-local
rm -rf ~/.imagine
```

Models stay in `~/.ollama/models`. To remove one, run `ollama rm <model>`, or delete the folder to remove them all if you don't use Ollama.

## Development

```bash
git clone https://github.com/nitya-afk/imagine.git && cd imagine
npm install
npm run build      # compile to dist/
npm run check      # type check
npm test           # unit and HTTP tests, no GPU needed
npm link           # use your checkout as the `imagine` command
engine/build.sh    # rebuild imagine-engine from source (needs Go 1.26+)
```

Found a bug or have an idea? [Open an issue](https://github.com/nitya-afk/imagine/issues).

## Licences

`imagine` is MIT-licensed. `imagine-engine` is Ollama (MIT) plus MLX (MIT, © Apple); see [`engine/NOTICE.md`](https://github.com/nitya-afk/imagine/blob/main/engine/NOTICE.md). Models have their own licences: FLUX.2 Klein 4B and Z-Image Turbo are Apache-2.0, and FLUX.2 Klein 9B is non-commercial.

---

Made by [Nitya Prakhar](https://github.com/nitya-afk). Not affiliated with or endorsed by Ollama, Black Forest Labs or Apple.
