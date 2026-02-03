# nRPC

A hackable typed RPC library for cross-boundary communication in JavaScript/TypeScript.

Primarily for WebWorkers, SharedWorkers, Node Workers, Child Processes, Electron IPC, and more.

## Features

- **Type-safe** - Full TypeScript support with automatic type inference
- **Flexible** - Works with any message-passing mechanism (WebWorkers, IPC, etc.)
- **Lightweight** - Minimal dependencies and small bundle size
- **Queries & Subscriptions** - Support for both request-response and streaming patterns
- **Validation** - Built-in support for Zod and custom validators
- **Middleware** - Context-based middleware for authentication and processing

## Quick Start

### Server

```typescript
import { router, query } from "nrpc/shared";
import { NRPCServer } from "nrpc/server";
import { parentPort } from "node:worker_threads";

const myRouter = router(
  (ctx) => ctx, // middleware
  {
    greet: query(
      (input) => {
        if (typeof input != "string") {
          throw new Error("Invalid Input");
        }
        return input;
      },
      (ctx, input: string) => `Hello, ${input}!`,
    ),
  },
);

const server = new NRPCServer(myRouter);

if (parentPort) {
  const { onMsg } = server.getConnection(
    {}, // Inject context for connection
    (msg) => parentPort.postMessage(msg),
    () => {}, // onClose
  );

  parentPort.on("message", onMsg);
}
```

### Client

```typescript
import { getClient } from "nrpc/client";

const client = getClient(
  (msg) => worker.postMessage(msg),
  () => worker.terminate(),
);

worker.on("message", (msg) => client.onMsg(msg));

const result = await client.proxy.greet("World");
console.log(result); // "Hello, World!"
```

## License

ISC
