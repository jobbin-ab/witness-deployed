/**
 * The share-link API, the four calls the step makes. The link is the credential and goes
 * in the path, as the contract says; every write carries the deploy's actor.
 */
import type { Card } from './lib.ts';

/** The shape of fetch the clients take, so a test can hand in a stand-in without bun's extras. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type Actor = { kind: 'agent'; name: string; via: string };

export class WitnessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Witness {
  constructor(
    private readonly link: string,
    private readonly actor: Actor,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  /** The project's area prefixes — the only ids a commit can cite here. */
  async prefixes(): Promise<string[]> {
    const data = await this.call<{ project: { areas: { prefix: string }[] } }>('GET', '/project.json');
    return data.project.areas.map((a) => a.prefix);
  }

  /** The card, or null when the id names none. */
  async card(id: string): Promise<Card | null> {
    try {
      const data = await this.call<{ card: Card }>('GET', `/cards/${id}.json`);
      const { id: cardId, title, status, version } = data.card;
      return { id: cardId, title, status, version };
    } catch (e) {
      if (e instanceof WitnessError && e.status === 404) return null;
      throw e;
    }
  }

  async comment(id: string, body: string): Promise<void> {
    await this.call('POST', `/cards/${id}/comments`, { body, actor: this.actor });
  }

  /** One field, on the version read; the server answers 409 if the card moved meanwhile. */
  async setStatus(id: string, version: number, status: string): Promise<void> {
    await this.call('PATCH', `/cards/${id}`, { status, actor: this.actor }, { 'If-Match': String(version) });
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(this.link.replace(/\/+$/, '') + path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = (data ?? {}) as { error?: string; message?: string };
      throw new WitnessError(res.status, err.error ?? 'error', err.message ?? `${res.status} from witness`);
    }
    return data as T;
  }
}
