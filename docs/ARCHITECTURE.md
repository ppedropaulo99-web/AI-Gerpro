# Arquitetura — AI Gerpro

**Ambiente:** demonstração técnica (`APP_ENV=demo`), sem dados reais. Os conectores para Qdrant e Neo4j existem
(Etapa 3.1), mas não estão configurados. A integração com o Gerpro está descrita em
[INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md).

## Visão geral

```
Página hospedeira (qualquer HTML)
  └─ widget AI Gerpro: botão no canto esquerdo + painel lateral (ChatLauncher → ChatPanel)
        │  HTTP /api  (fetch; streaming NDJSON)
        ▼
Vite (proxy em dev) ──▶ Backend Fastify ──HTTP──▶ Ollama (127.0.0.1:11434): chat e embeddings
                            │
                            ├─ AuthContextResolver (identidade do Gerpro; padrão "none")
                            └─ RetrievalService (opcional, somente leitura)
                                 ├─ QdrantVectorStore ──HTTPS──▶ Qdrant
                                 └─ Neo4jGraphStore   ──bolt+s─▶ Neo4j  (só consultas pré-autorizadas)
```

Sem Qdrant/Neo4j configurados, o `RetrievalService` fica desativado e o fluxo é idêntico ao da Etapa 2.1.

- O navegador **nunca** acessa o Ollama, o Qdrant ou o Neo4j. Somente o backend conhece endereços e credenciais.
- Backend e Vite escutam em `127.0.0.1` por padrão.
- O **raciocínio interno do modelo nunca sai do cliente Ollama do backend** (ver "Raciocínio").

## Decisões

| Decisão | Motivo |
|---|---|
| Monorepo com npm workspaces | Um `npm install`, scripts unificados |
| **Fastify** + clientes oficiais `@qdrant/js-client-rest` e `neo4j-driver` (Etapa 3.1) | Rotas, validação e `inject()`; os clientes oficiais acompanham os protocolos e versões dos servidores. `undici` fixado em 7.30.2 via `overrides`, porque a versão exigida pelo cliente do Qdrant tinha vulnerabilidades (`npm audit`: 0) |
| Recuperação **somente leitura**, mapeamento em JSON, autorização vinda do servidor | Ver [INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md): sem Cypher livre, sem filtros do navegador, sem consulta sem `AuthContext` |
| TypeScript nativo do Node + `node:test` + `--env-file` | Dispensa tsx, dotenv, Jest e Vitest |
| **Streaming NDJSON** em `POST /api/chat/stream` | Funciona com `fetch` + POST (EventSource só aceita GET); simples de consumir e testar. `/api/chat` foi mantido |
| Erros de conexão antes do stream → HTTP normal; durante → evento `error` | O cliente distingue "não começou" de "falhou no meio" (preserva o texto parcial) |
| Filtro de raciocínio **dentro** do `OllamaClient` | Nenhuma rota consegue repassar raciocínio por engano |
| `OLLAMA_THINK=auto` com detecção de capacidades (`/api/show`) | Separa o raciocínio quando o modelo suporta; não quebra modelos sem raciocínio |
| **Markdown com renderizador próprio** (`markdown/parse.ts` → árvore → React) | Seguro por construção (sem `innerHTML`; o React escapa todo texto), tolerante a texto incompleto (streaming) e sem dependências. Alternativas avaliadas: `react-markdown` (dezenas de pacotes transitivos) e `marked`+`DOMPurify` (depende de `innerHTML` e de sanitização correta) |
| Painel como **widget embutível** (`mountAiGerpro`) + build IIFE | Integração independente de tecnologia: o Gerpro só precisa incluir **um** `<script>` (o CSS vai embutido). Instância única: um segundo `mount()` reaproveita a existente |
| Painel permanece montado quando fechado | Preserva a conversa e a geração em andamento; abrir/fechar não recarrega nada |
| **Shadow DOM** (`<ai-gerpro-widget>`, Etapa 4.1) + prefixo `.gia-` | O CSS do hospedeiro não alcança o widget (nem com `!important`) e o do widget não vaza. O CSS é injetado no shadow root; tamanhos em `px` (o `font-size` da raiz da página não altera o widget) |

## Backend (`backend/src`)

