/** Deliberately small macOS UI bridge: no shell tool or arbitrary AppleScript from the model. */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
export type ComputerAction =
  | { action: 'open_app'; app: string }
  | { action: 'type_text'; text: string }
  | { action: 'press_key'; key: string }
  | { action: 'click'; x: number; y: number }
  | { action: 'view_screen' };

export function describeComputerAction(action: ComputerAction): string {
  switch (action.action) {
    case 'open_app': return `Open the app “${action.app}”`;
    case 'type_text': return `Type: ${action.text}`;
    case 'press_key': return `Press ${action.key}`;
    case 'click': return `Click screen at (${action.x}, ${action.y})`;
    case 'view_screen': return 'Read a screenshot of your screen';
  }
}

export async function performComputerAction(action: ComputerAction): Promise<{ content: string; images?: string[] }> {
  if (process.platform !== 'darwin') throw new Error('Computer control currently needs macOS.');
  if (action.action === 'open_app') {
    if (!action.app || action.app.length > 100) throw new Error('Invalid app name.');
    await execFile('/usr/bin/open', ['-a', action.app]);
    return { content: `Opened ${action.app}.` };
  }
  if (action.action === 'type_text') {
    if (!action.text || action.text.length > 2000) throw new Error('Text must be 1–2000 characters.');
    await execFile('/usr/bin/osascript', ['-e', 'on run argv\n tell application "System Events" to keystroke (item 1 of argv)\nend run', '--', action.text]);
    return { content: 'Typed the requested text.' };
  }
  if (action.action === 'press_key') {
    const parts = action.key.toLowerCase().split('+').map((part) => part.trim());
    const key = parts.pop() ?? '';
    if (!/^[a-z0-9]$/.test(key) && !['return', 'tab', 'space', 'escape', 'delete'].includes(key)) throw new Error('Unsupported key.');
    const mods = parts.map((part) => ({ cmd: 'command down', command: 'command down', shift: 'shift down', option: 'option down', ctrl: 'control down', control: 'control down' })[part]);
    if (mods.some((mod) => !mod)) throw new Error('Unsupported modifier.');
    const keyScript = key === 'return' ? 'key code 36' : key === 'tab' ? 'key code 48' : key === 'escape' ? 'key code 53' : key === 'delete' ? 'key code 51' : `keystroke "${key === 'space' ? ' ' : key}"`;
    const script = `tell application "System Events" to ${keyScript}${mods.length ? ` using {${mods.join(', ')}}` : ''}`;
    await execFile('/usr/bin/osascript', ['-e', script]);
    return { content: `Pressed ${action.key}.` };
  }
  if (action.action === 'click') {
    const { x, y } = action;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 10000 || y > 10000) throw new Error('Invalid screen coordinates.');
    await execFile('/usr/bin/osascript', ['-e', `tell application "System Events" to click at {${x}, ${y}}`]);
    return { content: `Clicked at (${x}, ${y}).` };
  }
  const dir = mkdtempSync(join(tmpdir(), 'imagine-screen-'));
  const file = join(dir, 'screen.png');
  try {
    await execFile('/usr/sbin/screencapture', ['-x', '-t', 'png', file]);
    await execFile('/usr/bin/sips', ['-Z', '1280', file]);
    return { content: 'Current screen screenshot.', images: [readFileSync(file).toString('base64')] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
