import { Worker } from "worker_threads";
import { fork } from "child_process";
import { z } from "zod";
import {
  router,
  query,
  subscription,
  NRPCReqCanceled,
} from "../src/shared/index.ts";
import { NRPCServer } from "../src/server/index.ts";
import { getClient } from "../src/client/index.ts";
import type {
  NRPCRequest,
  NRPCResponse,
  Router,
  Routes,
} from "../src/shared/types.ts";

// Test context type
export interface TestContext {
  userId: string;
  isAdmin: boolean;
  kind: "test" | "worker" | "child";
}

// Zod validators
export const numberValidator = z.number();
export const stringValidator = z.string();
export const userValidator = z.object({
  name: z.string(),
  age: z.number(),
});

// ============================================================================
// SIMPLE ROUTER (1 level)
// ============================================================================

export const simpleRouter = router(
  (ctx: { kind: string }): TestContext => ({
    userId: "user123",
    isAdmin: ctx.kind === "admin",
    kind: "test",
  }),
  {
    getGreeting: query((ctx: TestContext) => {
      return `Hello ${ctx.userId}!`;
    }),

    addNumbers: query(z.number(), (ctx: TestContext, num: number) => {
      return num + 10;
    }),

    getUserInfo: query((ctx: TestContext) => {
      return {
        userId: ctx.userId,
        isAdmin: ctx.isAdmin,
      };
    }),

    echoString: query(z.string(), (ctx: TestContext, str: string) => {
      return str.toUpperCase();
    }),

    countUp: subscription(async function* (ctx: TestContext) {
      for (let i = 0; i < 3; i++) {
        yield { count: i, userId: ctx.userId };
        await new Promise((res) => setTimeout(res, 50));
      }
    }),

    delayedValue: subscription(
      z.number(),
      async function* (ctx: TestContext, num: number) {
        for (let i = 0; i < 2; i++) {
          yield num * (i + 1);
        }
      },
    ),

    longQuery: query(async (ctx, signal) => {
      await new Promise((res) => setTimeout(res, 1000)); // wait one second
      if (signal.aborted) {
        console.log("Request canceled");
      }
      return "One Second Later.";
    }),
  },
);

// ============================================================================
// NESTED ROUTER (2 levels)
// ============================================================================

export const nestedRouter = router(
  (ctx: { kind: string }): TestContext => ({
    userId: "user456",
    isAdmin: ctx.kind === "admin",
    kind: "test",
  }),
  {
    simple: query((ctx: TestContext) => {
      return "from nested";
    }),

    admin: router(
      (ctx: TestContext): TestContext => ({
        ...ctx,
        isAdmin: true,
      }),
      {
        secretData: query((ctx: TestContext) => {
          return { secret: "admin-only", userId: ctx.userId };
        }),

        adminCount: subscription(async function* (ctx: TestContext) {
          for (let i = 0; i < 2; i++) {
            yield { adminId: ctx.userId, iteration: i };
          }
        }),
      },
    ),
  },
);

// ============================================================================
// DEEP NESTED ROUTER (3 levels)
// ============================================================================

export const deepNestedRouter = router(
  (ctx: { kind: string }): TestContext => ({
    userId: "user789",
    isAdmin: false,
    kind: "test",
  }),
  {
    level1: router(
      (ctx: TestContext): TestContext => ({
        ...ctx,
        userId: `${ctx.userId}-L1`,
      }),
      {
        value: query((ctx: TestContext) => {
          return `Level1: ${ctx.userId}`;
        }),

        level2: router(
          (ctx: TestContext): TestContext => ({
            ...ctx,
            userId: `${ctx.userId}-L2`,
          }),
          {
            deepValue: query((ctx: TestContext) => {
              return `Level2: ${ctx.userId}`;
            }),

            deepSub: subscription(async function* (ctx: TestContext) {
              for (let i = 0; i < 2; i++) {
                yield { depth: 2, userId: ctx.userId, index: i };
              }
            }),
          },
        ),
      },
    ),
  },
);

// ============================================================================
// TEST PAIR HELPERS
// ============================================================================

export interface TestPair<
  R extends Router<CIn, COut, Rts>,
  CIn = any,
  COut = any,
  Rts extends Routes = any,
