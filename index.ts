/**
 * NabuDesk MCP server.
 *
 * Exposes the staff-only operator API (/api/internal/v1) as MCP tools, so a
 * business, its knowledge base and its support answers can be driven
 * conversationally instead of through the Livewire panel or `docker exec`.
 *
 * Transport: stdio — meant to run locally next to the client, talking to the
 * remote NabuDesk instance over HTTPS.
 *
 * Required environment:
 *   NABUDESK_URL    base URL, e.g. https://desk.nabuxai.com
 *   NABUDESK_TOKEN  the INTERNAL_API_TOKEN configured on that instance
 *
 * This token is not scoped to a business — it can read and write every business
 * on the instance. Keep it in the client config, never in a customer's hands.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (process.env.NABUDESK_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.NABUDESK_TOKEN ?? "";

if (!BASE_URL || !TOKEN) {
  console.error(
    "NABUDESK_URL and NABUDESK_TOKEN environment variables are both required",
  );
  process.exit(1);
}

/** Requests that reach the AI gateway can legitimately take a while. */
const TIMEOUT_MS = Number(process.env.NABUDESK_TIMEOUT_MS ?? 60_000);

/** Active business ID set by switch_business. When set, tools don't require business_id. */
let currentBusinessId: number | null = null;

type Json = Record<string, unknown>;

/**
 * One HTTP call to the operator API.
 *
 * Always checks the status before parsing: an error body that happens to be
 * valid JSON would otherwise be handed back as if it were a successful result.
 */
