/**
 * Botão no canto esquerdo + painel lateral deslizante com o ChatPanel.
 *
 * - Abre/fecha sem recarregar a página; o painel permanece montado quando fechado,
 *   preservando a conversa (e uma geração em andamento).
 * - Pode ser controlado (`open` + `onOpenChange`) ou não controlado (`defaultOpen`).
 * - Esc fecha o painel; o foco vai para o campo ao abrir e volta ao botão ao fechar.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChatPanel, type ChatPanelProps } from "./ChatPanel.tsx";
import "./ChatLauncher.css";

export type LauncherPosition = "bottom-left" | "middle-left";

export interface ChatLauncherProps extends Omit<ChatPanelProps, "onClose" | "active"> {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Exibe o botão flutuante. Use false se o sistema hospedeiro tiver o próprio botão. */
  showLauncher?: boolean;
  position?: LauncherPosition;
  launcherLabel?: string;
  /**
   * Identifica a conversa (ex.: usuário + organização do Gerpro). Ao mudar, o histórico é
   * descartado: identificadores de uma sessão não são reenviados em outra.
   */
  conversationKey?: string;
}

export function ChatLauncher({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  showLauncher = true,
  position = "bottom-left",
  launcherLabel,
  title = "AI Gerpro",
  conversationKey,
  ...panelProps
}: ChatLauncherProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  // Ao fechar, devolve o foco ao botão se ele estava dentro do painel.
  useEffect(() => {
    if (wasOpen.current && !open && panelRef.current?.contains(document.activeElement)) {
      buttonRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  // Esc fecha o painel (escuta no documento para funcionar também com foco fora dele).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <div className={`gia-root gia-root--${position}`} data-open={open || undefined}>
      {showLauncher && (
        <button
          ref={buttonRef}
          type="button"
          className="gia-launcher"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          title={open ? `Fechar ${title}` : `Abrir ${title}`}
          tabIndex={open ? -1 : 0}
        >
          <svg className="gia-launcher-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" fill="currentColor" />
            <circle cx="8" cy="11" r="1.4" fill="#fff" />
            <circle cx="12" cy="11" r="1.4" fill="#fff" />
            <circle cx="16" cy="11" r="1.4" fill="#fff" />
          </svg>
          <span className="gia-launcher-label">{launcherLabel ?? title}</span>
        </button>
      )}

      <aside
        ref={panelRef}
        id={panelId}
        className={`gia-panel${open ? " gia-panel--open" : ""}`}
        aria-label={title}
        aria-hidden={!open}
        inert={!open}
      >
        <ChatPanel key={conversationKey} {...panelProps} title={title} onClose={() => setOpen(false)} active={open} />
      </aside>
    </div>
  );
}
