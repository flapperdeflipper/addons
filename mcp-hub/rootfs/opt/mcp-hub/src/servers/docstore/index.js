// Docstore forwarder: the couchdb add-on's registry-validated MCP endpoint
// (agent doc_* tools + TTL sweeper) on its internal :5985. The endpoint is
// stateless per-request JSON-RPC with a bearer token, so the shared
// pass-through is the whole job. The couchdb add-on enforces the database
// allowlist, _id/type grammar and TTL stamping; the hub only routes.

import { validateJsonRpcMessage } from "../ha-native/native-mcp.js";
import { createStatelessForwarder } from "../../lib/stateless-forwarder.js";

export function createDocstoreForwarder(opts = {}) {
  return createStatelessForwarder({
    ...opts,
    label: "docstore",
    urlError: "docstore_url is required (the couchdb add-on's 5985 MCP endpoint)",
    tokenError: "docstore_token is required (the couchdb add-on's docstore token)",
  });
}

export default {
  id: "docstore",
  title: "Agent docstore (couchdb add-on doc_* tools)",
  kind: "forwarder",
  enabledOption: "docstore_enabled",
  validateJsonRpcMessage,

  createForwarder(ctx) {
    const { config, log } = ctx;
    const forwarder = createDocstoreForwarder({
      url: config.docstore_url,
      token: config.docstore_token,
    });
    log("info", `forwarding /mcp/docstore to ${forwarder.endpoint}`);
    return forwarder;
  },
};
