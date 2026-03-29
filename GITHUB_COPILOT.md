# Prism MCP with GitHub Copilot via Docker Compose on a Remote Server

This guide covers one setup only:

- a remote server runs this repository's checked-in [docker-compose.yml](docker-compose.yml)
- VS Code on your laptop connects to Prism over `ssh`
- Copilot still talks to Prism over stdio, but the stdio process is started on the remote server

The important detail is that Copilot should not connect to a long-running TCP MCP endpoint here. Instead, your laptop launches a remote one-off `prism` container through `ssh`, and that container uses the same Compose network, environment, and volumes as the rest of the stack.

Prism now also supports an opt-in Streamable HTTP endpoint for clients that need HTTP MCP, but this guide remains stdio-first for GitHub Copilot. For Copilot, keep using the one-off `docker compose run --rm -T prism` model below unless you have a separate client that explicitly requires HTTP transport.

## Server-side setup

Run these steps on the server where Docker is installed.

1. Clone the repository on the server.

2. Copy the environment template:

```bash
cp .env.example .env
```

3. Start PostgreSQL and PostgREST on the server:

```bash
docker compose up -d db rest
```

4. Apply the SQL migrations on the server:

```bash
cat supabase/migrations/*.sql | docker compose exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Use `POSTGRES_USER` and `POSTGRES_DB` here, not `PRISM_DB_USER` and `PRISM_DB_NAME`. The `db` container exports the PostgreSQL variables, and using the Prism variable names can fall back to the container user and produce `role "root" does not exist`.

### How to check that the migrations are done

Run this on the server:

```bash
docker compose exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -x -c "
SELECT
  to_regclass('"'"'public.session_ledger'"'"') AS session_ledger,
  to_regclass('"'"'public.session_handoffs'"'"') AS session_handoffs,
  to_regclass('"'"'public.prism_schema_versions'"'"') AS prism_schema_versions,
  to_regprocedure('"'"'public.get_session_context(text,text,text,text)'"'"') AS get_session_context,
  to_regprocedure('"'"'public.prism_apply_ddl(integer,text,text)'"'"') AS prism_apply_ddl,
  to_regprocedure('"'"'public.prism_purge_embeddings(text,text,integer,boolean)'"'"') AS prism_purge_embeddings;
"'
```

If migration setup is complete, those values should resolve to real table and function names instead of empty values.

You can also inspect the migration tracker created by the migration infrastructure:

```bash
docker compose exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -x -c "
SELECT version, name, applied_at
FROM prism_schema_versions
ORDER BY version;
"'
```

At minimum, expect versions `15` through `27`. If Prism has already started successfully after that, you may also see later auto-applied versions.

5. Do not rely on a separately started long-running `prism` container for Copilot.

For Copilot, use `docker compose run --rm -T prism` through `ssh` so each MCP session gets a dedicated stdio-connected process.

## Why this works

- `db` and `rest` stay up on the server as normal Compose services.
- Each Copilot session starts its own `prism` container on the server through `docker compose run`.
- The `prism` entrypoint maps `PRISM_SUPABASE_URL`, `PRISM_SUPABASE_API_PREFIX`, and `PRISM_SUPABASE_KEY` into the `SUPABASE_*` variables the Node server reads.
- The Compose stack uses raw PostgREST, so `SUPABASE_API_PREFIX` is intentionally blank in `.env.example` for this setup.
- Prism state persists in the `prism_state` named volume on the server.

## Prerequisites on your laptop

- VS Code with GitHub Copilot MCP support enabled.
- SSH access from your laptop to the server.
- Key-based SSH auth is strongly recommended so Copilot can start the remote command without interactive password prompts.
- The server must have Docker Compose available from the remote shell used by `ssh`.

Examples below assume:

- server host: `user@example-server`
- repository path on the server: `/srv/prism-mcp`

Replace both values with your real host and path.

## GitHub Copilot in VS Code

Create `.vscode/mcp.json` on your laptop with an `ssh`-backed server command:

```json
{
  "servers": {
    "prism-mcp": {
      "command": "ssh",
      "args": [
        "user@example-server",
        "cd /srv/prism-mcp && docker compose run --rm -T prism"
      ]
    }
  }
}
```

This keeps the MCP transport on stdio while moving the actual Prism process to the remote server.

### Verify in Copilot

1. Open the command palette and run `MCP: List Servers`.
2. Confirm `prism-mcp` is listed and running.
3. Open Copilot Chat in `Agent` mode.
4. Confirm Prism tools are visible.

If startup fails, test the same SSH command in a normal terminal on your laptop first.

## Optional dashboard access from your laptop

The MCP connection itself does not need any forwarded ports. If you want to open the dashboard in your browser on the laptop, use an SSH tunnel.

1. Start a tunnel from your laptop:

```bash
ssh -L 3001:127.0.0.1:3001 user@example-server
```

2. Change the MCP command to publish the service port when Prism is started:

```json
{
  "servers": {
    "prism-mcp": {
      "command": "ssh",
      "args": [
        "user@example-server",
        "cd /srv/prism-mcp && docker compose run --rm -T --service-ports prism"
      ]
    }
  }
}
```

3. Open `http://localhost:3001` on your laptop while the MCP server is running.

Use the `--service-ports` variant only if you actually want the dashboard. It is not required for Copilot to use Prism tools.

## GitHub Copilot CLI

If you also use GitHub Copilot CLI on your laptop, use the same remote-SSH pattern.

### Interactive setup

Run inside Copilot CLI:

```text
/mcp add
```

Use these values:

- Server name: `prism-mcp`
- Server type: `STDIO` or `Local`
- Command: `ssh user@example-server 'cd /srv/prism-mcp && docker compose run --rm -T prism'`
- Tools: `*`

### Config file setup

Add this to `~/.copilot/mcp-config.json` on your laptop:

```json
{
  "mcpServers": {
    "prism-mcp": {
      "type": "local",
      "command": "ssh",
      "args": [
        "user@example-server",
        "cd /srv/prism-mcp && docker compose run --rm -T prism"
      ],
      "tools": ["*"]
    }
  }
}
```

### Verify in Copilot CLI

```text
/mcp show
/mcp show prism-mcp
```

## Practical notes

- Keep `db` and `rest` running on the server with `docker compose up -d db rest`.
- Re-run the migrations if you reset the database volume.
- If you change `.env` on the server, recreate the affected services before testing again.
- `docker compose down` keeps the server-side volumes. `docker compose down -v` removes them.
- If the remote shell does not load Docker in `PATH`, use the full command path in your SSH command.
- To run the migration check from your laptop, wrap the same commands with `ssh user@example-server 'cd /srv/prism-mcp && ...'`.
