import type { ChatMessage } from './assistant.ts';

/** Deliberately cautious estimate, not an exact model tokenizer. */
export function estimateTokens(value: unknown): number { return Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') / 2); }
export function packContext(messages: ChatMessage[], tools: unknown[], outputTokens: number, contextTokens = 8192) {
  const budget = contextTokens - outputTokens - estimateTokens(tools) - 384;
  if (budget < 1) throw new Error('Answer/tool settings leave no room for input. Lower the answer cap or disable unused tools.');
  const system = messages.filter(m => m.role === 'system');
  const groups: ChatMessage[][] = [];
  for (const message of messages.filter(m => m.role !== 'system')) {
    if (message.role === 'user' || !groups.length) groups.push([]);
    groups.at(-1)!.push(message);
  }
  let dropped = 0, shortened = 0;
  const images = groups.flat().filter(m => m.images?.length);
  for (const group of groups) for (const [i, m] of group.entries()) if (m.images?.length && m !== images.at(-1)) {
    group[i] = { ...m, images: undefined, content: m.content + '\n[Older screenshot omitted; use the latest screenshot for current screen state.]' }; shortened++;
  }
  // Base64 bytes are image transport, not text tokens. Reserve a bounded vision
  // allowance for the latest screenshot instead (still model-dependent/estimated).
  const cost = () => {
    const items = [...system, ...groups.flat()];
    return estimateTokens(items.map(({ images, ...message }) => message)) + items.reduce((n, m) => n + (m.images?.length ?? 0) * 2048, 0);
  };
  // Drop entire old exchanges, never orphan a tool result from its tool call.
  while (groups.length > 1 && cost() > budget) { dropped += groups.shift()!.length; }
  if (cost() > budget) {
    for (const group of groups) for (const [i, m] of group.entries()) {
      if (m.role === 'tool' && m.content.length > 1600) {
        group[i] = { ...m, content: m.content.slice(0, 1600) + '\n[Tool output shortened to fit context; request a narrower excerpt if needed.]' }; shortened++;
      }
    }
  }
  const packed = [...system, ...groups.flat()];
  if (cost() > budget) throw new Error('This message and tool results exceed the local working context. Shorten the message, reduce the answer cap or start a narrower task; your message was not silently truncated.');
  return { messages: packed, dropped, shortened, estimatedInputTokens: cost() + estimateTokens(tools), contextTokens };
}