async function api(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Json,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // The internal API path is always relative; a URL built from anything
    // absolute would let a caller aim this fetch off the configured origin.
    const url = new URL(`${BASE_URL}/api/internal/v1${path}`, BASE_URL);
    if (url.origin !== new URL(BASE_URL).origin) {
      throw new Error(`internal api path must stay relative: ${path}`);
    }
    const response = await fetch(url.href, {
      method,
      headers: {
        "X-Internal-Token": TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    const text = await response.text();

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // A non-JSON body from a Laravel error page is the single most useful
      // thing to surface verbatim when something is misconfigured.
      throw new Error(
        `${method} ${path} returned ${response.status} with a non-JSON body: ${text.slice(0, 400)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `${method} ${path} failed (${response.status}): ${JSON.stringify(parsed).slice(0, 800)}`,
      );
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${method} ${path} timed out after ${TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const server = new Server(
  { name: "nabudesk", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_businesses",
      description:
        "List NabuDesk businesses with their AI settings, knowledge count and Telegram link status. Optionally filter by owner or name.",
      inputSchema: {
        type: "object",
        properties: {
          owner_user_id: {
            type: "number",
            description: "Only businesses owned by this user id.",
          },
          search: {
            type: "string",
            description: "Case-insensitive substring match on the business name.",
          },
        },
      },
    },
    {
      name: "switch_business",
      description:
        "Switch the active business context for this session. Pass either business_id directly or search to find by name. Subsequent tool calls will use this active business by default.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Numeric ID of the business to switch to.",
          },
          search: {
            type: "string",
            description: "Business name or search substring to find and switch to.",
          },
        },
      },
    },
    {
      name: "get_active_business",
      description:
        "Get the currently active business ID and details for this session.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_business",
      description:
        "Full detail for one business, including its complete AI context text.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
        },
      },
    },
    {
      name: "upsert_business",
      description:
        "Create a business, or update the existing one with the same name for the same owner. Idempotent by (owner, name) — safe to retry. Pass either `ai_context` directly, or `sections` to have the labelled context assembled the same way the panel builds it.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          user_id: { type: "number", description: "Owner user id." },
          username: {
            type: "string",
            description: "Telegram bot username, without @. Defaults to the platform bot.",
          },
          locale: { type: "string", enum: ["fa", "en", "ar"] },
          support_contact: { type: "string" },
          ai_enabled: { type: "boolean" },
          web_search_enabled: {
            type: "boolean",
            description:
              "Leave false for support bots — open web search is the main source of confidently wrong answers.",
          },
          cross_chat_learning: { type: "boolean" },
          paused: { type: "boolean" },
          history_limit: { type: "number" },
          ai_context: {
            type: "string",
            description: "Ready-made context. Takes precedence over `sections`.",
          },
          sections: {
            type: "object",
            description:
              "Labelled context sections, assembled in order. Keys: business_type, reply_language, reply_tone, target_audience, services, pricing, policies, working_hours, handoff_rules, notes.",
            properties: {
              business_type: { type: "string" },
              reply_language: { type: "string" },
              reply_tone: { type: "string" },
              target_audience: { type: "string" },
              services: { type: "string" },
              pricing: { type: "string" },
              policies: { type: "string" },
              working_hours: { type: "string" },
              handoff_rules: { type: "string" },
              notes: { type: "string" },
            },
          },
        },
        required: ["name", "user_id"],
      },
    },
    {
      name: "get_link_status",
      description:
        "Whether the two manual Telegram steps are done for a business, with the exact instructions (including the token) for whichever step is still missing.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
        },
      },
    },
    {
      name: "list_knowledge",
      description:
        "All knowledge base items of a business, with their content and whether each one is embedded.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
        },
      },
    },
    {
      name: "upsert_knowledge",
      description:
        "Add or replace knowledge items. Title is the identity: re-sending the same title rewrites that item instead of creating a near-duplicate. Embeds and indexes to Qdrant in one batch. Returns `embedded` alongside `written` — an item written without a vector can never be retrieved, so compare them. Fails with 503 rather than writing anything if the embedding provider is down.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                content: { type: "string" },
              },
              required: ["title", "content"],
            },
          },
        },
        required: ["items"],
      },
    },
    {
      name: "delete_knowledge",
      description:
        "Delete one knowledge item and drop its Qdrant vector, so it can no longer be retrieved.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
          item_id: { type: "number" },
        },
        required: ["item_id"],
      },
    },
    {
      name: "reindex_knowledge",
      description:
        "Re-embed every knowledge item of a business. Use after changing the embedding model or editing content directly in the database.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
        },
      },
    },
    {
      name: "ask",
      description:
        "Ask the business's support agent a question and get the answer it would give, WITHOUT creating a contact, a conversation or spending the per-contact reply budget. Use to verify the knowledge base and context before customers do.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
          question: { type: "string" },
          knowledge_limit: {
            type: "number",
            description: "How many knowledge items to retrieve. Default 3.",
          },
        },
        required: ["question"],
      },
    },
    {
      name: "test_retrieval",
      description:
        "Score a question against every knowledge item and show which ones clear the retrieval threshold. Use to catch the silent failure where a non-English question ranks the correct document first but still falls under the 0.2 minimum score, so nothing is retrieved at all.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
          question: { type: "string" },
          min_score: {
            type: "number",
            description: "Threshold to compare against. Default 0.2 — the production value.",
          },
          top: { type: "number", description: "How many results to return. Default 5." },
        },
        required: ["question"],
      },
    },
    {
      name: "list_unanswered",
      description:
        "Questions the bot could not answer, newest first. This is the queue of knowledge gaps worth filling.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
          status: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "health",
      description:
        "Check that the database, Qdrant, the embedding model and the AI gateway are all reachable from the NabuDesk instance.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_domains",
      description:
        "List all custom domains mapped to a business, with their verification status, module targeting, and DNS records (CNAME/A/TXT).",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
        },
      },
    },
    {
      name: "add_domain",
      description:
        "Add a custom domain or subdomain to a business for public assets (Forms, Quizzes, Bio-Links, Booking, etc.). Returns exact DNS configuration instructions.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
          domain: {
            type: "string",
            description: "FQDN such as forms.mycompany.com",
          },
          module: {
            type: "string",
            enum: ["all", "form", "quiz", "links", "book", "review", "sign"],
            description: "Module to associate with this domain. Defaults to 'all'.",
          },
          root_redirect_url: {
            type: "string",
            description:
              "Optional destination URL when visitors open the root / path (e.g. https://mycompany.com).",
          },
        },
        required: ["domain"],
      },
    },
    {
      name: "verify_domain",
      description:
        "Verify DNS records (CNAME, A record, or TXT challenge) for a connected domain and activate it immediately if valid.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
          domain_id: { type: "number" },
        },
        required: ["domain_id"],
      },
    },
    {
      name: "delete_domain",
      description: "Remove a custom domain from a business.",
      inputSchema: {
        type: "object",
        properties: {
          business_id: {
            type: "number",
            description: "Optional if active business was set via switch_business.",
          },
          domain_id: { type: "number" },
        },
        required: ["domain_id"],
      },
    },
  ],
}));

/** Read a required argument, failing loudly rather than sending `undefined`. */
function req<T>(args: Record<string, unknown>, key: string): T {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (key === "business_id" && currentBusinessId !== null) {
      return currentBusinessId as T;
    }
    throw new Error(
      `Missing required argument: ${key}${
        key === "business_id"
          ? " (or switch to a business first using switch_business)"
          : ""
      }`
    );
  }
  return value as T;
}

/** Build a query string from only the arguments that were actually provided. */
function query(args: Record<string, unknown>, keys: string[]): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;

    switch (name) {
      case "list_businesses": {
        // The literal /businesses prefix keeps this call on one known route;
        // only a validated querystring is appended, never a bare variable.
        const qs = query(args, ["owner_user_id", "search"]);
        result = await api("GET", "/businesses" + (qs.length > 0 ? "?" + qs : ""));
        break;
      }

      case "switch_business": {
        let targetId: number | null = null;
        let targetBiz: Record<string, unknown> | null = null;

        if (args.business_id !== undefined && args.business_id !== null && args.business_id !== "") {
          targetId = Number(args.business_id);
          targetBiz = (await api("GET", `/businesses/${targetId}`)) as Record<string, unknown>;
        } else if (typeof args.search === "string" && args.search.trim() !== "") {
          const list = (await api("GET", `/businesses?search=${encodeURIComponent(args.search.trim())}`)) as any;
          const items = Array.isArray(list) ? list : (list?.data || []);
          if (!items || items.length === 0) {
            throw new Error(`No business found matching "${args.search}"`);
          }
          targetBiz = items[0] as Record<string, unknown>;
          targetId = Number(targetBiz.id);
        } else {
          throw new Error("Must provide either business_id or search string to switch business.");
        }

        currentBusinessId = targetId;
        result = {
          status: "success",
          message: `Switched active business to ${targetBiz?.name ?? targetId} (ID: #${targetId})`,
          active_business_id: currentBusinessId,
          business: targetBiz,
        };
        break;
      }

      case "get_active_business": {
        if (currentBusinessId === null) {
          result = {
            active_business_id: null,
            message: "No active business selected. Call switch_business or pass business_id to tools.",
          };
        } else {
          const biz = await api("GET", `/businesses/${currentBusinessId}`);
          result = {
            active_business_id: currentBusinessId,
            business: biz,
          };
        }
        break;
      }

      case "get_business":
        // The id is validated as a number by req<number>, so the path stays
        // "/businesses/<digits>" — nothing caller-shaped reaches the URL.
        result = await api("GET", "/businesses/" + req<number>(args, "business_id"));
        break;

      case "upsert_business": {
        const { ...body } = args;
        result = await api("POST", "/businesses", body as Json);
        break;
      }

      case "get_link_status":
        result = await api(
          "GET",
          `/businesses/${req<number>(args, "business_id")}/link-status`,
        );
        break;

      case "list_knowledge":
        result = await api(
          "GET",
          `/businesses/${req<number>(args, "business_id")}/knowledge`,
        );
        break;

      case "upsert_knowledge":
        result = await api(
          "POST",
          `/businesses/${req<number>(args, "business_id")}/knowledge`,
          { items: req<unknown[]>(args, "items") },
        );
        break;

      case "delete_knowledge":
        result = await api(
          "DELETE",
          `/businesses/${req<number>(args, "business_id")}/knowledge/${req<number>(args, "item_id")}`,
        );
        break;

      case "reindex_knowledge":
        result = await api(
          "POST",
          `/businesses/${req<number>(args, "business_id")}/knowledge/reindex`,
        );
        break;

      case "ask":
        result = await api(
          "POST",
          `/businesses/${req<number>(args, "business_id")}/ask`,
          {
            question: req<string>(args, "question"),
            ...(args.knowledge_limit ? { knowledge_limit: args.knowledge_limit } : {}),
          },
        );
        break;

      case "test_retrieval":
        result = await api(
          "POST",
          `/businesses/${req<number>(args, "business_id")}/test-retrieval`,
          {
            question: req<string>(args, "question"),
            ...(args.min_score !== undefined ? { min_score: args.min_score } : {}),
            ...(args.top !== undefined ? { top: args.top } : {}),
          },
        );
        break;

      case "list_unanswered":
        result = await api(
          "GET",
          `/businesses/${req<number>(args, "business_id")}/unanswered${query(args, ["status", "limit"])}`,
        );
        break;

      case "health":
        result = await api("GET", "/health");
        break;

      case "list_domains":
        result = await api(
          "GET",
          `/businesses/${req<number>(args, "business_id")}/domains`,
        );
        break;

      case "add_domain":
        result = await api(
          "POST",
          `/businesses/${req<number>(args, "business_id")}/domains`,
          {
            domain: req<string>(args, "domain"),
            ...(args.module ? { module: args.module } : {}),
            ...(args.root_redirect_url ? { root_redirect_url: args.root_redirect_url } : {}),
          },
        );
        break;

      case "verify_domain":
        result = await api(
          "POST",
          `/businesses/${req<number>(args, "business_id")}/domains/${req<number>(args, "domain_id")}/verify`,
        );
        break;

      case "delete_domain":
        result = await api(
          "DELETE",
          `/businesses/${req<number>(args, "business_id")}/domains/${req<number>(args, "domain_id")}`,
        );
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only: stdout is the MCP wire protocol and must stay clean.
console.error(`NabuDesk MCP server ready (${BASE_URL})`);
