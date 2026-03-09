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
    maybeFail: query((ctx: BackendContext) => {
      if (ctx.name === "B") {
        throw new Error("backend B failed");
      }
      return ctx.name;
    }),
    delayedWho: query(
      (input) => Number(input),
      async (ctx: BackendContext, ms: number) => {
        await sleep(ctx.name === "A" ? ms * 2 : ms);
        return ctx.name;
      },
    ),
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

function createRawConnection(balancer: NRPCBalancer) {
  const messages: any[] = [];
  const connection = balancer.getConnection(
    async (msg) => {
      messages.push(msg);
      return false;
    },
    () => {},
  );

  return { connection, messages };
}

describe("NRPCBalancer", () => {
  it("routes pooled requests FIFO when all backends are busy", async () => {
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

  it("queues reservations until a backend claims them", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();
    const pendingServer = new NRPCServer(createTestRouter(processed, aborts));
    const { client } = createClient<typeof pendingServer.router>(balancer);

    let resolved = false;
    const leasePromise = client.reserveBackend().then((lease) => {
      resolved = true;
      return lease;
    });

    await sleep(20);
    expect(resolved).toBe(false);

    addBackend(balancer, pendingServer, { name: "A" }, "A");

    const lease = await leasePromise;
    expect(lease.bid).toBe("A");
    await expect(lease.proxy.who()).resolves.toBe("A");
  });

  it("supports multiple simultaneous reservations on one connection", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const { client } = createClient<typeof serverA.router>(balancer);

    const [leaseA, leaseB] = await Promise.all([
      client.reserveBackend(),
      client.reserveBackend(),
    ]);

    expect(new Set([leaseA.bid, leaseB.bid])).toEqual(new Set(["A", "B"]));
    await expect(leaseA.proxy.who()).resolves.toBe(leaseA.bid);
    await expect(leaseB.proxy.who()).resolves.toBe(leaseB.bid);
  });

  it("routes leased requests by bid and rejects foreign bids", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const owner = createClient<typeof serverA.router>(balancer);
    const foreign = createRawConnection(balancer);

    const lease = await owner.client.reserveBackend();
    await expect(lease.proxy.who()).resolves.toBe(lease.bid);

    await foreign.connection.onMsg({
      id: "raw_1",
      type: "request",
      path: ["who"],
      input: undefined,
      bid: lease.bid,
    });

    await sleep(10);
    expect(foreign.messages).toHaveLength(1);
    expect(foreign.messages[0]).toMatchObject({
      id: "raw_1",
      type: "error",
    });
    expect(foreign.messages[0].error.message).toBe(
      "Dedicated backend unavailable.",
    );
  });

  it("orders lease release behind queued leased work", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    addBackend(balancer, serverA, { name: "A" }, "A");

    const { client } = createClient<typeof serverA.router>(balancer);
    const lease = await client.reserveBackend();

    const sub = await lease.proxy.holdSub();
    await sub.next();

    const work = lease.proxy.work(1);
    let released = false;
    const releasing = lease.release().then(() => {
      released = true;
    });

    await expect(lease.proxy.who()).rejects.toMatchObject({
      message: "Backend lease released.",
    });
    await sleep(20);
    expect(released).toBe(false);

    await sub.return(undefined);

    await expect(work).resolves.toBe("A:1");
    await releasing;
    expect(released).toBe(true);
  });

  it("releases active reservations when the frontend connection closes", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const owner = createClient<typeof serverA.router>(balancer);
    const other = createClient<typeof serverA.router>(balancer);

    await owner.client.reserveBackend();
    owner.balConnection.onClose();

    const [leaseA, leaseB] = await Promise.all([
      other.client.reserveBackend(),
      other.client.reserveBackend(),
    ]);

    expect(new Set([leaseA.bid, leaseB.bid])).toEqual(new Set(["A", "B"]));
  });

  it("forwards request.cancel and frees a pooled backend", async () => {
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

  it("fails active subscriptions and queued leased work when a reserved backend closes", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    const a = addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const { client } = createClient<typeof serverA.router>(balancer);
    const lease = await client.reserveBackend();

    const sub = await lease.proxy.holdSub();
    await sub.next();

    const queued = lease.proxy.work(7);

    a.backendHandle.onClose(new Error("boom"));

    await expect(sub.next()).rejects.toMatchObject({ message: "boom" });
    await expect(queued).rejects.toMatchObject({
      message: "Dedicated backend unavailable.",
    });

    const pooled = await client.proxy.who();
    expect(pooled).toBe("B");
  });

  it("broadcast query hits every live backend and returns ordered per-backend entries", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const { client } = createClient<typeof serverA.router>(balancer);
    const result = await client.broadcast.who();

    expect(result).toEqual([
      { backendId: "A", type: "result", value: "A" },
      { backendId: "B", type: "result", value: "B" },
    ]);
  });

  it("broadcast includes a backend leased by another connection", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const owner = createClient<typeof serverA.router>(balancer);
    const other = createClient<typeof serverA.router>(balancer);

    const lease = await owner.client.reserveBackend();
    expect(["A", "B"]).toContain(lease.bid);

    const result = await other.client.broadcast.who();
    expect(result).toEqual([
      { backendId: "A", type: "result", value: "A" },
      { backendId: "B", type: "result", value: "B" },
    ]);
  });

  it("broadcast with zero live backends resolves to an empty array", async () => {
    const balancer = new NRPCBalancer();
    const { client } = createClient<any>(balancer);

    await expect((client.broadcast as any).who()).resolves.toEqual([]);
  });

  it("broadcast result ordering matches backend iteration order, not completion order", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const { client } = createClient<typeof serverA.router>(balancer);
    const result = await client.broadcast.delayedWho(10);

    expect(result.map((entry) => entry.backendId)).toEqual(["A", "B"]);
    expect(result).toEqual([
      { backendId: "A", type: "result", value: "A" },
      { backendId: "B", type: "result", value: "B" },
    ]);
  });

  it("broadcast is queued ahead of already-queued pooled work", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    addBackend(balancer, serverA, { name: "A" }, "A");

    const { client } = createClient<typeof serverA.router>(balancer);
    const sub = await client.proxy.holdSub();
    await sub.next();

    const order: string[] = [];
    const queued = client.proxy.work(1).then((value) => {
      order.push("work");
      return value;
    });
    const broadcast = client.broadcast.who().then((value) => {
      order.push("broadcast");
      return value;
    });

    await sleep(20);
    expect(order).toEqual([]);

    await sub.return(undefined);

    await expect(broadcast).resolves.toEqual([
      { backendId: "A", type: "result", value: "A" },
    ]);
    await expect(queued).resolves.toBe("A:1");
    expect(order[0]).toBe("broadcast");
  });

  it("broadcast is queued ahead of already-queued lease work on a leased backend", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    addBackend(balancer, serverA, { name: "A" }, "A");

    const owner = createClient<typeof serverA.router>(balancer);
    const other = createClient<typeof serverA.router>(balancer);

    const lease = await owner.client.reserveBackend();
    const sub = await lease.proxy.holdSub();
    await sub.next();

    const order: string[] = [];
    const queued = lease.proxy.work(1).then((value) => {
      order.push("work");
      return value;
    });
    const broadcast = other.client.broadcast.who().then((value) => {
      order.push("broadcast");
      return value;
    });

    await sleep(20);
    expect(order).toEqual([]);

    await sub.return(undefined);

    await expect(broadcast).resolves.toEqual([
      { backendId: "A", type: "result", value: "A" },
    ]);
    await expect(queued).resolves.toBe("A:1");
    expect(order[0]).toBe("broadcast");
  });

  it("backend close during broadcast yields an error entry for that backend and result entries for the others", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    const a = addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const { client } = createClient<typeof serverA.router>(balancer);
    const resultPromise = client.broadcast.delayedWho(30);

    await sleep(5);
    a.backendHandle.onClose(new Error("boom"));

    const result = await resultPromise;
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      backendId: "A",
      type: "error",
    });
    expect((result[0] as any).error.message).toBe("boom");
    expect(result[1]).toEqual({
      backendId: "B",
      type: "result",
      value: "B",
    });
  });

  it("canceling a broadcast cancels unfinished children", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const { client } = createClient<typeof serverA.router>(balancer);
    const req = client.broadcast.cancelable();
    await sleep(10);
    req.cancel("stop");

    await expect(req).rejects.toBeDefined();
    await sleep(30);
    expect(aborts.value).toBe(2);
  });

  it("bypassing types to broadcast a subscription or event path yields per-backend error entries", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const raw = createRawConnection(balancer);

    await raw.connection.onMsg({
      id: "sub_broadcast",
      type: "request.broadcast",
      path: ["holdSub"],
      input: undefined,
    });
    await raw.connection.onMsg({
      id: "event_broadcast",
      type: "request.broadcast",
      path: ["ping"],
      input: undefined,
    });

    await sleep(20);

    expect(raw.messages).toHaveLength(2);
    expect(raw.messages[0]).toMatchObject({
      id: "sub_broadcast",
      type: "result",
    });
    expect(raw.messages[1]).toMatchObject({
      id: "event_broadcast",
      type: "result",
    });
    for (const message of raw.messages) {
      expect(message.payload).toHaveLength(2);
      for (const entry of message.payload) {
        expect(entry.type).toBe("error");
        expect(entry.error.message).toBe("Broadcast only supports query routes.");
      }
    }
  });

  it("integration: mixed broadcast result contains result and error entries", async () => {
    const processed: number[] = [];
    const aborts = { value: 0 };
    const balancer = new NRPCBalancer();

    const serverA = new NRPCServer(createTestRouter(processed, aborts));
    const serverB = new NRPCServer(createTestRouter(processed, aborts));

    addBackend(balancer, serverA, { name: "A" }, "A");
    addBackend(balancer, serverB, { name: "B" }, "B");

    const { client } = createClient<typeof serverA.router>(balancer);
    const result = await client.broadcast.maybeFail();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      backendId: "A",
      type: "result",
      value: "A",
    });
    expect(result[1]).toMatchObject({
      backendId: "B",
      type: "error",
    });
    expect((result[1] as any).error.message).toBe("backend B failed");
  });
});
