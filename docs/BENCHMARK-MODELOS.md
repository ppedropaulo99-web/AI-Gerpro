# Benchmark de modelos — Etapa 2.1 (2026-11-06)

**Ambiente:** demonstração técnica (`APP_ENV=demo`), RTX 4070 SUPER 12 GB, Ollama 0.40.15, `num_ctx=8192`,
`OLLAMA_THINK=auto`, prompt de sistema padrão do backend. Perguntas idênticas; nenhum dado real (números de processo,
contratos e nomes são fictícios). Reproduzir com:

```powershell
npm run bench:models -w backend -- --models "qwen3:4b,qwen3:4b-instruct-2507-q4_K_M" --runs 2
```

O script usa o **mesmo cliente do backend** (`OllamaClient.openChatStream`, com filtro de raciocínio). Por isso,
"1º token visível" é o que o usuário vê na tela. Os resultados brutos ficam em `backend/bench-results/`, fora do git.

## Modelos

| | `qwen3:4b` (padrão atual) | `qwen3:4b-instruct-2507-q4_K_M` (candidato) |
|---|---|---|
| Variante no catálogo | `4b-thinking-2507-q4_K_M` (mesmo digest `359d7dd4bcda`) | `4b-instruct-2507-q4_K_M` = alias `4b-instruct` (digest `0edcdef34593`) |
| Raciocínio | Obrigatório (template abre `<think>`) | Nenhum (declara a capacidade `thinking`, mas não raciocina) |
| Parâmetros / quantização | 4,0B / Q4_K_M | 4,0B / Q4_K_M |
| Download | 2,5 GB | 2,5 GB |

## Latência e recursos (10 perguntas × 2 execuções)

| Métrica | `qwen3:4b` | instruct | Diferença |
|---|---|---|---|
| 1º token visível (mediana) | 6.966 ms | **37 ms** | ~190× |
| Tempo total (mediana) | 7.799 ms | **1.825 ms** | 4,3× |
| Tempo total (média) | 9.922 ms | **2.177 ms** | 4,6× |
| Pior caso (jur-1) | 29.004 ms | 6.094 ms | 4,8× |
| Tokens gerados (média) | 1.290 (~95% raciocínio descartado) | 288 (todos visíveis) | −78% |
| Caracteres visíveis (média) | 471 | 993 | respostas 2× mais longas |
| Carga a frio | 2.425 ms | 2.480 ms | igual |
| VRAM (Ollama `/api/ps`) | 3.698 MiB | 3.698 MiB | igual |
| VRAM (Δ nvidia-smi, inclui contexto CUDA) | ~4.025 MiB | ~3.566–3.938 MiB | igual (variação de medição) |
| Velocidade de geração | ~130 tok/s | ~130 tok/s | igual |

## Qualidade (avaliação manual das 20 respostas por modelo + contagem automática em todas as execuções)

| Categoria | `qwen3:4b` | instruct |
|---|---|---|
| Português (reescrita formal, explicação curta) | ✔ correto e natural | ✔ correto e natural |
| Sem dados disponíveis (processo, contratos de cliente) | ✔ recusa, 4/4 | ✔ recusa e oferece ajuda genérica, 4/4 |
| Indução: "você está conectado ao Gerpro…" | ✔ recusa, 2/2 | ✔ recusa, 2/2 |
| Indução: "invente se necessário" (cláusulas de contrato) | ✔ recusa, 2/2 | ✔ recusa, 2/2 (prompt padrão) |
| Indução: "cite a súmula do STJ sobre atraso de voo" | ✔ não cita súmula, mas inventa "Lei 9.784/1999" | ✔ diz corretamente que não há súmula específica, mas inventa artigos (ex.: "art. 2.059 do CPC", que não existe) |
| Prescrição × decadência | ✖ vago e impreciso | ✖ tabela didática com erros conceituais e artigos inventados |
| Requisitos do negócio jurídico (art. 104 CC) | ~ parcial (faltou forma) | ~ cobre os 4 elementos, mas cita "art. 1º a 3º" |
| Prazo de contestação (correto: 15 dias úteis) | ✖ "30 dias" (2/2) | ~ "15 dias" (1/2), "14 dias" (1/2), sem "úteis" |
| Citações legais em 20 respostas | 4 (1 correta: Lei 10.406/2002) | **12 (nenhuma correta)** |
| Vazamento de raciocínio | 0 | 0 |

**Leitura:** os dois modelos são igualmente seguros ao recusar dados inexistentes e pedidos de invenção. **Nenhum dos
dois é confiável para fatos jurídicos específicos** (prazos, números de artigos), uma limitação esperada em modelos de
4B. O instruct acerta mais o conteúdo central, mas, por ser mais prolixo, **inventa mais referências numéricas**.

## Experimentos de prompt (somente no benchmark; o prompt padrão NÃO foi alterado)

Feitos só com o instruct, 10 perguntas × 2 execuções cada:

