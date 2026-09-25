/**
 * The one path every front end (CLI, API, MCP, UI) generates through: input pictures are made
 * decodable, edits go to the engine, the rest may use your own Ollama, and each PNG records how it
 * was made.
 */
import { defaultDeps, withImageBackend } from './backend.ts';
import { prepareImage } from './images.ts';
import { normalizeModelName } from './models.ts';
import { generateImage, OllamaError, type GenerateParams, type StepProgress } from './ollama.ts';
import { pngSize, withMetadata } from './png.ts';
import type { RuntimeEvents } from './runtime.ts';

export type Generate = (params: GenerateParams, onProgress?: (p: StepProgress) => void, idea?: string) => Promise<Buffer>;

export function imageGenerator(events: RuntimeEvents, version: string): Generate {
  return async (params, onProgress, idea) => {
    const images = params.images?.length
      ? await Promise.all(
          params.images.map(async (b64, i) =>
            (await prepareImage(Buffer.from(b64, 'base64'), `input image ${i + 1}`)).toString('base64'),
          ),
        )
      : undefined;
    const request = { ...params, images, model: normalizeModelName(params.model) };
    try {
      const png = await withImageBackend((host) => generateImage(host, request, onProgress), defaultDeps(events), {
        editing: Boolean(request.images?.length),
      });
      const size = pngSize(png) ?? { width: request.width ?? 0, height: request.height ?? 0 };
      return withMetadata(png, {
        prompt: request.prompt,
        idea,
        model: request.model,
        seed: request.seed,
        ...size,
        steps: request.steps,
        edit: Boolean(request.images?.length),
        generator: `imagine ${version}`,
      });
    } catch (err) {
      if (err instanceof OllamaError && /not found/i.test(err.message)) {
        throw new Error(`${err.message}. Download it with: imagine pull ${request.model}`);
      }
      throw err;
    }
  };
}
