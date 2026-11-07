/**
 * Remoção do raciocínio interno do modelo. O raciocínio NUNCA deve chegar ao usuário.
 *
 * - Com think=true, o Ollama separa o raciocínio em `message.thinking` (descartado)
 *   e `content` vem limpo; ainda assim removemos um eventual bloco <think> inicial.
 * - Modelos "thinking" (ex.: qwen3:4b thinking-2507) abrem <think> no próprio template;
 *   com think=false o conteúdo chega com o raciocínio seguido de um "</think>" órfão.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

/** Versão não-streaming: remove blocos <think>…</think> e tudo antes de um </think> órfão. */
export function stripReasoning(content: string): string {
  let out = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const orphan = out.lastIndexOf(CLOSE);
  if (orphan !== -1) out = out.slice(orphan + CLOSE.length);
  return out.trim();
}

/**
 * "leading-tag": suprime apenas um bloco <think>…</think> no início (conteúdo normalmente limpo).
 * "until-close": suprime tudo até o primeiro </think> (modelo thinking com think=false).
 *   Se o stream terminar sem </think>, considera tudo resposta (modelo híbrido com raciocínio desligado).
 */
export type ReasoningFilterMode = "leading-tag" | "until-close";

type State = "probe" | "reasoning" | "pass";

export class ReasoningStreamFilter {
  private readonly mode: ReasoningFilterMode;
  private state: State;
  private buf = "";
  private emittedAny = false;

  constructor(mode: ReasoningFilterMode) {
    this.mode = mode;
    this.state = mode === "until-close" ? "reasoning" : "probe";
  }

  /** true enquanto o filtro está retendo texto que pode ser raciocínio. */
  get suppressing(): boolean {
    return this.state === "reasoning";
  }

  /** Recebe um pedaço do conteúdo e devolve somente o texto seguro para exibição. */
  push(text: string): string {
    if (this.state === "pass") return this.emit(text);
    this.buf += text;

    if (this.state === "probe") {
      const t = this.buf.trimStart();
      if (t.length === 0) return "";
      if (t.length < OPEN.length && OPEN.startsWith(t)) return ""; // pode ser o início de <think>
      if (t.startsWith(OPEN)) {
        this.state = "reasoning";
        this.buf = t.slice(OPEN.length);
      } else {
        this.state = "pass";
        const out = this.buf;
        this.buf = "";
        return this.emit(out);
      }
    }

    // state === "reasoning"
    const idx = this.buf.indexOf(CLOSE);
    if (idx === -1) return "";
    const rest = this.buf.slice(idx + CLOSE.length);
    this.buf = "";
    this.state = "pass";
    return this.emit(rest);
  }

  /** Fim do stream: devolve o que ainda for seguro exibir. */
  end(): string {
    const buf = this.buf;
    this.buf = "";
    if (this.state === "probe") return this.emit(buf);
    if (this.state === "reasoning") {
      // until-close sem </think>: o modelo não raciocinou; o texto retido é a resposta.
      // leading-tag com <think> não fechado: só havia raciocínio (truncado) — nada a exibir.
      return this.mode === "until-close" ? this.emit(stripReasoning(buf)) : "";
    }
    return "";
  }

  private emit(text: string): string {
    if (!this.emittedAny) {
      text = text.trimStart();
      if (text) this.emittedAny = true;
    }
    return text;
  }
}
