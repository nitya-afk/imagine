# imagine-engine

The image engine that `imagine` runs on your Mac.

- `imagine-engine` is [Ollama](https://github.com/ollama/ollama) v0.32.5, built from source with the patches in [`engine/patches`](https://github.com/nitya-afk/imagine/tree/main/engine/patches). v0.32.5 is the last Ollama release that included image generation. Ollama is MIT-licensed, © Ollama. See `licenses/OLLAMA_LICENSE`.
- `mlx_metal_v3/` and `mlx_metal_v4/` hold the MLX and MLX-C libraries, taken unchanged from the official Ollama v0.32.5 release. MLX is MIT-licensed, © Apple. See `licenses/MLX_LICENSE` and `licenses/MLX_C_LICENSE`.

Patches:

- `0001-flux2-image-editing`: passes input images to FLUX.2's editing pipeline. In v0.32.5 the image runner received input images but never used them.
- `0002-image-model-import`: restores `create --experimental` for diffusers image models with `int4`/`int8` quantization (tested with FLUX.2 Klein 4B). Ollama dropped image import from its July 2026 importer rewrite. The last release that had it crashes with a thread error ("There is no Stream(gpu, 1) in current thread") on current MLX. This patch uses the rewrite's quantizer, which runs MLX on a pinned thread.

The released engine is built by GitHub Actions from this repo (`.github/workflows/engine.yml`) with a signed build provenance attestation. To check a download, run `gh attestation verify imagine-engine-*.tar.gz --repo nitya-afk/imagine`. To rebuild it yourself, run `engine/build.sh`. Not affiliated with or endorsed by Ollama or Apple.
