# NabuDesk MCP server

Drives NabuDesk conversationally instead of through the Livewire panel: create a
business, write its knowledge base, and check what the support bot would answer —
without opening a browser or reaching for `docker exec`.

```
MCP client (Claude Code / Claude Desktop)
   │ stdio
   ▼
mcp-server/index.js                     ← runs locally
   │ HTTPS + X-Internal-Token
   ▼
NabuDesk  /api/internal/v1/*            ← app/Http/Controllers/Api/Internal
   │
   ▼
BusinessProvisioningService · KnowledgeSyncService · SupportDryRunService
```

The MCP server holds no business logic. It is a transport adapter over the
operator API, so the panel and the API cannot drift apart.

## Security

`INTERNAL_API_TOKEN` is a single shared secret that is **not scoped to a
business** — it can read and write every business on the instance. It is for
staff only. Never hand it to a customer, and never put it in a client-side app.

When the variable is unset the entire `/api/internal/*` surface returns `503`,
so a deploy that forgets the secret fails closed rather than serving the API
unauthenticated.

## Setup

On the NabuDesk instance, set the secret (in Coolify's environment variables, so
it survives a redeploy — a value written only into the container's `.env` is
lost on the next deploy):

```bash
openssl rand -hex 32
# → INTERNAL_API_TOKEN=<value>
```

Locally:

```bash
cd mcp-server
npm install
npm run build
```

Register it with your MCP client. For Claude Code:

```bash
claude mcp add nabudesk \
  --env NABUDESK_URL=https://desk.nabuxai.com \
  --env NABUDESK_TOKEN=<the same value> \
  -- node /absolute/path/to/NabuDesk/mcp-server/index.js
```

Or in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nabudesk": {
      "command": "node",
      "args": ["/absolute/path/to/NabuDesk/mcp-server/index.js"],
      "env": {
        "NABUDESK_URL": "https://desk.nabuxai.com",
        "NABUDESK_TOKEN": "<the same value>"
      }
    }
  }
}
```

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NABUDESK_URL` | yes | — | Base URL of the instance |
| `NABUDESK_TOKEN` | yes | — | Must equal `INTERNAL_API_TOKEN` there |
| `NABUDESK_TIMEOUT_MS` | no | `60000` | Raise if the AI gateway is slow |

## Tools

**Businesses**

| Tool | Does |
|---|---|
| `list_businesses` | All businesses with AI settings, knowledge count, Telegram link state |
| `get_business` | One business including its full AI context text |
| `upsert_business` | Create or update. Idempotent by (owner, name) — safe to retry |
| `get_link_status` | Which of the two manual Telegram steps are still pending, with the exact instructions |

**Custom Domains & Zone Mapping**

| Tool | Does |
|---|---|
| `list_domains` | All custom domains mapped to a business with status and DNS records |
| `add_domain` | Connect custom domain / subdomain (forms, quizzes, bio-links, booking) and get DNS instructions |
| `verify_domain` | Live test of CNAME / A / TXT DNS records and instant activation |
| `delete_domain` | Remove a custom domain from the business |

**Knowledge**

| Tool | Does |
|---|---|
| `list_knowledge` | Every item with content and embedding state |
| `upsert_knowledge` | Add or replace by title. Embeds and indexes in one batch; returns `embedded` beside `written` |
| `delete_knowledge` | Removes the row **and** its Qdrant vector |
| `reindex_knowledge` | Re-embed everything — after a model change or a direct DB edit |

**Diagnostics**

| Tool | Does |
|---|---|
| `ask` | The answer the support agent would give — no contact, no conversation, no budget spend |
| `test_retrieval` | Cosine score per knowledge item, and which clear the threshold |
| `list_unanswered` | Questions the bot could not answer — the knowledge-gap queue |
| `health` | Database, Qdrant, embeddings and AI gateway reachability |

### Why `test_retrieval` exists

The failure it catches is silent. `EmbeddingService::searchKnowledge()` drops
anything below a `0.2` minimum score. The embedding model is cross-lingual but
weak: a non-English question can rank the **correct** document first and still
score under the threshold, so nothing is retrieved and the bot answers from the
context alone — confidently, and without the specifics.

Measured on the `Zooey Support` knowledge base before it was made trilingual:

| Question | Top score | Retrieved |
|---|---|---|
| `How do I connect WhatsApp?` | 0.689 | yes |
| `كيف أربط واتساب؟` | 0.430 | yes |
| `كم سعر الباقة الاحترافية؟` | **0.160** | **no** |
| `چطور واتساپ رو وصل کنم؟` | 0.298 | yes |

Writing the knowledge in the languages customers actually use raised the failing
case to `0.297`. `test_retrieval` is how you see that, since `ask` alone still
returns a plausible-looking answer.

### Why `upsert_knowledge` returns two counts

`EmbeddingService::embedMany` never throws. It returns `null` for any text it
could not embed — including when the provider key is unset or the request
failed. Without counting, every row is written with a null vector and reported
as a success while being permanently unretrievable.

`written` is how many rows were stored; `embedded` is how many of them can
actually be found. They should match. If nothing could be embedded the call
returns 503 and writes nothing, because a business with knowledge it can never
retrieve is worse than a failed call it can retry.

## Notes

- `ask` is a dry run. It shares production's retrieval, business context and
  model, but not the prompt-injection guard or the per-contact reply budget —
  those belong to the live `ReplyComposer` path.
- `upsert_business` is idempotent by (owner, name), and `upsert_knowledge` by
  title. Both are safe for an AI caller that retries.
- The Livewire create form still assembles its AI context inline. Until it is
  refactored onto `BusinessProvisioningService`, a change to the section list
  must be mirrored in
  `resources/views/livewire/pages/businesses/create.blade.php`.
