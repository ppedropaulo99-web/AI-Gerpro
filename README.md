# AI Gerpro

Assistente de IA **independente**, executado localmente com [Ollama](https://ollama.com), preparado para
integração futura ao sistema jurídico Gerpro como **painel lateral**.

> **Ambiente:** demonstração técnica (`APP_ENV=demo`), sem dados reais. O ambiente aparece no diagnóstico interno
> (`GET /api/health/details`) e nos logs, não no título do assistente. Em homologação/produção, `APP_ENV` ativa o
> **modo corporativo** (chat só com autenticação, JWT com emissor/audiência, TLS verificado): ver
> [docs/HANDOFF.md](docs/HANDOFF.md#4-implantação-homologação-e-produção).
>
> **Bases corporativas (Etapa 3.1):** os conectores somente leitura para **Qdrant** e **Neo4j** estão prontos, mas
> **não configurados**. Sem configuração, o assistente usa só o Ollama, como antes. Para configurar, veja
> [docs/INTEGRACAO-RECUPERACAO.md](docs/INTEGRACAO-RECUPERACAO.md).

> **Equipe da Cognitiva:** comece por [docs/HANDOFF.md](docs/HANDOFF.md) (arquitetura, instalação, integração,
> testes e pendências).

## Integração com o Gerpro Studio (versão exigida)

O Gerpro Studio executa este backend, compilado, na aba Gerpro IA. Para essa integração:

- **Branch:** `feature/require-contextual-sources`. A `main` **não** serve.
- **Commit mínimo:** `14dca31c610c435ac6abfbbc0fd156d2d040adcb` ("feat: require retrieval sources for
  contextual AI responses"), ou posterior na mesma branch.
- **`RETRIEVAL_REQUIRE_SOURCES=true` é obrigatório.** O Studio define a variável ao iniciar o backend e
  **recusa** um pacote que não confirme a garantia: sem fontes recuperadas, o modelo não é chamado e a
  resposta é um texto fixo de insuficiência de informações. Não desative a variável na integração.

Validação antes da entrega (num clone limpo):

```powershell
git clone -b feature/require-contextual-sources <URL-do-repositorio-privado> C:\dev\AI-Gerpro
cd C:\dev\AI-Gerpro
git branch --show-current                     # feature/require-contextual-sources
git status --short                            # vazio
git merge-base --is-ancestor 14dca31c610c435ac6abfbbc0fd156d2d040adcb HEAD; $?   # True
npm ci
npm run typecheck
npm test                                      # inclui backend/test/require-sources.test.ts
npm run build
```

Todos os comandos devem terminar sem erro. A compilação e a montagem do pacote para o Studio, a
configuração das bases e os testes de conectividade estão no `docs/16-gerpro-ia.md` do Gerpro Studio
(seções 4, 12 e 14). Resumo e detalhes deste repositório: [docs/HANDOFF.md](docs/HANDOFF.md#integração-com-o-gerpro-studio).

## Requisitos

- Node.js ≥ 24 (testado com 26.13) e npm
- Ollama em execução local com o modelo padrão: `ollama pull qwen3:4b-instruct-2507-q4_K_M`
  (alternativa opcional: `qwen3:4b`, mais lenta por sempre raciocinar; selecione com `OLLAMA_MODEL`)

> **Atenção:** o assistente usa regras no prompt para não citar artigos, leis, súmulas ou prazos sem fonte verificada.
> Essas regras são **medidas auxiliares, não garantias**: as respostas podem conter erros e devem ser conferidas.
> Ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#limites-das-regras-de-prompt).

## Instalação

```powershell
git clone <URL-do-repositorio-privado> "C:\IA Gerpro"   # ou copie a pasta do projeto
cd "C:\IA Gerpro"
npm ci                                  # versões exatas do package-lock.json
Copy-Item .env.example backend\.env     # opcional; sem ele valem os padrões
```

`backend/.env` e `backend/retrieval.config.json` guardam configuração local e **nunca** são versionados.

## Executar em desenvolvimento

Dois terminais:

```powershell
npm run dev:backend    # http://127.0.0.1:3001  (API; pré-carrega o modelo na GPU)
npm run dev:frontend   # http://127.0.0.1:5173  (interface; /api é repassado ao backend)
```

| Página | Conteúdo |
|---|---|
| http://127.0.0.1:5173/ | Página hospedeira de exemplo com o **botão AI Gerpro no canto inferior esquerdo** e o painel lateral |
| http://127.0.0.1:5173/pagina.html | Chat em página inteira (interface da Etapa 1) |

No painel: **Esc** ou **×** fecha; a conversa é preservada ao fechar e reabrir. Durante a geração, o botão
**Interromper** cancela a resposta e o backend encerra a geração no Ollama.

## Scripts (na raiz)

| Comando | O que faz |
|---|---|
| `npm run typecheck` | Checagem de tipos de backend e frontend |
| `npm test` | Testes automatizados (não chamam o Ollama real) |
| `npm run build` | Compila backend (`backend/dist`), páginas (`frontend/dist`) e widget (`frontend/dist-widget`) |
| `npm run build:widget` | Só o widget embutível |
| `npm run smoke` | Pergunta real ao Ollama, sem servidor HTTP |
| `npm run bench` | Benchmark de latência contra o Ollama real (ver docs/ARCHITECTURE.md) |
| `npm run bench:models -w backend -- --models "a,b"` | Benchmark comparativo de modelos: latência, VRAM e qualidade (ver docs/BENCHMARK-MODELOS.md) |
| `npm run check:retrieval -w backend` | Diagnóstico de Qdrant, Neo4j, embeddings e mapeamento, sem segredos (ver docs/INTEGRACAO-RECUPERACAO.md) |
| `npm run test:integration -w backend` | Testes opcionais contra serviços de teste autorizados (ignorados sem `INTEGRATION_RETRIEVAL=true`) |

Build de produção do backend: `npm start -w backend`.

## Embutir em outra página (widget)

`npm run build:widget` gera **um único arquivo**, `frontend/dist-widget/ai-gerpro.js` (React e CSS embutidos). Ele
funciona em qualquer página HTML; o sistema hospedeiro não precisa usar React. O widget roda em **Shadow DOM**
(`<ai-gerpro-widget>`): o CSS da página não o altera e o CSS dele não vaza para a página.

```html
<script src="ai-gerpro.js?v=0.1.0"></script>
<script>
  const ai = AIGerpro.mount({ apiBaseUrl: "http://127.0.0.1:3001/api" });
  // ai.open(); ai.close(); ai.toggle(); ai.isOpen(); ai.unmount();
  // ai.setConversationKey("usuario:organizacao"); ai.resetConversation();  // troca de sessão no Gerpro
  // Para usar um botão próprio do hospedeiro: AIGerpro.mount({ showLauncher: false, ... })
  // AIGerpro.version informa a versão carregada. Um segundo mount() sem unmount() reaproveita a instância.
</script>
```

Se a página for servida por outra origem, configure `CORS_ORIGIN` no backend com essa origem.

Para consultas às bases corporativas, o hospedeiro informa `getAuthToken: () => tokenEmitidoPeloBackendDoGerpro`.
O token vai em `Authorization: Bearer`, e a identidade e as permissões são verificadas no servidor. Sem token, o
assistente responde normalmente, sem consultar as bases, **exceto** com `CHAT_REQUIRE_AUTH=true` (obrigatório em
modo corporativo), quando o chat recusa requisições sem token válido (401).

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/health` | **Público e mínimo**: `status`, `version` e limites do chat (`chat.maxMessages`, `chat.maxCharsPerMessage`). Não consulta as bases |
| GET | `/api/health/ollama` | **Público e mínimo**: `status` (200 = ok; 503 = degradado/indisponível), `model`, `latencyMs`. Sem URLs nem versões; em cache por 5 s |
| GET | `/api/health/details` | **Diagnóstico interno**: ambiente, Ollama, Qdrant, Neo4j, embeddings e avisos. Exige `DIAGNOSTICS_TOKEN` ou conexão direta de loopback sem proxy; senão 403 |
| POST | `/api/chat` | Resposta completa: `{ "messages": [{ "role": "user", "content": "..." }] }` |
| POST | `/api/chat/stream` | Mesma entrada; resposta em **NDJSON** (um evento JSON por linha) |

As respostas com recuperação mostram, de forma compacta, as **fontes consultadas** (Qdrant e Neo4j) e marcam
citações `[Q1]`/`[N1]` inexistentes. Perguntas de continuação ("quem é o responsável por ele?") reaproveitam o
identificador que o usuário informou antes. Ver docs/INTEGRACAO-RECUPERACAO.md, seções 7A e 7B.

Eventos do stream: `start` → `sources` (só com recuperação configurada) → `thinking` (só indica a fase, **sem** o
conteúdo do raciocínio) → `delta`* → `done` ou `error`. As respostas trazem `grounding` (`disabled`, `sources`,
`no_sources`, `unavailable`, `unauthorized`, `ambiguous`), `citations` e `resolution`.

Erros fora do stream seguem o formato `{ "error": { "code", "message" } }`:

| Situação | HTTP | `code` |
|---|---|---|
| Entrada inválida (inclui campos além de `messages`) | 400 | `bad_request` |
| Credencial do Gerpro inválida/expirada, ou ausente com `CHAT_REQUIRE_AUTH` | 401 | `unauthorized` |
| Diagnóstico interno sem autorização | 403 | `forbidden` |
| Ollama inacessível | 503 | `llm_unavailable` |
| Timeout (`OLLAMA_TIMEOUT_MS`) | 504 | `llm_timeout` |
| Erro do Ollama (ex.: modelo ausente) | 502 | `llm_upstream_error` |
| Resposta malformada/vazia | 502 | `llm_invalid_response` |

No stream, falhas após o início chegam como `{"type":"error","error":{...}}` com os mesmos códigos. As mensagens
enviadas ao navegador são genéricas: endereços internos, portas e detalhes do Ollama ficam só no log do servidor.

## Configuração

Veja [`.env.example`](.env.example): `APP_ENV`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`, `OLLAMA_THINK`, `OLLAMA_KEEP_ALIVE`,
`OLLAMA_NUM_CTX`, `OLLAMA_PRELOAD`, `CHAT_MAX_*`, `CORS_ORIGIN`, `LOG_LEVEL`, `CHAT_REQUIRE_AUTH`, `DIAGNOSTICS_TOKEN` e
`DIAGNOSTICS_ALLOW_LOOPBACK`. As variáveis opcionais de recuperação são
`QDRANT_*`, `NEO4J_*`, `EMBEDDINGS_*`, `RETRIEVAL_*` e `GERPRO_AUTH_*`. O mapeamento de coleções e consultas fica
em um JSON separado (modelo: `backend/retrieval.config.example.json`).

## Estrutura

```
backend/   API Node.js + TypeScript (Fastify): único ponto de acesso ao Ollama, ao Qdrant e ao Neo4j
frontend/  React + TypeScript + Vite: ChatPanel, painel lateral (ChatLauncher) e widget (embed)
docs/      Documentação (HANDOFF, arquitetura, integração, benchmark)
```

Detalhes em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) e [docs/INTEGRACAO-RECUPERACAO.md](docs/INTEGRACAO-RECUPERACAO.md).
