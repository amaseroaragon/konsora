/**
 * The agent catalog (DMN-05): for each provider, what its adapter declares (`detect()`,
 * `models()`, permission profiles), kept for a short time so the UI and every launch do not run
 * `claude --version` or open `codex app-server` again and again.
 */
import type { AgentCatalogEntry, Provider } from "@konsora/core";
import type { AgentAdapter, DetectResult } from "@konsora/runner";

export const CATALOG_TTL_MS = 30_000;

export class AgentCatalog {
  readonly #adapters: Partial<Record<Provider, AgentAdapter>>;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #cached: { at: number; entries: Promise<AgentCatalogEntry[]> } | null = null;

  constructor(
    adapters: Partial<Record<Provider, AgentAdapter>>,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#adapters = adapters;
    this.#ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Every provider Konsora has an adapter for, in a fixed order. */
  list(): Promise<AgentCatalogEntry[]> {
    const now = this.#now();
    if (!this.#cached || now - this.#cached.at >= this.#ttlMs) {
      const entries = Promise.all(
        (Object.entries(this.#adapters) as [Provider, AgentAdapter][])
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, adapter]) => describe(adapter)),
      );
      this.#cached = { at: now, entries };
    }
    return this.#cached.entries;
  }

  async entry(provider: Provider): Promise<AgentCatalogEntry | undefined> {
    return (await this.list()).find((entry) => entry.provider === provider);
  }
}

/** One adapter's entry; it never rejects (a failure is part of the entry). */
async function describe(adapter: AgentAdapter): Promise<AgentCatalogEntry> {
  const base = {
    provider: adapter.id,
    profiles: [...(adapter.profiles ?? ["default"])],
    open_models: adapter.openModels === true,
  };
  const found: DetectResult = await adapter.detect().catch(() => ({ installed: false }));
  if (!found.installed) return { ...base, installed: false, models: [] };
  const detail = {
    installed: true,
    ...(found.version ? { version: found.version } : {}),
    ...(found.expected_version ? { expected_version: found.expected_version } : {}),
    ...(found.version_matches !== undefined ? { version_matches: found.version_matches } : {}),
    ...(found.warning ? { warning: found.warning } : {}),
    ...(found.transport ? { transport: found.transport } : {}),
  };
  try {
    const models = await adapter.models();
    return { ...base, ...detail, models: models.map((m) => ({ ...m, efforts: [...m.efforts] })) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return { ...base, ...detail, models: [], models_error: reason };
  }
}
