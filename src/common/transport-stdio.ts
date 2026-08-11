import { enableCompileCache } from "node:module";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { clientRegistry } from "./client-registry";
import { USER_AGENT } from "./info";
import { handleInitializeMessage } from "./initialize";
import { SmartBearMcpServer } from "./server";
import { registerShutdownHandler } from "./shutdown";
import { getTypeDescription, isOptionalType } from "./zod-utils";

/**
 * Generate a dynamic error message listing all available clients and their required env vars
 */
function getNoConfigMessage(): string[] {
  const messages: string[] = [];
  for (const entry of clientRegistry.getAll()) {
    messages.push(` - ${entry.name}:`);
    for (const [configKey, requirement] of Object.entries(entry.config.shape)) {
      const envVarName = getEnvVarName(entry.configPrefix, configKey);
      const requiredTag = isOptionalType(requirement)
        ? " (optional)"
        : " (required)";
      messages.push(
        `    - ${envVarName}${requiredTag}: ${getTypeDescription(requirement)}`,
      );
    }
  }
  return messages;
}

/**
 * Build a server instance configured from environment variables.
 *
 * Used as the `serveStdio` factory: it is invoked once the opening exchange
 * has selected the protocol era, and the returned instance is pinned for the
 * lifetime of the connection.
 */
export async function buildStdioServer(): Promise<SmartBearMcpServer> {
  const server = new SmartBearMcpServer(process.env.MCP_TOOLSETS);

  // Setup clients from environment variables
  const configuredCount = await clientRegistry.configure(
    server,
    (client, key) => {
      const envVarName = getEnvVarName(client.configPrefix, key);
      return process.env[envVarName] || null;
    },
  );
  if (configuredCount === 0) {
    const message = getNoConfigMessage();
    console.warn(
      message.length > 0
        ? `No clients configured. Please provide valid environment variables for at least one client:\n${message.join("\n")}`
        : "No clients support environment variable configuration.",
    );
    // Add non-configured clients to server to allow listing available tools
    for (const entry of clientRegistry.getAll()) {
      await server.addClient(entry);
    }
  }

  return server;
}

/**
 * Run server in STDIO mode (default)
 *
 * Serving goes through `serveStdio`, which owns the era decision for the
 * connection: the opening exchange selects 2025-era or 2026-07-28 serving and
 * pins one instance from the factory for the connection's lifetime. `legacy:
 * "serve"` (the default, set explicitly here for intent) keeps 2025-era
 * clients working exactly as before, so old and new clients are both served
 * from the same tool/resource/prompt definitions.
 */
export async function runStdioMode() {
  if (process.argv.includes("--version")) {
    console.log(`User-Agent: ${USER_AGENT}`);
    process.exit(0);
  } else if (process.argv.includes("--help")) {
    console.log(
      "The following environment variables can be set to configure each of the SmartBear clients:",
    );
    console.log(getNoConfigMessage().join("\n"));
    process.exit(0);
  }

  enableCompileCache();

  const transport = new StdioServerTransport();

  // `serveStdio` owns the transport and installs its own `onmessage`, so the
  // `initialize` capture (client identity, sampling/elicitation support) is
  // preserved by intercepting that assignment and tapping messages first.
  //
  // The opening `initialize` is what *triggers* the factory, so no server
  // exists yet when the tap first fires — that message is buffered and applied
  // as soon as the instance is built.
  let activeServer: SmartBearMcpServer | undefined;
  let openingMessage: JSONRPCMessage | undefined;
  let onmessage: ((message: JSONRPCMessage) => void) | undefined;

  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => onmessage,
    set: (handler: ((message: JSONRPCMessage) => void) | undefined) => {
      onmessage = (message: JSONRPCMessage) => {
        if (activeServer) {
          handleInitializeMessage(activeServer, message);
        } else {
          openingMessage = message;
        }
        handler?.(message);
      };
    },
  });

  const handle = serveStdio(
    async () => {
      const server = await buildStdioServer();
      activeServer = server;
      if (openingMessage !== undefined) {
        handleInitializeMessage(server, openingMessage);
        openingMessage = undefined;
      }
      return server;
    },
    {
      // Serve 2025-era openings alongside modern ones (this is also the
      // default; stated explicitly so the backwards-compatibility guarantee
      // is visible at the call site).
      legacy: "serve",
      transport,
      onerror: (error) => {
        console.error("[MCP][stdio] Transport error:", error);
      },
    },
  );

  // Graceful shutdown: close the connection on SIGTERM/SIGINT.
  //
  // Stdio normally exits cleanly when the parent closes stdin. This handler
  // is only meaningful when the process receives a signal directly (e.g.
  // the parent kills us hard). It closes the pinned instance and the
  // underlying transport so the SDK stops reading stdin promptly.
  //
  // Note: there is no per-session `cleanupSession` call here because the
  // stdio transport has no sessionId — there is exactly one connection per
  // process lifetime — and tools running over stdio never receive an
  // mcpSessionId in their `ctx` argument, so per-client session maps are
  // never populated under stdio. Resources held by clients (e.g. Reflect
  // WebSockets) are released when the process exits. Adding a process-wide
  // teardown hook for stdio would require extending the Client interface
  // with a `cleanupAll()`; tracked as a separate enhancement.
  registerShutdownHandler("stdio-transport", async () => {
    try {
      await handle.close();
    } catch (err) {
      console.error("[MCP][shutdown] Error closing stdio transport:", err);
    }
  });
}

export function getEnvVarName(clientPrefix: string, key: string): string {
  return `${clientPrefix.toUpperCase().replace(/-/g, "_")}_${key.toUpperCase()}`;
}
