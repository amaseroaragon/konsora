import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyChatMessage,
  type Chat,
  chatBody,
  chatKey,
  readChatModel,
  writeChatModel,
} from "../src/api/chat.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { ChatPanel } from "../src/shell/ChatPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";

function render(chat: Chat | undefined, readOnly = false) {
  const client = new QueryClient();
  if (chat) client.setQueryData(chatKey("p1"), chat);
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ChatPanel projectId="p1" readOnly={readOnly} onClose={() => {}} />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

describe("AI panel", () => {
  it("explains what it does before the first message", () => {
    const html = render({ messages: [], busy: false });
    expect(html).toContain("Planificar con IA");
    expect(html).toContain("solo puede planificar");
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Enviar/);
    expect(html).not.toContain("Empezar de nuevo");
  });

  it("shows the conversation, the tools the agent used and the answer in progress", () => {
    const html = render({
      busy: true,
      messages: [
        { id: 1, role: "human", text: "Un caché", at },
        { id: 2, role: "agent", text: "¿Cuánto **dura**?", at },
        { id: 3, role: "tool", text: 'propose "Añadir caché"', at },
        { id: 4, role: "error", text: "Not logged in", at },
      ],
    });
    expect(html).toContain("Un caché");
    expect(html).toContain("<strong>dura</strong>");
    expect(html).toContain("↳ propose &quot;Añadir caché&quot;");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Claude está pensando…");
    expect(html).toContain(">Detener<");
    expect(html).toContain("Empezar de nuevo");
  });

  it("shows a stopped answer as a quiet Spanish line, not as an error", () => {
    const html = render({
      busy: false,
      messages: [
        { id: 1, role: "human", text: "Planifica", at },
        { id: 2, role: "stopped", text: "Stopped.", at },
      ],
    });
    expect(html).toContain("Respuesta detenida.");
    expect(html).not.toContain("Stopped.");
    expect(html).not.toContain('role="alert"');
  });

  it("cannot send on a read-only plan", () => {
    const html = render({ messages: [], busy: false }, true);
    expect(html).toContain("No se puede planificar mientras el plan es de solo lectura.");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("a chat.updated event replaces the cached conversation; anything else is ignored", () => {
    const client = new QueryClient();
    const chat: Chat = { messages: [{ id: 1, role: "human", text: "Hola", at }], busy: true };
    applyChatMessage(client, "p1", { chat });
    expect(client.getQueryData(chatKey("p1"))).toEqual(chat);
    applyChatMessage(client, "p1", { chat: { nope: true } });
    expect(client.getQueryData(chatKey("p1"))).toEqual(chat);
  });
});

describe("the panel's model (DMN-06)", () => {
  const storage = new Map<string, string>();
  const withStorage = (run: () => void) => {
    const global = globalThis as { window?: unknown };
    const before = global.window;
    global.window = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
    };
    try {
      run();
    } finally {
      global.window = before;
    }
  };

  it("offers Claude Code's default and the models, default first", () => {
    const html = render({ messages: [], busy: false });
    expect(html).toContain(">Modelo<");
    expect(html).toMatch(/<option value="" selected="">El de Claude Code por defecto<\/option>/);
    for (const name of ["Opus", "Sonnet", "Haiku"]) expect(html).toContain(`>${name}</option>`);
  });

  it("sends no model unless one was chosen", () => {
    expect(chatBody("Hola", "")).toEqual({ text: "Hola" });
    expect(chatBody("Hola", "opus")).toEqual({ text: "Hola", model: "opus" });
  });

  it("remembers the choice per project, and shows it", () => {
    withStorage(() => {
      expect(readChatModel("p1")).toBe("");
      writeChatModel("p1", "haiku");
      expect(readChatModel("p1")).toBe("haiku");
      expect(readChatModel("p2")).toBe("");
      expect(render({ messages: [], busy: false })).toMatch(
        /<option value="haiku" selected="">Haiku<\/option>/,
      );
      writeChatModel("p1", "");
      expect(readChatModel("p1")).toBe("");
      storage.set("konsora.chat.model.p1", "gpt");
      expect(readChatModel("p1")).toBe("");
    });
  });
});
