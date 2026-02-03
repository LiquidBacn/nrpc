import { Worker, isMainThread, parentPort } from "worker_threads";

import { query, router, subscription } from "./src/shared/index.ts";
import { NRPCServer } from "./src/server/index.ts";
import { getClient } from "./src/client/index.ts";

let r = router(
  (ctx: { kind: string }) => {
    if (ctx.kind == "local") {
      throw new Error("no local callers!");
    }
    return { ...ctx, isAdmin: ctx.kind == "local" };
  },
  {
    getT: query((ctx) => {
      console.log("[router] got request for getT");
      return { hello: "world" };
    }),

    s: subscription(async function* () {
      for (let i = 0; i < 15; i++) {
        yield { id: i, text: `Hello ${i}!` };
        await new Promise((res) => setTimeout(res, 500));
      }
    }),
  },
);
type AppRouter = typeof r;

if (isMainThread) {
  let s = new NRPCServer(r);

  let child = new Worker(new URL(import.meta.url), {
    execArgv: ["--experimental-strip-types"],
  });

  let conn = s.getConnection(
    { kind: "ws" },
    (msg) => {
      // console.log("[Main] send()", msg);
      child.postMessage(msg);
    },
    () => {},
  );

  child.on("message", (msg) => {
    // console.log("[Main] onMsg", msg);
    conn.onMsg(msg);
  });

  setTimeout(() => {
    child.unref();
  }, 1000);
} else if (parentPort) {
  let client = getClient<AppRouter>(
    (msg) => {
      parentPort?.postMessage(msg);
    },
    () => {},
  );

  parentPort.on("message", (msg) => {
    client.onMsg(msg);
  });

  // parentPort.postMessage({ id: "0", type: "request", path: ["s"] });

  client.proxy.getT().then((a) => {
    console.log("[Child]", { a });
  });

  const test = async () => {
    let i = await client.proxy.s();

    for await (let msg of i) {
      console.log("[Child]", { msg });

      await new Promise((res) => setTimeout(res, 1000));
    }
  };

  test();
}
