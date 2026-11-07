/**
 * Componente de chat independente. Depende apenas de React e de um ChatApi
 * (por padrão, o backend em "/api"). Não conhece nada do Gerpro: pode ser usado em
 * página inteira ou dentro do painel lateral (ChatLauncher / embed).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, createChatApi, type AuthTokenProvider, type ChatApi } from "../api/client.ts";
import type { ChatMessage, Grounding, OllamaHealthResponse, ResolutionSummary, SourceSummary } from "../api/types.ts";
import { Markdown, type CitationOptions } from "./Markdown.tsx";
import { SourceList } from "./SourceList.tsx";
import { ORIGIN_LABEL, analyzeCitations, clip, groundingNote, resolutionNote } from "../sources/model.ts";
import "./ChatPanel.css";

export interface ChatPanelProps {
  /** URL base do backend do assistente. Padrão: "/api". */
  apiBaseUrl?: string;
  /** Permite injetar outro cliente (ex.: testes). Tem precedência sobre apiBaseUrl. */
  api?: ChatApi;
  /** Credencial do Gerpro para consultas às bases corporativas (ver docs/INTEGRACAO-RECUPERACAO.md). */
  getAuthToken?: AuthTokenProvider;
  title?: string;
  /** Usa streaming (padrão) ou resposta completa de uma vez. */
  streaming?: boolean;
  /** Se definido, exibe botão de fechar no cabeçalho (modo painel). */
  onClose?: () => void;
  /** Quando passa a true, move o foco para o campo de mensagem (ex.: painel aberto). */
  active?: boolean;
}

type MsgState = "streaming" | "done" | "interrupted" | "error";

interface UiMessage extends ChatMessage {
  id: number;
  state: MsgState;
  meta?: string;
  /** Fontes recebidas do backend para ESTA resposta (únicas que validam marcadores). */
  sources?: SourceSummary[];
  grounding?: Grounding;
  resolution?: ResolutionSummary;
}

/** Fase da geração atual: aguardando o servidor, modelo raciocinando, ou texto chegando. */
type Phase = "idle" | "waiting" | "thinking" | "streaming";

type HealthState = { kind: "checking" } | { kind: "loaded"; data: OllamaHealthResponse } | { kind: "error"; message: string };

const MAX_CHARS = 8000;
let nextId = 1;

