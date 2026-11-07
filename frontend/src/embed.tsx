/**
 * Ponto de integração independente de tecnologia: monta o AI Gerpro (botão + painel
 * lateral) em qualquer página HTML, sem exigir React no sistema hospedeiro.
 *
 * Isolamento (Etapa 4.1): o widget vive em um Shadow DOM próprio, dentro do elemento
 * <ai-gerpro-widget>. O CSS do widget é injetado no shadow root (não há arquivo CSS para
 * incluir) e o CSS da página hospedeira não alcança os elementos do widget.
 *
 * Uso com o build do widget (npm run build:widget):
 *   <script src="ai-gerpro.js"></script>
 *   <script>
 *     const ai = AIGerpro.mount({ apiBaseUrl: "https://ai-gerpro.exemplo/api" });
 *     // ai.open(); ai.close(); ai.toggle(); ai.isOpen(); ai.unmount();
 *   </script>
 *
 * Instância única: chamar mount() de novo sem unmount() devolve a instância existente
 * (navegação em SPA, script incluído duas vezes) em vez de criar um segundo painel.
 */
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatLauncher, type LauncherPosition } from "./components/ChatLauncher.tsx";
import type { AuthTokenProvider } from "./api/client.ts";
import launcherCss from "./components/ChatLauncher.css?inline";
import panelCss from "./components/ChatPanel.css?inline";

export interface MountOptions {
  /** URL base do backend do AI Gerpro. Padrão: "/api" (mesma origem/proxy). */
  apiBaseUrl?: string;
  title?: string;
  /** Elemento onde inserir o widget; padrão: ao final do <body>. O elemento não é alterado. */
  container?: HTMLElement;
  defaultOpen?: boolean;
  /** false = sem botão flutuante (o hospedeiro usa o próprio botão e chama open/toggle). */
  showLauncher?: boolean;
  position?: LauncherPosition;
  streaming?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Opcional: devolve o token de curta duração emitido pelo backend do Gerpro para o usuário
   * logado. Sem ele, o assistente funciona normalmente, mas não consulta bases corporativas
   * (ou, com CHAT_REQUIRE_AUTH ativo no backend, não responde).
   */
  getAuthToken?: AuthTokenProvider;
  /**
   * Opcional: chave da conversa (ex.: `${usuario}:${organizacao}`). Ao trocar de usuário ou
   * organização no Gerpro, chame setConversationKey(): o histórico anterior é descartado.
   */
  conversationKey?: string;
}

export interface AiGerproHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Descarta o histórico da conversa (ex.: logout no Gerpro). */
  resetConversation(): void;
  /** Troca a chave da conversa; se mudar, o histórico é descartado. */
  setConversationKey(key: string): void;
  unmount(): void;
}

/** Nome do elemento hospedeiro (elemento personalizado: regras genéricas como `div {}` não o alcançam). */
export const HOST_TAG = "ai-gerpro-widget";

/** Versão do widget (para conferência e controle de cache). */
export const WIDGET_VERSION: string = typeof __AI_GERPRO_VERSION__ === "string" ? __AI_GERPRO_VERSION__ : "dev";

/**
 * Base do isolamento. Regras de dentro do shadow root com !important vencem as !important da
 * página para o elemento hospedeiro; `display: contents` faz o hospedeiro não gerar caixa
 * (transform/filter da página não alteram o posicionamento fixo do painel). `.gia-root` zera
 * as propriedades herdadas (fonte, cor, line-height, text-transform...) vindas da página.
 */
const BASE_CSS = `
:host { all: initial !important; display: contents !important; }
.gia-root { all: initial; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 16px; color: #1f2933; }
`;

/** Registro global da instância ativa (sobrevive a cópias duplicadas do script na página). */
const INSTANCE_KEY = Symbol.for("ai-gerpro.instance");
type InstanceRegistry = { [INSTANCE_KEY]?: AiGerproHandle };

export function mountAiGerpro(options: MountOptions = {}): AiGerproHandle {
  const registry = globalThis as InstanceRegistry;
  const existing = registry[INSTANCE_KEY];
  if (existing) {
    console.warn("[AI Gerpro] O widget já está montado; a instância existente foi reaproveitada. Chame unmount() antes de montar de novo.");
    if (options.conversationKey !== undefined) existing.setConversationKey(options.conversationKey);
    return existing;
  }

  const { container, defaultOpen = false, onOpenChange, conversationKey, ...props } = options;
  let key = conversationKey ?? "";
  let generation = 0;

  const host = document.createElement(HOST_TAG);
  host.setAttribute("data-ai-gerpro", WIDGET_VERSION);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `${BASE_CSS}\n${launcherCss}\n${panelCss}`;
  const mountPoint = document.createElement("div");
  mountPoint.className = "gia-mount";
  shadow.append(style, mountPoint);
  (container ?? document.body).appendChild(host);

  const root: Root = createRoot(mountPoint);
  let open = defaultOpen;
  let mounted = true;

  const render = () =>
    root.render(
      <StrictMode>
        <ChatLauncher {...props} conversationKey={`${key}#${generation}`} open={open} onOpenChange={setOpen} />
      </StrictMode>,
    );

  function setOpen(next: boolean) {
    if (!mounted || next === open) return;
    open = next;
    render();
    onOpenChange?.(open);
  }

  render();

  const handle: AiGerproHandle = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    resetConversation() {
      if (!mounted) return;
      generation++;
      render();
    },
    setConversationKey(next: string) {
      if (!mounted || next === key) return;
      key = next;
      render();
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      root.unmount(); // cancela a geração em andamento e remove os listeners do React
      host.remove();
      if (registry[INSTANCE_KEY] === handle) delete registry[INSTANCE_KEY];
    },
  };
  registry[INSTANCE_KEY] = handle;
  return handle;
}

declare global {
  interface Window {
    AIGerpro?: { mount: typeof mountAiGerpro; version: string };
  }
}

// Script incluído duas vezes: mantém a API já publicada (e o registro da instância é compartilhado).
if (typeof window !== "undefined" && !window.AIGerpro) {
  window.AIGerpro = { mount: mountAiGerpro, version: WIDGET_VERSION };
}
