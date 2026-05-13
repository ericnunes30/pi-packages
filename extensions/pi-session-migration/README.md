# pi-session-migration

CLI migrator that imports existing Pi JSONL session files from `~/.pi/agent/sessions/`
into the `pi-session-memory` SQLite database (`~/.pi/session-memory/memory.db`).

## Usage

```bash
# Run with npm script
npm run migrate

# Or run directly with tsx
npx tsx src/importer.ts

# Or use the binary (if installed globally)
pi-session-migrate
```

## How it works

1. **Scans** `~/.pi/agent/sessions/` recursively for `.jsonl` files
2. **Parses** each JSONL file — header + entries linked by `id`/`parentId`
3. **Traverses** the entry tree to reconstruct original message order
4. **Imports** messages into the SQLite database via `SessionStore` API
5. **Skips** already-imported sessions (idempotent — checks `getSessionMessages`)
6. **Reports** progress, statistics, and any errors

## Design

- All operations are synchronous (matches `SessionStore`'s `DatabaseSync` pattern)
- Progress is written to stderr; final report to stdout
- Error-tolerant: per-session errors are logged and the migration continues
- Zero external dependencies (uses only Node.js built-ins and `pi-session-memory`)