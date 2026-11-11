import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyChatMessage, type Chat, chatKey } from "../src/api/chat.ts";
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
    expect(html).toContain("solo puede proponer");
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
