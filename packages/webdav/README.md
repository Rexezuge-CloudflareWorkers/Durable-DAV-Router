# `@durable-dav-router/webdav` — RFC 4918 Protocol Surface

Zero-runtime-dependency WebDAV protocol constants. No storage, no D1, no DO.

The router is a reverse proxy: it never parses a WebDAV body, stores a lock, or
renders a multistatus response. It forwards methods, headers, and bodies to a
Durable-DAV backend byte-for-byte, so the only protocol knowledge it needs is
the set of methods it will proxy and how to shape a CORS response for a native
client.

## `constants.ts`

- `SUPPORT_METHODS` — the 12 RFC 4918 methods the proxy forwards. Used both to
  register the Hono routes and to populate the `Allow` header on a `405`.
- `DAV_CLASS = '1, 2'` — the compliance class advertised by backends.
- `applyCors(response, request, allowListRaw?)` — attaches CORS headers to a
  proxied response. Origins are **not** reflected: an allow-list must be passed
  explicitly, because a reflected origin plus a forwarded `Cookie` would let any
  site drive cross-origin WebDAV writes through the proxy. Always sets
  `Vary: Origin` so a shared cache cannot cross-serve one origin's grant.
- `CORS_ALLOW_HEADERS` / `CORS_EXPOSE_HEADERS` — request headers a browser may
  send through the proxy (`depth`, `destination`, `lock-token`, …) and response
  headers it may read. `www-authenticate` is exposed so a client can distinguish
  "wrong password" from "no such bucket".
- `DEFAULT_CORS_ALLOWED_ORIGINS` — empty. The shipped SPA is served from this
  same origin, so browsers need no cross-origin grant.
- `parseAllowedOrigins` / `resolveAllowedOrigin` — the allow-list parser and the
  origin decision, split out so the policy is unit-testable without constructing
  a `Response`.

## What was removed, and why

`path.ts`, `xml.ts`, `props.ts`, and `locks.ts` were carried over from the
Durable-DAV backend, where they implement the server side. None of it is
reachable from the router: `LOCK`/`UNLOCK` are proxied, not executed; dead
properties live in the backend's DO SQLite; PROPFIND bodies are forwarded
unparsed. Keeping them meant a router package that appeared to hold lock state
and dead-property state it does not have, and that a `grep` for "lock" in this
repo would misleadingly hit.

The browser-side PROPFIND parser the SPA needs lives in `apps/web/src/lib/davXml.ts`,
where it is actually used.
