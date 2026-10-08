# Changelog

All notable changes to the Floatra Generic REST Adapter.
Versions follow `package.json`. Source: git tag `v<version>` on
`github.com/floatra-hq/generic-rest-adapter`; image:
`ghcr.io/floatra-hq/generic-rest-adapter:<version>`.

## [0.1.0]

First public release (source and image). MIT licence.

- **Matches Floatra's partner API.** Requires the `/v1/partner` base URL,
  unwraps Floatra's response envelope and carries its `errorCode`, sends
  amounts as decimal-Naira strings and only Floatra's order categories.
- **Accepts Floatra's real webhooks**: Unix-seconds timestamp signature, flat
  payloads, `livemode` on every event, `200` on duplicates. The example config
  and the reorder lock / unlock bodies are tested against webhook fixtures
  rendered by Floatra core.
- **`--validate-only`** validates every config in `CONFIG_DIR` and exits
  (no server, no Redis, no network). The image bundles the example config at
  `/app/configs.example/example.json`.
- **Fallback audit log is writable in the image**: it defaults to
  `/var/lib/floatra-adapter/fallback-audit.jsonl` (`FALLBACK_AUDIT_LOG_PATH`
  still overrides). Mount a volume there to keep it.
- Inbound API-key and basic auth use constant-time comparison; inbound auth
  `none` is refused in production; config files readable by group or world are
  refused at boot.
