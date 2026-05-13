# pi-packages

Coleção de pacotes e extensões para o [Pi coding agent](https://pi.dev).

## Instalação

```bash
pi install git:https://github.com/ericnunes30/pi-packages
```

O Pi descobre automaticamente todas as extensões em `extensions/`.

## Extensões

### pi-memory

Persiste todo o histórico de conversas do Pi em SQLite+FTS5 e expõe a ferramenta `session_search` para busca textual entre sessões.

### pi-session-migration

CLI para importar sessões existentes (formato JSONL v3) para o banco SQLite.

```bash
cd extensions/pi-session-migration
npx tsx src/importer.ts
```

## Estrutura

```
pi-packages/
├── extensions/
│   ├── pi-memory/               ← Extensão de memória persistente
│   │   ├── index.ts
│   │   ├── package.json
│   │   ├── src/                 ← Event hooks + SQLite + tools
│   │   └── test/                ← 31 testes unitários
│   └── pi-session-migration/    ← CLI de migração
│       ├── package.json
│       ├── README.md
│       └── src/
│           └── importer.ts
├── package.json                 ← Manifesto Pi Package
├── .gitignore
└── README.md
```