| Arquivo | Responsabilidade |
|---|---|
| `server.ts` | Entrada: config, dependências, pré-carga do modelo, desligamento gracioso |
| `app.ts` | `buildApp(deps)`: Fastify, erros, 404, CORS opcional, rotas |
| `config/env.ts` | Configuração tipada e validada (inclui `APP_ENV`, `OLLAMA_THINK/KEEP_ALIVE/NUM_CTX/PRELOAD`) |
| `ollama/client.ts` | `OllamaClient`: `health`, `preload`, `chat`, `openChatStream`; timeout total, cancelamento, classificação de erros |
| `ollama/reasoning.ts` | `stripReasoning` (resposta completa) e `ReasoningStreamFilter` (streaming) |
| `ollama/system-prompt.ts` | Regras do assistente (dados, referências jurídicas, prazos, limitação) + concisão |
| `routes/chat.ts` | `/api/chat` e `/api/chat/stream` com validação compartilhada |
| `routes/health.ts` | Públicos e mínimos: `/api/health` (estado + limites do chat) e `/api/health/ollama` (em cache por 5 s). Interno: `/api/health/details` (token administrativo ou loopback sem proxy) |
| `errors.ts` | Mapeamento de erros para HTTP / evento de stream; mensagens ao navegador sempre genéricas (detalhes técnicos só no log) |
| `contracts/api.ts` | Tipos públicos (inclui `ChatStreamEvent`); espelhados em `frontend/src/api/types.ts` |
| `adapters/vector-store.ts`, `graph-store.ts` | Contratos **somente leitura** (Etapa 3.1: `upsert`/`delete`/`write` e Cypher livre removidos) |
| `adapters/qdrant.ts`, `neo4j.ts` | Conectores reais; `cypher-guard.ts` valida as consultas autorizadas |
| `embeddings/provider.ts` | `EmbeddingProvider` (Ollama local; modelo explícito, sem padrão) |
| `auth/context.ts` | `AuthContext`, `AuthContextResolver` (`none` / `jwt-hs256`) |
| `retrieval/*` | Mapeamento, orquestração (`service.ts`), contexto/citações (`grounding.ts`), montagem (`bootstrap.ts`) e resolução de continuações (`context-resolver.ts`, Etapa 3.2: identificadores só do texto do usuário, sem estado no servidor, ambiguidade → pedido de esclarecimento) |

### Fluxo de `/api/chat/stream`

1. AJV valida o corpo (mesmo schema do `/api/chat`); a rota exige última mensagem do usuário e nenhuma em branco.
   Com recuperação configurada: resolve o `AuthContext` (credencial inválida → 401) e consulta as bases em paralelo,
   com prazo (`RETRIEVAL_TIMEOUT_MS`). Falhas das bases não interrompem a resposta: viram `grounding: "unavailable"`.
2. Antepõe o `SYSTEM_PROMPT`, insere o contexto das fontes (se houver) antes da pergunta e chama `openChatStream`. Se o Ollama estiver inacessível ou retornar erro HTTP,
   a resposta é um erro HTTP normal (503/502/504).
3. Envia `start`, `sources` (só com recuperação configurada) e repassa os eventos do cliente: `thinking` (uma vez,
   sem texto), `delta` (texto visível) e `done` (com `grounding` e `citations`).
4. Se o navegador desconectar (botão **Interromper**, painel fechado com a aba encerrada etc.), o `AbortController`
   da requisição é acionado. O fetch ao Ollama é abortado e o Ollama cancela a geração; isso foi verificado no
   log do Ollama (`stop: cancel task`).
5. O timeout (`OLLAMA_TIMEOUT_MS`) cobre toda a resposta, incluindo o raciocínio.

### Modelo padrão

| | Modelo | Observação |
|---|---|---|
| **Padrão** (Etapa 2.1) | `qwen3:4b-instruct-2507-q4_K_M` | Sem raciocínio obrigatório; 1º token em ~40 ms, total mediano ~1,7–2,3 s |
| Alternativa instalada | `qwen3:4b` (= `4b-thinking-2507-q4_K_M`) | Sempre raciocina; 7–30 s por resposta. Usar com `OLLAMA_MODEL=qwen3:4b` |

A troca é só de configuração; nenhum código depende do modelo. Os dois modelos declaram a capacidade `thinking`
no Ollama, por isso **`OLLAMA_THINK` deve permanecer `auto`**: com `false`, o filtro de raciocínio retém a resposta
inteira e o streaming se perde, o que foi verificado com o instruct.

### Raciocínio (nunca exposto)

O `qwen3:4b` alternativo é uma variante que **sempre raciocina**: o template do Ollama abre `<think>` por conta
própria. O instruct padrão não raciocina, mas passa pelo mesmo filtro, sem custo.

