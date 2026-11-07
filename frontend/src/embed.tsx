/**
 * Ponto de integração independente de tecnologia: monta o AI Gerpro (botão + painel
 * lateral) em qualquer página HTML, sem exigir React no sistema hospedeiro.
 *
 * Uso com o build do widget (npm run build:widget):
 *   <link rel="stylesheet" href="ai-gerpro.css">
 *   <script src="ai-gerpro.js"></script>
 *   <script>
 *     const ai = AIGerpro.mount({ apiBaseUrl: "http://127.0.0.1:3001/api" });
 *     // ai.open(); ai.close(); ai.toggle(); ai.isOpen(); ai.unmount();
 *   </script>
 */
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatLauncher, type LauncherPosition } from "./components/ChatLauncher.tsx";
import type { AuthTokenProvider } from "./api/client.ts";

export interface MountOptions {
  /** URL base do backend do AI Gerpro. Padrão: "/api" (mesma origem/proxy). */
  apiBaseUrl?: string;
  title?: string;
  /** Elemento onde montar; padrão: um <div> novo ao final do <body>. */
  container?: HTMLElement;
  defaultOpen?: boolean;
  /** false = sem botão flutuante (o hospedeiro usa o próprio botão e chama open/toggle). */
  showLauncher?: boolean;
  position?: LauncherPosition;
  streaming?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Opcional: devolve o token de curta duração emitido pelo backend do Gerpro para o usuário
   * logado. Sem ele, o assistente funciona normalmente, mas não consulta bases corporativas.
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

export function mountAiGerpro(options: MountOptions = {}): AiGerproHandle {
  const { container, defaultOpen = false, onOpenChange, conversationKey, ...props } = options;
  let key = conversationKey ?? "";
  let generation = 0;
  const host = container ?? document.body.appendChild(document.createElement("div"));
  const ownsHost = !container;
  host.setAttribute("data-ai-gerpro", "");

  const root: Root = createRoot(host);
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

  return {
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
      root.unmount();
      if (ownsHost) host.remove();
    },
  };
}

declare global {
  interface Window {
    AIGerpro?: { mount: typeof mountAiGerpro };
  }
}

if (typeof window !== "undefined") {
  window.AIGerpro = { mount: mountAiGerpro };
}
