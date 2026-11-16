// A service the fixture workflow reaches through its import: every real call throws, so a case
// that lets one through shows.

export class ServiceError extends Error {}

export type Db = { name: string; query(q: string): Promise<string[]>; close(): Promise<void> };

export async function list(): Promise<string[]> {
  throw new Error("the real list ran");
}

export async function send(_to: string, _text: string): Promise<void> {
  throw new Error("the real send ran");
}

export async function remove(_id: string): Promise<void> {
  throw new Error("the real remove ran");
}

export async function connect(): Promise<Db> {
  throw new Error("the real connect ran");
}

export function parse(text: string): string[] {
  return text.split(",");
}

export const client = {
  async ping(): Promise<string> {
    throw new Error("the real ping ran");
  },
  async reply(_text: string): Promise<void> {
    throw new Error("the real reply ran");
  },
};

export class Sender {
  async send(_text: string): Promise<string> {
    throw new Error("the real Sender.send ran");
  }
  async archive(): Promise<void> {
    throw new Error("the real Sender.archive ran");
  }
}