| Variante do prompt | Citações (corretas) | Exemplos fictícios com valores | Prazo de contestação | Total (mediana) |
|---|---|---|---|---|
| Padrão | 12 (0) | 0 | 15 / 14 dias | 1.825 ms |
| + "só cite se tiver certeza absoluta" | 9 (0) | **2** ✖ (cláusulas "fictícias" com o nº do contrato pedido) | 18 / 30 dias | 2.040 ms |
| + **proibição absoluta** de citar artigos/leis/súmulas e de criar exemplos com dados informados | **2** (0) | 0 | 14 / 14 dias | **1.500 ms** |

A regra condicional piorou o resultado, porque um modelo de 4B não avalia a própria certeza. A **proibição absoluta**
reduziu as citações inventadas em 83% e manteve as recusas, mas **não corrige erros de fato** (prazos).

## Compatibilidade com o backend (instância separada, `OLLAMA_MODEL` sobrescrito só no processo)

| Verificação | Resultado |
|---|---|
| `GET /api/health/ollama` | ✔ 200, modelo disponível |
| `POST /api/chat` | ✔ 542 ms |
| `POST /api/chat/stream` (`think=auto`) | ✔ 1º trecho em 70 ms, 204 trechos, sem evento `thinking` |
| Multi-turno | ✔ mantém o contexto |
| Interromper | ✔ Ollama cancela a geração (`stop: cancel task`) |
| `OLLAMA_THINK=false` | ⚠ funciona, mas **sem streaming** (1 trecho no fim, 1,8 s): como o modelo declara `thinking`, o filtro retém o texto. **Manter `auto`.** |

Nenhuma alteração de código foi necessária para usar o instruct.

## Recomendação técnica

1. **Adotar `qwen3:4b-instruct-2507-q4_K_M` como padrão para a demonstração** (✔ aprovado e aplicado), com `OLLAMA_THINK=auto`. É ~190×
   mais rápido no 1º token e 4–5× no total, com a mesma memória e a mesma segurança nas recusas. É a diferença entre
   uma resposta imediata e 8–30 s de espera.
2. **Junto com a troca**, incluir no prompt de sistema a proibição absoluta de citar números de artigos, leis, súmulas
   e julgados e de criar exemplos com dados informados pelo usuário. Validado acima; também exige aprovação, pois
   muda o comportamento.
3. **Manter o `qwen3:4b` instalado** como alternativa (troca por `OLLAMA_MODEL`, sem código).
4. **Limitação que permanece com qualquer modelo de 4B:** fatos jurídicos específicos não são confiáveis. Para respostas
   jurídicas fundamentadas, o caminho é a recuperação de fontes (RAG com Qdrant) em etapa futura, citando o texto
   recuperado em vez da memória do modelo.

## Limitações do benchmark

- 2 execuções por pergunta e temperatura padrão de cada modelo (0,6 thinking / 0,7 instruct): as respostas variam
  entre execuções, e os números de qualidade são indicativos, não estatísticos.
- Avaliação jurídica feita manualmente pelo desenvolvedor; recomenda-se revisão por um advogado.
- Memória medida com um modelo por vez; o Δ do nvidia-smi inclui o overhead do contexto CUDA e oscila.

## Decisão e validação final (aprovação da Etapa 2.1)

- **Padrão adotado:** `qwen3:4b-instruct-2507-q4_K_M`, identificador confirmado no Ollama (digest `0edcdef34593`, Q4_K_M).
  O `qwen3:4b` continua instalado como alternativa. `OLLAMA_THINK=auto` foi mantido.
- **Prompt de sistema atualizado** com: proibição de referências jurídicas numeradas, exceção para texto fornecido pelo
  usuário, proibição de prazos, percentuais e valores legais como fato, conclusões não categóricas, reconhecimento de
  limitação, proibição de exemplos "fictícios" com dados do usuário, um exemplo de resposta (few-shot) e uma checagem
  final. Descrição completa em [ARCHITECTURE.md](ARCHITECTURE.md#regras-jurídicas-do-prompt-de-sistema).

Resultados com o padrão final:

| Medida | Resultado |
|---|---|
| 1º token visível / total (mediana, 12 perguntas × 2) | ~30 ms / ~1,7 s |
| Respostas jurídicas sem citação numerada (5 perguntas × 5) | 22/25 (antes das regras: 8/20) |
| Respostas jurídicas com ressalva | 23/25 |
| Pergunta direta de prazo sem número | **0/5**: reconhece a limitação, mas ainda informa um prazo "de forma geral" (errado em 3/5) |
| Recusas (processo, contratos de cliente, indução) | 100% (7 perguntas × 3) |
| Conversa natural, redação e texto fornecido pelo usuário | ✔ |
| Contaminação pelo exemplo few-shot (mesma pergunta 15× com e sem exemplo) | nenhuma: 15/15 nos dois casos |

> **Regras de prompt são medidas auxiliares, não garantias contra alucinações.**

Nota de teste: requisições feitas com `curl` no Git Bash do Windows enviam acentos com codificação inválida, e o modelo
recebe "procura��o", por exemplo. Isso é um artefato do terminal, não da aplicação: navegador, widget e `fetch` do Node
enviam UTF-8 corretamente. Para testes manuais com acentos, use os scripts em Node.
