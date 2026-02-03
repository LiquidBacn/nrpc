# nRPC - Node Remote Procedure Call

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
      // Validator required for input. Could also be z.string()
      (input) => {
        if (typeof input !== "string") {
          throw new Error("Invalid Input");
        }
        return input;
      },
      (ctx, input: string) => `Hello, ${input}!`,
    ),

    whoAmI: query((ctx) => {
      // When no input is needed, the validator can be skipped.
      return ctx.user.name;
    }),
  },
);

export type AppRouter = typeof myRouter;

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
import type { AppRouter } from "./your/nrpc/router";

const client = getClient<AppRouter>(
  (msg) => worker.postMessage(msg),
  () => worker.terminate(),
);

worker.on("message", (msg) => client.onMsg(msg));

const result = await client.proxy.greet("World");
console.log(result); // "Hello, World!"
```

## Disclaimer

**nRPC ships with no serialization.** Messages are passed as-is between client and server. You must handle serialization/deserialization yourself based on your transport layer. However, transport mechanisms like WebWorkers and Node's worker threads support the HTML structured clone algorithm, so you likely won't need additional serialization for common, and some advanced data types.

## Why not tRPC?

tRPC is an advanced package designed to send remote calls over the internet. For use over the internet, tRPC is likely the better option.

However, at time of writing tRPC does not natively support IPC use cases. Nor does it expose stable APIs to add support for these uses.

nRPC on the other hand, is designed to be used with whatever transport you can convince to work with it. While it will likely shine the best with IPC use cases, sending data via WS or even HTTP will likely work.
