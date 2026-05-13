# pi-packages

Coleção de pacotes e extensões para o [Pi coding agent](https://pi.dev).

## Pacotes

### pi-memory

Extensão que persiste todo o histórico de conversas do Pi em SQLite+FTS5 e expõe a ferramenta `session_search` para busca textual entre sessões.

**Instalação:**

```bash
pi install git:https://github.com/ericnunes30/pi-packages
```

**Uso:** Após instalar, a ferramenta `session_search` fica disponível para o LLM automaticamente.

```bash
# Exemplo: buscar por "docker" nas conversas anteriores
# (o LLM usa session_search automaticamente quando perguntado)
```

**Migração de sessões existentes:**

```bash
npx tsx tools/pi-session-migration/src/importer.ts
```

### Estrutura do repositório

```
pi-packages/
├── extensions/
│   └── pi-memory/        ← Extensão Pi (auto-descoberta)
├── tools/
│   └── pi-session-migration/  ← CLI para importar sessões existentes
├── package.json          ← Manifesto Pi Package
└── README.md
```