> {
  server: NRPCServer<CIn, COut, Rts>;
  client: ReturnType<typeof getClient<R>>;
  send: (msg: NRPCRequest) => void;
  receive: (msg: NRPCResponse) => void;
  cleanup: () => Promise<void>;
}

export interface WorkerTestPair {
  worker: Worker;
  client: ReturnType<typeof getClient<typeof simpleRouter>>;
  cleanup: () => Promise<void>;
}

export interface ChildProcessTestPair {
  child: ReturnType<typeof fork>;
  client: ReturnType<typeof getClient<typeof simpleRouter>>;
  cleanup: () => Promise<void>;
}

// ============================================================================
// LOCAL TEST PAIR (in-process)
// ============================================================================

export function createLocalTestPair<T extends Router>(
  router: T,
  serverDelay: number = 0,
  clientDelay: number = 0,
): TestPair<T> {
  const server = new NRPCServer(router);

  let clientSend: (
    msg: NRPCRequest,
  ) => Promise<boolean | void> | boolean | void = () => {};
  let serverSend: (
    msg: NRPCResponse,
  ) => Promise<boolean | void> | boolean | void = () => {};

  const client = getClient<T>(
    async (msg) => {
      await clientSend(msg);
      if (clientDelay > 0) {
        setTimeout(() => {
          if (client.paused()) {
            client.drain();
          }
        }, clientDelay);
        return true;
      }
      return false;
    },
    () => {},
  );

  const connection = server.getConnection(
    { kind: "test" },
    async (msg) => {
      await serverSend(msg);
      if (serverDelay > 0) {
        setTimeout(() => {
          if (connection.paused()) {
            connection.drain();
          }
        }, serverDelay);
        return true;
      }
      return false;
    },
    () => {},
  );

  clientSend = async (msg) => {
    await connection.onMsg(msg);
    return false;
  };
  serverSend = async (msg: any) => {
    await client.onMsg(msg);
    return false;
  };

  return {
    server,
    client,
    send: clientSend,
    receive: (msg) => connection.onMsg(msg as any),
    cleanup: async () => {
      // No-op for local
    },
  };
}

// ============================================================================
// WORKER TEST PAIR
// ============================================================================

export async function createWorkerTestPair(): Promise<WorkerTestPair> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker-child.ts", import.meta.url), {
      execArgv: ["--experimental-strip-types"],
    });

    let clientReady = false;

    const client = getClient<typeof simpleRouter>(
      (msg) => {
        worker.postMessage(msg);
      },
      () => {},
    );

    worker.on("message", (msg: any) => {
      if (msg.type === "ready") {
        clientReady = true;
        resolve({
          client,
          worker,
          cleanup: async () => {
            await new Promise<void>((res) => {
              worker.once("exit", () => res());
              worker.terminate();
            });
          },
        });
      } else {
        client.onMsg(msg);
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0 && !clientReady) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

// ============================================================================
// CHILD PROCESS TEST PAIR
// ============================================================================

export async function createChildProcessTestPair(
  _routerDef?: any,
): Promise<ChildProcessTestPair> {
  return new Promise((resolve, reject) => {
    const child = fork(
      new URL("./child-process-child.mjs", import.meta.url),
      [],
      {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        serialization: "advanced",
      },
    );

    let clientReady = false;

    const client = getClient<typeof simpleRouter>(
      (msg) => {
        child.send(msg);
      },
      () => {},
    );

    child.on("message", (msg: any) => {
      if (msg?.type === "ready") {
        clientReady = true;
        resolve({
          client,
          child,
          cleanup: async () => {
            return new Promise<void>((res) => {
              child.once("exit", () => res());
              child.kill();
            });
          },
        });
      } else {
        client.onMsg(msg);
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && !clientReady) {
        reject(new Error(`Child process exited with code ${code}`));
      }
    });

    setTimeout(() => {
      if (!clientReady) {
        reject(new Error("Child process initialization timeout"));
        child.kill();
      }
    }, 5000);
  });
}

// ============================================================================
// SERIALIZATION TEST DATA
// ============================================================================

export const serializationTestData = {
  simple: {
    string: "hello",
    number: 42,
    boolean: true,
    null: null,
  },
  complex: {
    nested: {
      array: [1, 2, 3],
      object: { key: "value" },
    },
    date: new Date("2024-01-01"),
  },
  advanced: {
    buffer: Buffer.from("test"),
    typed: new Uint8Array([1, 2, 3, 4]),
  },
};
