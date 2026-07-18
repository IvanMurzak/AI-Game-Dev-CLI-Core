import type { AgentConfigFs } from "../src/index.js";

/**
 * A tiny in-memory {@link AgentConfigFs} for the config-writer tests — exercises the writers'
 * create / merge / read-back behaviour with zero real filesystem access. Directories are implicit
 * (any write creates the file; `mkdirSync` is a no-op record).
 */
export class MemFs implements AgentConfigFs {
  readonly files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, data] of Object.entries(initial)) this.files.set(norm(path), data);
  }

  existsSync(path: string): boolean {
    return this.files.has(norm(path));
  }
  readFileSync(path: string): string {
    const data = this.files.get(norm(path));
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return data;
  }
  writeFileSync(path: string, data: string): void {
    this.files.set(norm(path), data);
  }
  mkdirSync(_dir: string): void {
    /* directories are implicit in the map */
  }
  get(path: string): string | undefined {
    return this.files.get(norm(path));
  }
}

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}
