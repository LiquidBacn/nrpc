import { describe, expect, it } from "vitest";
import { getClient } from "../src/client/index.ts";
import { NRPCBalancer } from "../src/balancer/index.ts";
import { NRPCServer } from "../src/server/index.ts";
import { event, query, router, subscription } from "../src/shared/index.ts";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

type BackendContext = { name: string };

function createTestRouter(processed: number[], aborts: { value: number }) {
  return router((ctx: BackendContext) => ctx, {
    who: query((ctx: BackendContext) => ctx.name),
    work: query(
      (input) => Number(input),
      async (ctx: BackendContext, n: number) => {
        processed.push(n);
        await sleep(5);
        return `${ctx.name}:${n}`;
      },
    ),
    holdSub: subscription(async function* (ctx: BackendContext) {
      let i = 0;
      while (true) {
        yield `${ctx.name}:${i++}`;
        await sleep(5);
      }
    }),
    cancelable: query(async (ctx, signal) => {
      while (!signal.aborted) {
        await sleep(5);
      }
      aborts.value += 1;
      return `${ctx.name}:aborted`;
    }),
    ping: event<string>(),
  });
}

function addBackend(
  balancer: NRPCBalancer,
  server: NRPCServer<any>,
  ctx: BackendContext,
  id: string,
) {
  let backendHandle: ReturnType<NRPCBalancer["addBackend"]>;

  const connection = server.getConnection(
    ctx,
    async (msg) => {
      await backendHandle.onMsg(msg);
      return false;
    },
    () => {
      backendHandle.onClose(new Error(`Backend ${id} closed.`));
    },
  );

  backendHandle = balancer.addBackend({
    id,
    send: async (msg) => {
      await connection.onMsg(msg);
      return false;
    },
  });

  return { connection, backendHandle };
}

function createClient<R extends ReturnType<typeof createTestRouter>>(balancer: NRPCBalancer) {
  let balConnection: ReturnType<NRPCBalancer["getConnection"]>;

  const client = getClient<R>(
    async (msg) => {
      await balConnection.onMsg(msg);
      return false;
    },
    () => {
      balConnection.onClose();
    },
  );

  balConnection = balancer.getConnection(
    async (msg) => {
      await client.onMsg(msg);
      return false;
    },
    () => {
      client.onClose();
    },
  );

  return { client, balConnection };
}

describe("NRPCBalancer", () => {
  it("routes requests to first available idle backends", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const { client } = createClient<typeof serverA.router>(balancer);

    const [first, second] = await Promise.all([client.proxy.who(), client.proxy.who()]);

    expect(first).toBe("A");
    expect(second).toBe("B");
  });

  it("queues requests FIFO when all backends are busy", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    addBackend(balancer, serverA, { name: "A" }, "A");

    const { client } = createClient<typeof serverA.router>(balancer);

    const sub = await client.proxy.holdSub();
    await sub.next();

    const p1 = client.proxy.work(1);
    const p2 = client.proxy.work(2);

    let settled = false;
    p1.then(() => {
      settled = true;
    });

    await sleep(20);
    expect(settled).toBe(false);

    await sub.return(undefined);

    const r1 = await p1;
    const r2 = await p2;

    expect(r1).toBe("A:1");
    expect(r2).toBe("A:2");
    expect(processed).toEqual([1, 2]);
  });

  it("supports dedicated lease and release", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const c1 = createClient<typeof serverA.router>(balancer);
    const c2 = createClient<typeof serverA.router>(balancer);

    const lease = c1.balConnection.acquireDedicated();
    expect(lease).toBe("A");

    const fromLeased = await c1.client.proxy.who();
    const fromPool = await c2.client.proxy.who();

    expect(fromLeased).toBe("A");
    expect(fromPool).toBe("B");

    c1.balConnection.releaseDedicated();

    const afterRelease = await c2.client.proxy.who();
    expect(afterRelease).toBe("A");
  });

  it("auto-releases dedicated lease on frontend connection close", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const c1 = createClient<typeof serverA.router>(balancer);
    const c2 = createClient<typeof serverA.router>(balancer);

    c1.balConnection.acquireDedicated();
    c1.balConnection.onClose();

    const picked = await c2.client.proxy.who();
    expect(picked).toBe("A");
  });

  it("forwards request.cancel and frees backend", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    addBackend(balancer, serverA, { name: "A" }, "A");

    const { client } = createClient<typeof serverA.router>(balancer);

    const req = client.proxy.cancelable();
    req.cancel("stop");

    await expect(req).rejects.toBeDefined();
    await sleep(20);

    const who = await client.proxy.who();
    expect(who).toBe("A");
  });

  it("fails active subscription when backend closes", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const { backendHandle } = addBackend(balancer, serverA, { name: "A" }, "A");

    const { client } = createClient<typeof serverA.router>(balancer);

    const sub = await client.proxy.holdSub();
    await sub.next();

    backendHandle.onClose(new Error("boom"));

    await expect(sub.next()).rejects.toMatchObject({ message: "boom" });
  });

  it("invalidates dedicated lease when leased backend dies", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    const a = addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const c1 = createClient<typeof serverA.router>(balancer);

    c1.balConnection.acquireDedicated();
    a.backendHandle.onClose(new Error("dedicated down"));

    await expect(c1.client.proxy.who()).rejects.toMatchObject({
      message: "Dedicated backend unavailable.",
    });

    const next = await c1.client.proxy.who();
    expect(next).toBe("B");
  });
});
