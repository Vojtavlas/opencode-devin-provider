# opencode-devin-provider

Use [Devin](https://devin.ai) as an [OpenCode](https://opencode.ai) chat provider through the official Devin v3 REST API.

This plugin is modeled on the provider-plugin architecture used by projects like `oh-my-pi`, but it targets the **official, public Devin API** instead of reverse-engineering internal endpoints.

## What it does

- Registers a `devin` provider in OpenCode with models like `devin`, `devin-fast`, `devin-lite`, `devin-ultra`, and `devin-fusion`.
- Each OpenCode chat message creates a Devin cloud session.
- The provider polls `GET /v3/organizations/{org}/sessions/{devin_id}/messages` and streams new assistant text back to OpenCode as it appears.
- No separate terminal script is needed; everything runs inside OpenCode.

## Prerequisites

- A Devin account with an organization.
- A Devin [service user](https://docs.devin.ai/api-reference/authentication) API key (`cog_...`) that has the `ManageOrgSessions` permission.
- Your Devin organization ID (`org_...`).

## Installation

Add the plugin to your `opencode.json` (or `.opencode/opencode.json`):

```json
{
  "plugin": ["opencode-devin-provider"]
}
```

Then run OpenCode and use `/connect` to authenticate with Devin. The plugin will prompt for:

- API key (`cog_...`)
- Organization ID (`org-...`)

Alternatively, set environment variables:

```bash
export DEVIN_API_KEY="cog_your_key"
export DEVIN_ORG_ID="org_your_org"
```

Or configure the provider manually:

```json
{
  "plugin": ["opencode-devin-provider"],
  "provider": {
    "devin": {
      "options": {
        "apiKey": "cog_your_key",
        "orgId": "org_your_org"
      }
    }
  }
}
```

## Selecting the model

Pick a Devin model with `/models` or set it in config:

```json
{
  "model": "devin/devin-fast"
}
```

Model IDs map to Devin `devin_mode` values:

- `devin` → `normal`
- `devin-fast` → `fast`
- `devin-lite` → `lite`
- `devin-ultra` → `ultra`
- `devin-fusion` → `fusion`

## How it works

OpenCode calls the Vercel AI SDK provider exported by `opencode-devin-provider/devin`. The provider's `doStream` method:

1. Renders the conversation into a single prompt string.
2. Calls `POST /v3/organizations/{org}/sessions` with `devin_mode`.
3. Polls `GET .../sessions/{devin_id}` for status and `GET .../messages` for assistant messages.
4. Emits `text-delta` parts as new `source: devin` messages arrive.
5. Emits `finish` when the session reaches `exit`, `error`, or `suspended`.

## Limitations

- Devin v3 API is **poll-only**. The provider simulates streaming by polling every 5 seconds (configurable).
- Each OpenCode message starts a **new Devin cloud session**. There is no conversation continuity across messages in the current version.
- Devin runs in a cloud VM, so it does not directly edit your local files. It returns text/output and can create PRs.
- Token usage is not returned by the Devin v3 API, so usage counts are reported as `0`.

## Development

```bash
bun install
bun test
bun run lint
bun build src/index.ts src/devin.ts --outdir dist --target node --format esm
```

## License

MIT