| `OLLAMA_THINK` | Parâmetro enviado | Filtro | Efeito |
|---|---|---|---|
| `auto` (padrão) | `think: true` se o modelo tem a capacidade `thinking`; senão omitido | `leading-tag` | O Ollama separa o raciocínio em `message.thinking`, que é descartado; o texto visível chega em streaming |
| `true` | `think: true` | `leading-tag` | Igual ao anterior; erro em modelos sem suporte |
| `false` | `think: false` | `until-close` em modelos com raciocínio | O raciocínio vaza em `content` até um `</think>` órfão; o filtro **retém tudo** até essa marca. Seguro, mas sem streaming antecipado |

Ao navegador chega só o evento `thinking` (fase), usado no indicador "Analisando a pergunta…".

## Latência — histórico da Etapa 2 com o `qwen3:4b` (RTX 4070 SUPER, 100% GPU)

Medido com `npm run bench` (streaming, 2 perguntas × 2 execuções):

| Cenário | Carga | 1º token | 1ª resposta visível | Total | Tokens gerados |
|---|---|---|---|---|---|
| Carga a frio (modelo descarregado) | 2,5 s | 2,6 s | 15,3 s | 16,1 s | ~1.650 |
| Aquecido, prompt sem concisão | 0 | 0,1 s | 13,0 s | 13,8 s | ~1.780 |
| Aquecido, **prompt conciso (adotado)** | 0 | 0,1 s | **10,0 s** | **10,6 s** | ~1.360 |
| `num_ctx` 8192 (1ª chamada recarrega) | 0,9 s | 1,0 s | 13,7 s | 14,3 s | ~1.770 |

Conclusões:

- **Cerca de 95% do tempo é raciocínio.** A resposta visível tem cerca de 100 tokens; o raciocínio, de 1.300 a 1.800.
  A geração a 130 tok/s mostra que o hardware não é o gargalo.
- **Adotado sem trocar o modelo:**
  - instrução de concisão no prompt (cerca de 25% mais rápido);
  - `keep_alive=30m` e pré-carga na partida (elimina 2,5 s na 1ª pergunta e após inatividade);
  - `num_ctx=8192`, para não truncar histórico e prompt de sistema com o raciocínio longo. Não altera a velocidade;
  - indicador de fase com cronômetro para a espera percebida.
- **Testado e descartado:** "prefill" de bloco `<think></think>` vazio (com `raw`) para pular o raciocínio. Essa
  variante do modelo raciocina de qualquer forma, dentro da resposta.
- **Streaming** melhora a percepção só depois do raciocínio. O tempo até o 1º texto visível continua dominado por ele.
- **Etapa 2.1 (aprovada):** o `qwen3:4b-instruct-2507-q4_K_M` passou a ser o padrão: 1º token em ~40 ms e total ~4×
  menor, com a mesma VRAM. Detalhes em [BENCHMARK-MODELOS.md](BENCHMARK-MODELOS.md). A tabela acima registra o
  histórico medido com o `qwen3:4b`.

## Regras jurídicas do prompt de sistema

Desde a Etapa 2.1, o prompt de sistema (`backend/src/ollama/system-prompt.ts`) determina:

1. **Não citar** números de artigos, leis, súmulas, precedentes, julgados ou outras referências numeradas. Nesta
   versão não há fontes verificadas.
2. **Exceção:** o modelo pode analisar um texto (dispositivo, decisão, documento) **fornecido pelo próprio usuário** na
   conversa, deixando claro que se baseia nele.
3. **Não apresentar** prazos processuais, obrigações legais ou interpretações específicas como fatos confirmados; não
   informar números de prazos, percentuais ou valores legais; evitar conclusões categóricas.
4. **Reconhecer a limitação** quando faltar informação, em vez de inventar.
5. **Não criar** exemplos ou versões "fictícias" com números, nomes ou partes informados pelo usuário.
6. **Preservar** a conversa natural e as respostas gerais em português.

O prompt inclui um exemplo de resposta adequada a uma pergunta de prazo (few-shot) e uma checagem final curta.
Os testes em `backend/test/system-prompt.test.ts` impedem a remoção acidental dessas regras.

### Limites das regras de prompt

> **Regras de prompt são medidas auxiliares, não garantias contra alucinações.** O modelo pode descumpri-las, e o
> comportamento varia entre execuções da mesma pergunta.

Resultados medidos com o modelo padrão (`npm run bench:models`, 5 execuções por pergunta jurídica):