export function ChatPanel({
  apiBaseUrl = "/api",
  api,
  getAuthToken,
  title = "AI Gerpro",
  streaming = true,
  onClose,
  active,
}: ChatPanelProps) {
  const client = useMemo(
    () => api ?? createChatApi(apiBaseUrl, undefined, getAuthToken ? { getAuthToken } : {}),
    [api, apiBaseUrl, getAuthToken],
  );
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>({ kind: "checking" });
  const [elapsed, setElapsed] = useState(0);
  /** Marcador clicado no texto: abre a fonte correspondente na lista da mensagem. */
  const [selected, setSelected] = useState<{ msgId: number; ref: string; n: number } | null>(null);
  /** A recuperação está ativa neste backend (recebemos fundamentação diferente de "disabled"). */
  const [retrievalActive, setRetrievalActive] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pending = phase !== "idle";

  const checkHealth = useCallback(() => {
    setHealth({ kind: "checking" });
    client
      .getOllamaHealth()
      .then((data) => setHealth({ kind: "loaded", data }))
      .catch((e: unknown) => setHealth({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
  }, [client]);

  useEffect(checkHealth, [checkHealth]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  // Rola para o fim enquanto chegam novas mensagens/trechos.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, phase]);

  // Cronômetro da geração (o modelo pode levar vários segundos raciocinando).
  useEffect(() => {
    if (!pending) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [pending]);

  const updateMsg = (id: number, patch: Partial<UiMessage> | ((m: UiMessage) => Partial<UiMessage>)) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)));

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || pending) return;

    const userMsg: UiMessage = { id: nextId++, role: "user", content: text, state: "done" };
    const botId = nextId++;
    const history = [...messages.filter((m) => m.content.trim() !== ""), userMsg];
    setMessages([...messages, userMsg, { id: botId, role: "assistant", content: "", state: "streaming" }]);
    setInput("");
    setError(null);
    setNotice(null);
    setPhase("waiting");

    const controller = new AbortController();
    abortRef.current = controller;
    const payload = history.map(({ role, content }) => ({ role, content }));
    let received = "";

    // Agrupa os trechos recebidos por quadro de animação (evita re-renderizar a cada token).
    let frame = 0;
    const flush = () => {
      frame = 0;
      const snapshot = received;
      updateMsg(botId, { content: snapshot });
    };
    const scheduleFlush = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };

    try {
      if (streaming) {
        for await (const ev of client.streamChat(payload, controller.signal)) {
          if (ev.type === "sources") {
            updateMsg(botId, { sources: ev.sources, grounding: ev.grounding, ...(ev.resolution ? { resolution: ev.resolution } : {}) });
            if (ev.grounding !== "disabled") setRetrievalActive(true);
          } else if (ev.type === "thinking") setPhase("thinking");
          else if (ev.type === "delta") {
            received += ev.content;
            setPhase("streaming");
            scheduleFlush();
          } else if (ev.type === "done") {
            if (frame) cancelAnimationFrame(frame);
            updateMsg(botId, { content: received.trim(), state: "done", meta: formatMeta(ev.model, ev.durationMs) });
          }
        }
      } else {
        const res = await client.sendChat(payload, controller.signal);
        received = res.message.content;
        updateMsg(botId, {
          content: received,
          state: "done",
          meta: formatMeta(res.model, res.durationMs),
          ...(res.grounding ? { grounding: res.grounding, sources: res.sources ?? [] } : {}),
          ...(res.resolution ? { resolution: res.resolution } : {}),
        });
        if (res.grounding && res.grounding !== "disabled") setRetrievalActive(true);
      }
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      const wasAborted = err instanceof ApiError && err.code === "aborted";
      if (received.trim() === "") {
        // Nada foi gerado: remove a pergunta e devolve o texto ao campo para facilitar o reenvio.
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id && m.id !== botId));
        setInput(text);
        if (wasAborted) setNotice("Geração interrompida.");
        else setError(errorMessage(err));
      } else if (wasAborted) {
        updateMsg(botId, { content: received.trim(), state: "interrupted", meta: "Interrompida" });
      } else {
        updateMsg(botId, { content: received.trim(), state: "error", meta: "Resposta incompleta" });
        setError(errorMessage(err));
      }
    } finally {
      setPhase("idle");
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <section className="gia-chat" aria-label={title}>
      <header className="gia-header">
        <h1>{title}</h1>
        <div className="gia-header-actions">
          <HealthBadge state={health} onRetry={checkHealth} />
          {onClose && (
            <button type="button" className="gia-close" onClick={onClose} aria-label="Fechar assistente" title="Fechar (Esc)">
              ×
            </button>
          )}
        </div>
      </header>

      <p className="gia-disclaimer">
        {retrievalActive ? (
          <>As respostas podem utilizar informações recuperadas das bases integradas ao Gerpro. Confira as fontes indicadas.</>
        ) : (
          <>
            O assistente <strong>não tem acesso</strong> a processos, contratos ou dados do Gerpro. As respostas são
            geradas por um modelo de IA local e podem conter erros.
          </>
        )}
      </p>

      <div className="gia-messages" ref={listRef} aria-live="polite" aria-busy={pending}>
        {messages.length === 0 && <p className="gia-empty">Envie uma mensagem para começar.</p>}
        {messages.map((m) => {
          const isPendingBot = m.role === "assistant" && m.state === "streaming";
          return (
            <article key={m.id} className={`gia-msg gia-msg--${m.role}${m.state !== "done" ? ` gia-msg--${m.state}` : ""}`}>
              <span className="gia-role">{m.role === "user" ? "Você" : "Assistente"}</span>
              {m.role === "user" ? (
                <div className="gia-content gia-content--plain">{m.content}</div>
              ) : isPendingBot && m.content === "" ? (
                <ProcessingIndicator phase={phase} elapsed={elapsed} />
              ) : (
                <div className={`gia-content${isPendingBot ? " gia-content--streaming" : ""}`}>
                  <Markdown text={m.content} citations={citationOptions(m, (ref) => setSelected({ msgId: m.id, ref, n: Date.now() }))} />
                </div>
              )}
              {m.role === "assistant" && <SourceFooter m={m} selected={selected?.msgId === m.id ? selected : null} streaming={isPendingBot} />}
              {m.meta && <span className="gia-meta">{m.meta}</span>}
            </article>
          );
        })}
      </div>

      {error && (
        <div className="gia-error" role="alert">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="gia-notice" role="status">
          {notice}
        </div>
      )}

      <form className="gia-form" onSubmit={send}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Digite sua mensagem (Enter envia, Shift+Enter quebra linha)"
          rows={3}
          maxLength={MAX_CHARS}
          disabled={pending}
          aria-label="Mensagem"
        />
        {pending ? (
          <button type="button" className="gia-stop" onClick={stop} title="Interromper a geração">
            <span className="gia-stop-icon" aria-hidden="true" />
            Interromper
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Enviar
          </button>
        )}
      </form>
    </section>
  );
}

