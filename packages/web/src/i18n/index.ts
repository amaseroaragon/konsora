import { es, type MessageKey } from "./es.ts";

export type { MessageKey };

/** Looks up a message and fills `{name}` placeholders. Unknown placeholders stay visible. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template: string = es[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
