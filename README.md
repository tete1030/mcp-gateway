# MCP Gateway

MCP Gateway is a private, single-owner preview that routes configured Streamable HTTP MCP backends through one loopback listener. It includes an optional Home Assistant History reader and an adapter from HA custom events to signed webhook subscriptions.

Version: `0.7.0-preview.0`. This tree contains fictional examples and offline tests. Account-specific plugin access and delivery must be verified with the actual client. Publishing this source does not publish a plugin or connect a Home Assistant instance.

## Behavior

- Native tool names, schemas, annotations, metadata and results pass through dynamically. A backend can use an explicit allowlist, deny list or namespace. Conflicting names fail catalog refresh.
- Device actions are invoked once; the gateway never automatically retries an upstream tool call. Upstream permissions and configured tool policies determine which actions are available.
- Optional `ha_history__query` reads selected entities from HA's existing History API. It returns state records, bounded pages, signed cursors and explicit coverage limitations. It cannot establish complete business-event or notification history.
- HA owns sustained-state conditions and recovery timers. The gateway subscribes to four custom HA event types, validates their envelopes and maintains a bounded encrypted delivery queue. Events during a disconnected interval are not replayed.
- Subscriptions use finite leases, callback verification, signed delivery, bounded retries, expiry and unsubscribe fencing. Recovery delivery requires an earlier attention delivery receipt.

The HA adapter currently has a fixed five-resource example contract. To use different entities, update the mapping, event schemas and HA YAML together in a private deployment copy. The `entityIds` configuration selects from that contract; it does not accept arbitrary entity identifiers.

## Development checks

Use Node.js `>=24.15 <25` for the built-in SQLite API. Dependencies are pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run validate-config -- config/thin.example.json
npm test
```

Tests use fictional entities, reserved example domains, deterministic test credentials, injected HTTP/WebSocket mocks and temporary databases. One test starts a temporary loopback listener. They do not use deployment credentials or operate real devices. Test credentials must never be used for a deployment.

The optional HA checks require a separately installed, compatible Home Assistant Python environment:

```sh
python scripts/validate-ha-native.py examples/home-assistant/mcp_gateway.package.yaml
python scripts/test-ha-native.py examples/home-assistant/mcp_gateway.package.yaml
```

The native test creates an isolated in-process HA object and accelerates timers in its test copy. Run it against the intended HA version before installing the example. See [the HA example guide](docs/home-assistant.md).

## Configuration and deployment boundary

`config/thin.example.json` disables backends, History and Events. It contains secret references rather than values and has no tunnel allocation. Validate a private copy before starting it. `GATEWAY_CONFIG_FILE` must identify the runtime configuration file.

The listener binds to `127.0.0.1`, serves `/mcp` and exposes local health at `/healthz`. It authenticates the service hop with `x-mcp-gateway-service-secret`, mapping possession to one configured owner. This is not a complete OAuth authorization server or a multi-user identity system. An injected bearer-verifier boundary exists for custom integrations but does not supply OAuth discovery, login, token issuance or revocation itself.

The included tunnel launcher expects separately provisioned Secure MCP Tunnel credentials, tunnel and organization identifiers. Its extra headers reference mounted secret files or environment variables. A tunnel provides transport; its authorization server still needs an appropriate reachable login path. See [OpenAI's Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

Create credentials, grant HA permissions, allocate a tunnel and change network access only through the deployment owner's approved setup process. Keep these inputs outside this repository. HA's [MCP Server integration](https://www.home-assistant.io/integrations/mcp_server/) serves the Assist API at `/api/mcp/assist`. Native tool access may include write operations; use an explicit read-tool allowlist for a read-only deployment.

Events use the [MCP Events draft integration supported by OpenAI plugins](https://developers.openai.com/plugins/build/mcp-events). The runtime exposes Events handlers to modern clients when enabled. This should not be assumed to work with every MCP client, ChatGPT plan or workspace configuration.

For Events, configure persistent state such as:

```json
{
  "databaseFile": "/var/lib/mcp_gateway/events.sqlite",
  "keyRef": "state",
  "encryptionNamespace": "mcp-gateway-events-v1"
}
```

The state key must decode to exactly 32 bytes of canonical base64. Secret files must be private regular files under `/run/secrets`, owned by the runtime UID. The state directory and database must also be private and owned by that UID. Keep the external key available across restarts and make approved encrypted backups.

Runtime callback policy accepts a bounded list of exact DNS hostnames. Only allow the destination verified for your client. This mode preserves TLS validation and uses the normal network route; it does not independently reject private DNS resolutions. The transport module also has a generic public-address validation mode for custom integrations. Do not treat the exact-host runtime policy as equivalent to generic public-IP filtering.

The event definitions `gateway__digest` and `poc__synthetic` are reserved for protocol compatibility. The runtime has no digest generator or user-visible synthetic emission tool. Unit tests exercise the reusable event engine internally.

## Container build

```sh
docker build --target runtime -t mcp-gateway:preview .
```

The Dockerfile pins official Node and tunnel-client image digests, installs locked dependencies and requires the offline Node test stage before creating the runtime stage. The default-deny `.dockerignore` includes only the required source, test fixtures and public configuration examples. It excludes local dependencies, runtime data and private reports.

The runtime UID is `10001`. A deployment should use a read-only root filesystem, dropped capabilities, `no-new-privileges`, a bounded writable temporary directory, external read-only configuration/secrets and a dedicated writable state volume. No host port needs publishing for the outbound tunnel path. This source tree does not create volumes or migrate an existing deployment.

## Existing-state compatibility

`identity.serviceSecretHeader` and `events.state.encryptionNamespace` can explicitly retain an older deployment's non-secret identifiers. Changing an encryption namespace does not re-encrypt old data; a mismatched namespace rejects the key-check record. Preserve the original state key, owner, event filters and contract mapping when assessing a migration. Do not silently reset a database to bypass that failure.

Storage schema version 2 retains an unused `business` table and the receipt HMAC context for compatibility. Subscription IDs, owner HMAC context and lease/generation semantics are preserved. These compatibility details do not recreate a retired rule engine.

## Publication status and license

This is a source preview prepared for review. Use the [release checklist](docs/release-checklist.md) before publishing source, an image or a plugin. Local tests cannot replace a real client tool call and verified event receipt in an approved deployment.

No project license is provided. No license grant is included in this preview. Dependency packages retain their respective licenses.
