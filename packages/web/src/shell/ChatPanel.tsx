import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  CHAT_MODELS,
  type ChatMessage,
  type ChatModel,
  readChatModel,
  useChat,
  useResetChat,
  useSendChat,
  useStopChat,
  writeChatModel,
} from "../api/chat.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Button, Field, useToast } from "../ui/index.ts";
import { Markdown } from "./Markdown.tsx";

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "tool")
    return (
      <li className="b-chat__msg b-chat__msg--tool">
        <span className="k-mono s-muted">↳ {message.text}</span>
      </li>
    );
  if (message.role === "stopped")
    return (
      <li className="b-chat__msg b-chat__msg--tool">
        <span className="k-mono s-muted">■ {t("chat.stopped")}</span>
      </li>
    );
  if (message.role === "error")
    return (
      <li className="b-chat__msg b-chat__msg--error a-callout a-callout--warn" role="alert">
        <span className="a-callout__text">{message.text}</span>
      </li>
    );
  return (
    <li className={`b-chat__msg b-chat__msg--${message.role}`}>
      <b className="b-chat__by">{message.role === "human" ? t("detail.you") : t("chat.agent")}</b>
      <Markdown className="md--compact" text={message.text} />
    </li>
  );
}

/**
 * The AI panel: a planning chat with the user's own Claude Code. It interviews the human and
 * creates the tasks, which appear on the board like any other write. It changes nothing else.
 */
export function ChatPanel({
  projectId,
  readOnly,
  onClose,
  draft,
}: {
  projectId: string;
  readOnly: boolean;
  onClose: () => void;
  /** A message to put in the input, not sent (UI-20 «Afinar con IA»); `n` changes on each one. */
  draft?: { text: string; n: number } | undefined;
}) {
  const chat = useChat(projectId);
  const send = useSendChat(projectId);
  const stop = useStopChat(projectId);
  const reset = useResetChat(projectId);
  const toast = useToast();
  const [text, setText] = useState(draft?.text ?? "");
  const [model, setModel] = useState<ChatModel>(() => readChatModel(projectId));
  const modelId = useId();
  const end = useRef<HTMLLIElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // A new draft replaces the input and takes the focus there, ready to review and send.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new draft (its `n`) applies.
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    form.current?.querySelector("textarea")?.focus();
  }, [draft?.n]);
  const messages = chat.data?.messages ?? [];
  const busy = chat.data?.busy ?? false;
  const count = messages.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each new message.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [count, busy]);

  const failed = (error: Error) => {
    if (error instanceof ApiError && error.unauthorized) return;
    toast.show(t("chat.error", { message: error.message }), "error");
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const body = text.trim();
    if (!body || busy || readOnly) return;
    send.mutate({ text: body, model }, { onSuccess: () => setText(""), onError: failed });
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <aside className="a-detail b-panel b-chat" aria-label={t("chat.title")}>
      <div className="a-detail__head">
        <div className="a-detail__chips">
          <h2 className="a-detail__title b-chat__title">{t("chat.title")}</h2>
          {count > 0 && (
            <Button
              size="sm"
              variant="ghost"
              busy={reset.isPending}
              onClick={() => reset.mutate(undefined, { onError: failed })}
            >
              {t("chat.reset")}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="a-detail__close" onClick={onClose}>
            ✕<span className="k-visually-hidden">{t("chat.close")}</span>
          </Button>
        </div>
      </div>
      <div className="a-detail__body a-stack">
        {chat.isError ? (
          <p className="a-callout a-callout--warn" role="alert">
            {t("chat.unavailable")}
          </p>
        ) : count === 0 ? (
          <p className="s-text s-muted">{t("chat.intro")}</p>
        ) : (
          <ol className="b-chat__list" aria-live="polite">
            {messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {busy && (
              <li className="b-chat__msg b-chat__msg--wait s-muted" role="status">
                {t("chat.thinking")}
              </li>
            )}
            <li ref={end} aria-hidden="true" />
          </ol>
        )}
        <form ref={form} className="a-stack b-chat__form" onSubmit={submit}>
          <Field
            multiline
            rows={text.length > 200 ? 10 : 3}
            label={t("chat.input")}
            hint={t("chat.input.hint")}
            value={text}
            disabled={readOnly}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKey}
          />
          <div className="k-field b-chat__model">
            <label htmlFor={modelId} className="k-field__label">
              {t("chat.model")}
            </label>
            <select
              id={modelId}
              className="k-field__control"
              value={model}
              disabled={readOnly}
              onChange={(event) => {
                const next = event.target.value as ChatModel;
                setModel(next);
                writeChatModel(projectId, next);
              }}
            >
              {CHAT_MODELS.map((value) => (
                <option key={value} value={value}>
                  {value ? t(`chat.model.${value}`) : t("chat.model.default")}
                </option>
              ))}
            </select>
          </div>
          <div className="a-actions">
            <Button
              type="submit"
              variant="primary"
              busy={send.isPending}
              disabled={readOnly || busy || !text.trim()}
            >
              {t("chat.send")}
            </Button>
            {busy && (
              <Button
                variant="secondary"
                busy={stop.isPending}
                onClick={() => stop.mutate(undefined, { onError: failed })}
              >
                {t("chat.stop")}
              </Button>
            )}
          </div>
          {readOnly && <p className="s-muted">{t("chat.readonly")}</p>}
        </form>
      </div>
    </aside>
  );
}
