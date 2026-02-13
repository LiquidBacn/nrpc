import { Worker, isMainThread, parentPort } from "worker_threads";

import { query, router, subscription } from "./src/shared/index.ts";
import { NRPCServer } from "./src/server/index.ts";
import { getClient } from "./src/client/index.ts";
import z from "zod";

// nrpc/index.ts
let r = router(
  (ctx: { kind: string }) => {
    if (ctx.kind == "local") {
      throw new Error("no local callers!");
    }
    return { ...ctx, isAdmin: ctx.kind == "local" };
  },
  {
    queryTest: query((ctx) => {
      console.log("[router] got request for getT");
      return { hello: "world" };
    }),

    subTest: subscription(async function* () {
      for (let i = 0; i < 5; i++) {
        yield { id: i, text: `Hello ${i}!` };
        await new Promise((res) => setTimeout(res, 100));
      }
    }),

    subThrowsAt5: subscription(z.number(), async function* (ctx, max) {
      for (let i = 0; i < max; i++) {
        yield { id: i, text: `This will throw in ${5 - i}.` };

        if (i === 5) throw new Error("Oh No!");
      }

      yield "this will never get sent";
    }),

    subLargeQty: subscription(async function* () {
      for (let i = 0; i < 100; i++) {
        let t0 = performance.now();
        yield i;
        let te = performance.now();

        let delta = te - t0;
        if (delta > 11) {
          console.log(
            `[router] delay from backpressure of ${delta.toFixed(1)}ms.`,
          );
        }

        await new Promise((res) => setTimeout(res, 10));
      }
    }),
  },
);
export type AppRouter = typeof r;

if (isMainThread) {
  // nrpc/main.ts

  let child = new Worker(new URL(import.meta.url), {
    execArgv: ["--experimental-strip-types"],
  });

  let client = getClient<AppRouter>(
    (msg) => {
      child.postMessage(msg);
    },
    () => {},
  );

  child.on("message", (msg) => {
    client.onMsg(msg);
  });

  client.proxy.queryTest().then((res) => {
    console.log("[Main]", { res });
  });

  const test = async () => {
    let i = await client.proxy.subTest();

    for await (let msg of i) {
      console.log("[Main]", msg);

      await new Promise((res) => setTimeout(res, 500));
    }

    console.log("[Main] subTest ended");

    try {
      for await (let msg of await client.proxy.subThrowsAt5(10)) {
        console.log("[Main]", msg);
        await new Promise((res) => setTimeout(res, 100));
      }

      // despite subThrowsAt5 having no timeout,
      // while the client side does,
      // the client will queue the messages already sent
      // then throw the error at the correct place in the queue

      console.log("[Main] This should never run!");
    } catch (e) {
      console.log("[Main] subThrowsAt5 threw an error!", e);
    } finally {
      console.log("[Main] cleanup!");
    }

    for await (let i of await client.proxy.subLargeQty()) {
      console.log("[Main] i =", i);
      await new Promise((res) => setTimeout(res, 100));
    }
  };

  test().then(() => {
    child.unref();
  });
} else if (parentPort) {
  // nrpc/worker.ts
  const server = new NRPCServer(r);

  let conn = server.getConnection(
    { kind: "ws" },
    (msg) => {
      parentPort?.postMessage(msg);
    },
    () => {},
  );

  parentPort.on("message", (msg) => {
    conn.onMsg(msg);
  });
}
