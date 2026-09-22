// Home Assistant native MCP forwarder module. One forwarder instance serves
// every hub client: each POST is validated and forwarded to Core's native
// MCP endpoint through the Supervisor proxy with the add-on's token, which
// this add-on receives through homeassistant_api.

import {
  createNativeMcpForwarder,
  validateJsonRpcMessage,
} from "./native-mcp.js";

export { validateJsonRpcMessage };

export default {
  id: "ha-native",
  title: "Home Assistant native MCP (Assist)",
  kind: "forwarder",
  enabledOption: "ha_native_enabled",

  createForwarder(ctx) {
    const { config, env, log } = ctx;
    const supervisorToken = env.SUPERVISOR_TOKEN;
    if (!supervisorToken) {
      throw new Error(
        "SUPERVISOR_TOKEN is not available - the add-on needs homeassistant_api access"
      );
    }
    return createNativeMcpForwarder({
      supervisorToken,
      apiId: config.ha_native_api_id,
      onEndpointFallback: (details) =>
        log("info", "native MCP keyed endpoint unavailable, falling back to /api/mcp", details),
      onEndpointRecovered: (details) =>
        log("info", "native MCP keyed endpoint recovered", details),
    });
  },
};
