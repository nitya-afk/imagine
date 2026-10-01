/** Opt-in WhatsApp bridge. No automatic replies or background message processing. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { IMAGINE_HOME } from './config.ts';

export interface RecentMessage { from: string; text: string; at: number }

export class WhatsAppBridge {
  private socket: Awaited<ReturnType<typeof import('@whiskeysockets/baileys')['default']>> | null = null;
  private connecting: Promise<void> | null = null;
  private state: 'disconnected' | 'connecting' | 'qr' | 'connected' = 'disconnected';
  private qr: string | null = null;
  private recent: RecentMessage[] = [];
  private lastSend = 0;
  private stopping = false;

  status() { return { state: this.state, qr: this.qr, recent: this.recent.length }; }
  messages() { return this.recent.slice(-30); }

  async connect(): Promise<void> {
    if (this.socket || this.connecting) return this.connecting ?? Promise.resolve();
    this.stopping = false;
    this.state = 'connecting';
    this.connecting = this.open().catch((error: unknown) => {
      this.state = 'disconnected';
      throw error;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import('@whiskeysockets/baileys');
    const { toDataURL } = await import('qrcode');
    const folder = join(IMAGINE_HOME, 'whatsapp-auth');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const socket = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
    this.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', (update) => {
      if (this.stopping || this.socket !== socket) return;
      if (update.qr) {
        void toDataURL(update.qr, { margin: 2, width: 280 }).then((image) => {
          if (this.socket !== socket) return;
          this.qr = image;
          this.state = 'qr';
        });
      }
      if (update.connection === 'open') {
        this.state = 'connected';
        this.qr = null;
      }
      if (update.connection === 'close') {
        this.socket = null;
        this.qr = null;
        this.state = 'disconnected';
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (!this.stopping && code !== DisconnectReason.loggedOut) setTimeout(() => void this.connect().catch(() => {}), 3000).unref();
      }
    });
    socket.ev.on('messages.upsert', (event) => {
      if (event.type !== 'notify') return;
      for (const message of event.messages) {
        if (message.key.fromMe || !message.key.remoteJid) continue;
        const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
        if (!text) continue;
        this.recent.push({ from: message.key.remoteJid, text: text.slice(0, 4000), at: Number(message.messageTimestamp) || Date.now() / 1000 });
      }
      this.recent = this.recent.slice(-30);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const socket = this.socket;
    this.socket = null;
    this.state = 'disconnected';
    this.qr = null;
    if (socket) await socket.end(undefined);
  }

  async send(recipient: string, text: string): Promise<void> {
    if (this.state !== 'connected' || !this.socket) throw new Error('WhatsApp is not connected.');
    if (!/^\d{7,15}$/.test(recipient)) throw new Error('Use an individual phone number with country code, digits only.');
    if (!text.trim() || text.length > 2000) throw new Error('Message must be 1–2000 characters.');
    if (Date.now() - this.lastSend < 5000) throw new Error('Wait a few seconds before sending another message.');
    await this.socket.sendMessage(`${recipient}@s.whatsapp.net`, { text });
    this.lastSend = Date.now();
  }
}