| Medida | Antes das regras | Depois das regras |
|---|---|---|
| Respostas jurídicas sem citação numerada | 8 de 20 (12 citações inventadas) | **22 de 25** |
| Respostas jurídicas com ressalva ("orientação geral, conferir…") | parcial | **23 de 25** |
| Pergunta direta de prazo sem número | 0 de 2 | **0 de 5**: o modelo reconhece a limitação, mas ainda informa um número "de forma geral", errado em 3 de 5 |
| Recusa em processos/contratos/clientes e tentativas de indução | 100% | **100%** |
| Conversa geral e português | ✔ | ✔ (verificado manualmente) |

Consequências:

- A interface mantém o aviso permanente de que as respostas podem conter erros. Sem recuperação ativa, ele diz que não há
  acesso a dados do Gerpro; com recuperação, que as respostas usam somente as fontes indicadas (Etapa 3.2).
- **Nenhuma resposta jurídica do assistente deve ser usada sem conferência** na legislação oficial ou por advogado.
- A Etapa 3.1 preparou a recuperação de fontes (RAG com Qdrant/Neo4j) e a conferência dos marcadores `[Q1]`/`[N1]`
  citados (`citations.unknown`). Isso depende da configuração das bases reais. Não há validação jurídica do
  conteúdo, e as fontes **reduzem**, mas não eliminam, as alucinações.

## Frontend (`frontend/src`)

| Arquivo | Responsabilidade |
|---|---|
| `api/client.ts` | `createChatApi`: `sendChat`, `streamChat` (gerador assíncrono NDJSON), `getOllamaHealth`; erros como `ApiError`; `getAuthToken` opcional (`Authorization: Bearer`) |
| `markdown/parse.ts` | Parser Markdown → árvore de dados (sem HTML); links só http/https/mailto; imagens viram links |
| `components/Markdown.tsx` | Árvore → elementos React (sem `dangerouslySetInnerHTML`); marcadores `[Q1]`/`[N1]` viram botão só se a fonte veio nesta resposta |
| `components/SourceList.tsx` + `sources/model.ts` | Fontes da resposta (Etapa 3.2): bloco recolhido, Qdrant × Neo4j, detalhes seguros, aviso de marcador inexistente |
| `components/ChatPanel.tsx` | Chat: streaming, indicador de fase + cronômetro, **Interromper**, texto parcial preservado, status do modelo |
| `components/ChatLauncher.tsx` | Botão no canto esquerdo + painel deslizante; controlado/não controlado; Esc; gestão de foco; `inert` quando fechado |
| `embed.tsx` | `mountAiGerpro()` / `window.AIGerpro.mount()`: API `open/close/toggle/isOpen/unmount`, `getAuthToken`, `conversationKey` + `setConversationKey/resetConversation` |
| `main.tsx` + `pagina.html` | Chat em página inteira |
| `index.html` | Página hospedeira de exemplo (HTML puro) usando o widget |

### Comportamento da interrupção

- Antes de qualquer texto: a pergunta volta ao campo e aparece o aviso "Geração interrompida.".
- Com texto parcial: o parcial é mantido e marcado como "Interrompida", e entra no histórico da próxima pergunta.
- Erro no meio do stream: o parcial é mantido como "Resposta incompleta" e a mensagem de erro é exibida.

## Segurança

- Sem dados reais e sem serviços externos. Ollama, Qdrant e Neo4j são acessíveis só pelo backend, e as credenciais
  ficam só no `.env` do backend (nunca no frontend, no mapeamento, em URLs ou em logs; `authorization` é mascarado).
- Conexões com Qdrant e Neo4j exigem TLS fora de localhost. As consultas são só de leitura, e a organização e as
  permissões vêm do `AuthContext` verificado, nunca do navegador.
- Validação estrita de entrada (sem campos extras), limite de corpo de 1 MiB, limites de mensagens configuráveis.
- Markdown sem HTML: esquemas `javascript:`, `data:`, `vbscript:` e disfarçados (com espaços ou controles) são descartados.
- Logs não registram o conteúdo das mensagens.
- O chat em si continua **sem autenticação** (aceitável só no ambiente local de demonstração). As consultas
  corporativas exigem `AuthContext` (padrão `GERPRO_AUTH_MODE=none` = nenhuma consulta).
- O conteúdo recuperado é tratado como dado: é delimitado, saneado e acompanhado de regras contra instruções
  embutidas. Isso é uma mitigação, não uma garantia.