/** Marcadores válidos = fontes recebidas para esta mensagem. Sem fontes, todo marcador é "sem fonte". */
function citationOptions(m: UiMessage, onSelect: (ref: string) => void): CitationOptions {
  const sources = m.sources ?? [];
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  return {
    valid: new Set(byRef.keys()),
    describe: (ref) => {
      const s = byRef.get(ref);
      if (!s) return `Fonte ${ref}`;
      const title = clip(s.title, 60);
      return `${ref} · ${ORIGIN_LABEL[s.origin].short} · ${clip(s.label, 40)}${title ? ` — ${title}` : ""}`;
    },
    onSelect,
  };
}

/** Notas de fundamentação e lista de fontes sob a resposta do assistente. */
function SourceFooter({ m, selected, streaming }: { m: UiMessage; selected: { ref: string; n: number } | null; streaming: boolean }) {
  const sources = m.sources ?? [];
  const { cited, unknown } = analyzeCitations(m.content, sources);
  const notes = [resolutionNote(m.resolution), groundingNote(m.grounding)].filter((x): x is string => !!x);
  // Durante o streaming, o aviso de marcador inexistente espera o fim (o texto ainda está incompleto).
  const unknownShown = streaming ? [] : unknown;
  if (notes.length === 0 && sources.length === 0 && unknownShown.length === 0) return null;
  return (
    <>
      {notes.map((n) => (
        <p key={n} className="gia-grounding-note">
          {n}
        </p>
      ))}
      <SourceList idPrefix={`gia-src-${m.id}`} sources={sources} cited={cited} unknown={unknownShown} selected={selected} />
    </>
  );
}

function formatMeta(model: string, durationMs: number): string {
  return `${model} · ${(durationMs / 1000).toFixed(1)} s`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ProcessingIndicator({ phase, elapsed }: { phase: Phase; elapsed: number }) {
  const label = phase === "thinking" ? "Analisando a pergunta" : "Processando";
  return (
    <div className="gia-processing" role="status">
      <span className="gia-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        {label}…{elapsed >= 2 ? ` ${elapsed} s` : ""}
      </span>
    </div>
  );
}

function HealthBadge({ state, onRetry }: { state: HealthState; onRetry: () => void }) {
  if (state.kind === "checking") return <span className="gia-badge gia-badge--checking">Verificando modelo…</span>;
  if (state.kind === "error") {
    return (
      <button type="button" className="gia-badge gia-badge--down" onClick={onRetry} title={state.message}>
        Backend indisponível · tentar novamente
      </button>
    );
  }
  const { data } = state;
  const label =
    data.status === "ok"
      ? `${data.model} · online`
      : data.status === "degraded"
        ? `${data.model} · modelo ausente`
        : "Ollama offline";
  return (
    <button
      type="button"
      className={`gia-badge gia-badge--${data.status === "ok" ? "ok" : "down"}`}
      onClick={onRetry}
      title={data.error ?? `Ollama ${data.version ?? ""} · ${data.latencyMs} ms`}
    >
      {label}
    </button>
  );
}
