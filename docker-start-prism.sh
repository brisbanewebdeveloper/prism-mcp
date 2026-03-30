#!/bin/sh
set -eu

if [ -z "${SUPABASE_URL:-}" ]; then
  export SUPABASE_URL="${PRISM_SUPABASE_URL:-http://rest:3000}"
fi

if [ -z "${SUPABASE_API_PREFIX+x}" ]; then
  export SUPABASE_API_PREFIX="${PRISM_SUPABASE_API_PREFIX:-}"
fi

if [ -z "${SUPABASE_KEY:-}" ]; then
  if [ -n "${PRISM_SUPABASE_KEY:-}" ]; then
    export SUPABASE_KEY="${PRISM_SUPABASE_KEY}"
  elif [ -n "${PRISM_REST_JWT_SECRET:-}" ]; then
    export SUPABASE_KEY="$({ node <<'EOF'
const crypto = require('node:crypto');

const secret = process.env.PRISM_REST_JWT_SECRET;
const role = process.env.PRISM_DB_USER || 'service_role';
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'HS256', typ: 'JWT' };
const payload = {
  role,
  iss: 'prism-local',
  iat: now,
  exp: now + 60 * 60 * 24 * 365,
};

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const encodedHeader = encode(header);
const encodedPayload = encode(payload);
const signature = crypto
  .createHmac('sha256', secret)
  .update(`${encodedHeader}.${encodedPayload}`)
  .digest('base64url');

process.stdout.write(`${encodedHeader}.${encodedPayload}.${signature}`);
EOF
} )"
  fi
fi

if [ -z "${GOOGLE_SEARCH_CREDENTIALS:-}" ] && [ -n "${PRISM_GOOGLE_SEARCH_CREDENTIALS:-}" ]; then
  export GOOGLE_SEARCH_CREDENTIALS="${PRISM_GOOGLE_SEARCH_CREDENTIALS}"
fi

if [ -z "${GOOGLE_SEARCH_API_KEY:-}" ] && [ -n "${PRISM_GOOGLE_SEARCH_API_KEY:-}" ]; then
  export GOOGLE_SEARCH_API_KEY="${PRISM_GOOGLE_SEARCH_API_KEY}"
fi

if [ -z "${GOOGLE_SEARCH_CX:-}" ] && [ -n "${PRISM_GOOGLE_SEARCH_CX:-}" ]; then
  export GOOGLE_SEARCH_CX="${PRISM_GOOGLE_SEARCH_CX}"
fi

node <<'EOF'
const target = '/rpc/prism_apply_ddl';
const baseUrl = process.env.SUPABASE_URL;
const deadline = Date.now() + 30000;

async function waitForSchemaCache() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      const body = await response.text();

      if (response.ok && body.includes(target)) {
        return;
      }
    } catch {
      // PostgREST is still booting — retry below.
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.error(`[Prism Compose] Timed out waiting for PostgREST endpoint ${target}`);
  process.exit(1);
}

waitForSchemaCache().catch(err => {
  console.error(`[Prism Compose] Failed while waiting for PostgREST schema cache: ${err}`);
  process.exit(1);
});
EOF

exec /bin/sh -lc 'npm run build && npm start'
