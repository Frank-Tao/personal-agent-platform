import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';

// Chat with Atlas. The browser talks to Cockpit; Cockpit talks to Hermes' OpenAI-compatible API server
// (http://127.0.0.1:8642/v1) with the API key, which never leaves this process. Atlas answers as it does on
// Telegram: same persona, memory, skills and tools. The conversation is its own Hermes session
// (X-Hermes-Session-Id), so it does not interleave with the Telegram thread.
//
// Events sent to the browser (one JSON object per SSE `data:` line):
//   { t: 'text',  v }   answer text      { t: 'think', v }  reasoning summary (shown dimmed)
//   { t: 'tool',  v }   Atlas started a tool (what it is doing)
//   { t: 'done',  reason }               { t: 'error', v }

export interface ChatOptions {
  apiUrl: string;
  apiKey: string | undefined;
  fetch?: typeof fetch;
}

export const SESSION_RE = /^cockpit-[a-z0-9-]{8,64}$/;
export const MAX_MESSAGE = 8_000;

/** API_SERVER_KEY from Hermes' own .env — a single line, read once, held in memory, never logged or sent to a browser. */
export function loadHermesApiKey(env: NodeJS.ProcessEnv, hermesHome: string): string | undefined {
  if (env.HERMES_API_KEY) return env.HERMES_API_KEY;
  try {
    const m = readFileSync(join(hermesHome, '.env'), 'utf8').match(/^API_SERVER_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

export interface ChatRequest {
  message: string;
  sessionId: string;
}

export function validateChat(body: any): { ok: true; req: ChatRequest } | { ok: false; message: string } {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return { ok: false, message: 'message is empty' };
  if (message.length > MAX_MESSAGE) return { ok: false, message: `message is longer than ${MAX_MESSAGE} characters` };
  if (typeof body.sessionId !== 'string' || !SESSION_RE.test(body.sessionId)) return { ok: false, message: 'sessionId must look like cockpit-<8-64 lowercase letters, digits or dashes>' };
  return { ok: true, req: { message, sessionId: body.sessionId } };
}

/** Text of a hermes.tool.progress frame, whatever shape this Hermes version gives it. */
function toolText(data: any): string {
  const v = data?.label ?? data?.tool ?? data?.name ?? data?.text ?? data?.message;
  return typeof v === 'string' && v ? v.slice(0, 120) : 'working…';
}

/** Splits an SSE byte stream into { event, data } frames (comment lines such as ": keepalive" are dropped). */
export async function* sseFrames(body: AsyncIterable<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

export async function streamChat(opts: ChatOptions, chat: ChatRequest, res: ServerResponse, signal: AbortSignal): Promise<void> {
  const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  if (!opts.apiKey) {
    send({ t: 'error', v: 'Cockpit has no Hermes API key. Set HERMES_API_KEY in infra/env (the API_SERVER_KEY from ~/.hermes/.env) and restart Cockpit.' });
    return void res.end();
  }
  try {
    const upstream = await (opts.fetch ?? fetch)(`${opts.apiUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}`, 'x-hermes-session-id': chat.sessionId },
      // History lives in the Hermes session, so only the new message is sent.
      body: JSON.stringify({ model: 'hermes-agent', stream: true, messages: [{ role: 'user', content: chat.message }] }),
    });
    if (!upstream.ok || !upstream.body) {
      const why = upstream.status === 401 ? 'Hermes rejected the API key (check HERMES_API_KEY)' : `Hermes answered HTTP ${upstream.status}`;
      send({ t: 'error', v: why });
      return void res.end();
    }
    let finished = false;
    for await (const f of sseFrames(upstream.body as unknown as AsyncIterable<Uint8Array>)) {
      if (f.data === '[DONE]') break;
      let d: any;
      try {
        d = JSON.parse(f.data);
      } catch {
        continue;
      }
      if (f.event === 'hermes.tool.progress') {
        send({ t: 'tool', v: toolText(d) });
        continue;
      }
      if (d.error) {
        send({ t: 'error', v: String(d.error.message ?? d.error).slice(0, 300) });
        finished = true;
        break;
      }
      const choice = d.choices?.[0];
      if (choice?.delta?.reasoning_content) send({ t: 'think', v: choice.delta.reasoning_content });
      if (choice?.delta?.content) send({ t: 'text', v: choice.delta.content });
      if (choice?.finish_reason) {
        send({ t: 'done', reason: choice.finish_reason });
        finished = true;
      }
    }
    if (!finished) send({ t: 'done', reason: 'stop' });
  } catch (e) {
    if (!signal.aborted) send({ t: 'error', v: `Could not reach Hermes at ${opts.apiUrl}: is the gateway running? (${(e as Error).message.slice(0, 80)})` });
  }
  res.end();
}

/** A private message is answered here, on this Mac, by the Personal Privacy agent; it is never forwarded to Atlas' cloud model. */
export async function streamPrivate(res: ServerResponse, ask: (text: string) => Promise<{ answer: string; masked: number }>, text: string): Promise<void> {
  const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  send({ t: 'tool', v: 'Personal Privacy is answering on this Mac…' });
  try {
    const r = await ask(text);
    send({ t: 'text', v: `🔒 **Personal Privacy** answered this locally; your message was not sent to a cloud model${r.masked ? ` (${r.masked} detail${r.masked === 1 ? '' : 's'} masked in the answer)` : ''}.\n\n${r.answer}` });
    send({ t: 'done', reason: 'stop' });
  } catch (e) {
    send({ t: 'error', v: `Personal Privacy could not answer (${String((e as Error).message).split('\n')[0].slice(0, 160)}). Nothing was sent to a cloud model.` });
  }
  res.end();
}
