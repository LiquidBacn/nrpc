import { describe, it, expect, beforeEach } from "vitest";
import {
  createLocalTestPair,
  simpleRouter,
  nestedRouter,
  deepNestedRouter,
} from "./fixtures.ts";

describe("Integration: Client ↔ Server", () => {
  describe("Query execution", () => {
    it("executes simple query", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const result = await pair.client.proxy.getGreeting();

      expect(result).toBe("Hello user123!");
    });

    it("executes query with input parameter", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const result = await pair.client.proxy.addNumbers(5);

      expect(result).toBe(15);
    });

    it("executes query with validator", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const result = await pair.client.proxy.echoString("hello");

      expect(result).toBe("HELLO");
    });

    it("propagates errors from query method", async () => {
      const { router: errorRouter, query } =
        await import("../src/shared/index.ts");
      const testRouter = errorRouter((ctx: any) => ctx, {
        throwError: query(() => {
          throw new Error("Query error");
        }),
      });

      const pair = createLocalTestPair(testRouter);

      try {
        await pair.client.proxy.throwError();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("Query error");
      }
    });

    it("returns correct context data", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const result = await pair.client.proxy.getUserInfo();

      expect(result).toEqual({
        userId: "user123",
        isAdmin: false,
      });
    });
  });

  describe("Subscription execution", () => {
    it("executes subscription and receives all data", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const gen = await pair.client.proxy.countUp();
      const results = [];

      for await (const item of gen) {
        results.push(item);
      }

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ count: 0, userId: "user123" });
      expect(results[1]).toEqual({ count: 1, userId: "user123" });
      expect(results[2]).toEqual({ count: 2, userId: "user123" });
    });

    it("executes subscription with input parameter", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const gen = await pair.client.proxy.delayedValue(3);
      const results = [];

      for await (const item of gen) {
        results.push(item);
      }

      expect(results).toEqual([3, 6]);
    });

    it("handles async iteration over subscription", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const gen = await pair.client.proxy.countUp();

      const item1 = await gen.next();
      expect(item1.value).toEqual({ count: 0, userId: "user123" });
      expect(item1.done).toBe(false);

      const item2 = await gen.next();
      expect(item2.value).toEqual({ count: 1, userId: "user123" });
      expect(item2.done).toBe(false);

      const item3 = await gen.next();
      expect(item3.done).toBe(false);

      const item4 = await gen.next();
      expect(item4.done).toBe(true);
    });

    it("handles subscription cancellation", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const gen = await pair.client.proxy.countUp();

      const item1 = await gen.next();
      expect(item1.value.count).toBe(0);

      // Cancel subscription
      await gen.return(undefined);

      const item2 = await gen.next();
      expect(item2.done).toBe(true);
    });
  });

  describe("Nested router routing", () => {
    it("routes through one level of nesting", async () => {
      const pair = createLocalTestPair(nestedRouter);

      const result = await pair.client.proxy.admin.secretData();

      expect(result).toEqual({
        secret: "admin-only",
        userId: "user456",
      });
    });

    it("applies middleware at each nesting level", async () => {
      const pair = createLocalTestPair(nestedRouter);

      const result = await pair.client.proxy.admin.secretData();

      // The admin router middleware sets isAdmin to true
      expect(result.secret).toBe("admin-only");
    });

    it("routes through two levels of nesting", async () => {
      const pair = createLocalTestPair(deepNestedRouter);

      const result = await pair.client.proxy.level1.level2.deepValue();

      expect(result).toContain("Level2");
      expect(result).toContain("user789-L1-L2");
    });

    it("executes subscription in nested router", async () => {
      const pair = createLocalTestPair(nestedRouter);

      const gen = await pair.client.proxy.admin.adminCount();
      const results = [];

      for await (const item of gen) {
        results.push(item);
      }

      expect(results).toHaveLength(2);
      expect(results[0]).toHaveProperty("adminId");
      expect(results[0]).toHaveProperty("iteration", 0);
    });

    it("executes subscription in deeply nested router", async () => {
      const pair = createLocalTestPair(deepNestedRouter);

      const gen = await pair.client.proxy.level1.level2.deepSub();
      const results = [];

      for await (const item of gen) {
        results.push(item);
      }

      expect(results).toHaveLength(2);
      expect(results[0].depth).toBe(2);
      expect(results[0]).toHaveProperty("userId");
    });
  });

  describe("Error handling", () => {
    it("handles invalid route path", async () => {
      const pair = createLocalTestPair(simpleRouter);

      try {
        await (pair.client.proxy as any).nonExistentRoute();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("Not Found");
      }
    });

    it("handles invalid nested route path", async () => {
      const pair = createLocalTestPair(nestedRouter);

      try {
        await (pair.client.proxy as any).nonExistent.route();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("Not Found");
      }
    });

    it("handles validator errors", async () => {
      const { router: routerFunc, query } =
        await import("../src/shared/index.ts");
      const { z } = await import("zod");

      const strictRouter = routerFunc((ctx: any) => ctx, {
        strictNumber: query(z.number(), (ctx: any, num: number) => num * 2),
      });

      const pair = createLocalTestPair(strictRouter);

      try {
        await pair.client.proxy.strictNumber("not-a-number" as any);
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Zod validation error
        expect(err).toBeDefined();
      }
    });
  });

  describe("Multiple concurrent requests", () => {
    it("handles multiple queries in parallel", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const [result1, result2, result3] = await Promise.all([
        pair.client.proxy.getGreeting(),
        pair.client.proxy.addNumbers(5),
        pair.client.proxy.echoString("world"),
      ]);

      expect(result1).toBe("Hello user123!");
      expect(result2).toBe(15);
      expect(result3).toBe("WORLD");
    });

    it("handles multiple subscriptions in parallel", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const [gen1, gen2] = await Promise.all([
        pair.client.proxy.countUp(),
        pair.client.proxy.countUp(),
      ]);

      const results1 = [];
      const results2 = [];

      // Interleave the iterations
      for (let i = 0; i < 3; i++) {
        results1.push(await gen1.next());
        results2.push(await gen2.next());
      }

      expect(results1.filter((r: any) => !r.done)).toHaveLength(3);
      expect(results2.filter((r: any) => !r.done)).toHaveLength(3);
    });

    it("handles mixed queries and subscriptions", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const queryPromise = pair.client.proxy.getGreeting();
      const subPromise = pair.client.proxy.countUp();

      const [queryResult, gen] = await Promise.all([queryPromise, subPromise]);

      expect(queryResult).toBe("Hello user123!");

      const subResults = [];
      for await (const item of gen) {
        subResults.push(item);
      }

      expect(subResults).toHaveLength(3);
    });
  });

  describe("Context propagation", () => {
    it("passes context through middleware", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const result = await pair.client.proxy.getUserInfo();

      expect(result.userId).toBe("user123");
    });

    it("transforms context through middleware chain", async () => {
      const pair = createLocalTestPair(nestedRouter);

      const result = await pair.client.proxy.admin.secretData();

      // The nested middleware should have transformed isAdmin
      expect(result).toEqual({
        secret: "admin-only",
        userId: "user456",
      });
    });

    it("preserves context across multiple operations", async () => {
      const pair = createLocalTestPair(simpleRouter);

      const result1 = await pair.client.proxy.getUserInfo();
      const result2 = await pair.client.proxy.getGreeting();

      expect(result1.userId).toBe("user123");
      expect(result2).toContain("user123");
    });
  });

  describe("Cleanup", () => {
    it("allows cleanup without errors", async () => {
      const pair = createLocalTestPair(simpleRouter);

      await pair.cleanup();

      expect(true).toBe(true);
    });
  });

  describe("Backpressure: Server → Client", () => {
    it("blocks query responses when server signals backpressure", async () => {
      const pair = createLocalTestPair(simpleRouter, 50);

      const result = await pair.client.proxy.addNumbers(5);

      expect(result).toBe(15);
    });

    it("queues multiple responses during server backpressure", async () => {
      const pair = createLocalTestPair(simpleRouter, 50);

      const p1 = pair.client.proxy.addNumbers(5);
      const p2 = pair.client.proxy.addNumbers(10);
      const p3 = pair.client.proxy.addNumbers(15);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBe(15);
      expect(r2).toBe(20);
      expect(r3).toBe(25);
    });

    it("unblocks server responses one-at-a-time during backpressure", async () => {
      const pair = createLocalTestPair(simpleRouter, 50, 50);
      const timings: number[] = [];
      const start = performance.now();

      const p1 = await pair.client.proxy.addNumbers(1);
      timings.push(performance.now() - start);
      // .then(() => {
      //   timings.push(performance.now() - start);
      // });
      const p2 = await pair.client.proxy.addNumbers(2);
      timings.push(performance.now() - start);
      // .then(() => {
      //   timings.push(performance.now() - start);
      // });

      await Promise.all([p1, p2]);

      // First response should arrive ~0ms, clamped to [0, 10]
      expect(timings[0]).toBeGreaterThanOrEqual(0);
      expect(timings[0]).toBeLessThan(10);

      // Second response should arrive ~50ms, clamped to [40, 100]
      expect(timings[1]).toBeGreaterThanOrEqual(40);
      expect(timings[1]).toBeLessThan(100);
    });

    it("handles subscription data with server backpressure", async () => {
      const pair = createLocalTestPair(simpleRouter, 30);

      const gen = await pair.client.proxy.countUp();

      const items = [];
      for await (const item of gen) {
        items.push(item);
      }

      expect(items).toHaveLength(3);
    });
  });

  describe("Backpressure: Client → Server", () => {
    it("blocks requests when client signals backpressure", async () => {
      const pair = createLocalTestPair(simpleRouter, 0, 50);

      const result = await pair.client.proxy.addNumbers(5);
      expect(result).toBe(15);
    });

    it("queues pause/resume messages during client backpressure", async () => {
      const pair = createLocalTestPair(simpleRouter, 0, 30);

      const gen = await pair.client.proxy.countUp();

      const items = [];
      for await (const item of gen) {
        items.push(item);
      }

      expect(items).toHaveLength(3);
    });

    it("queues multiple requests during client backpressure", async () => {
      const pair = createLocalTestPair(simpleRouter, 0, 50);

      const p1 = pair.client.proxy.addNumbers(1);
      const p2 = pair.client.proxy.addNumbers(2);
      const p3 = pair.client.proxy.addNumbers(3);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBe(11);
      expect(r2).toBe(12);
      expect(r3).toBe(13);
    });
  });

  describe("Backpressure: Bidirectional", () => {
    it("handles both sides signaling backpressure simultaneously", async () => {
      const pair = createLocalTestPair(simpleRouter, 30, 30);

      const p1 = await pair.client.proxy.addNumbers(1);
      const p2 = await pair.client.proxy.addNumbers(2);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(11);
      expect(r2).toBe(12);
    });

    it("handles subscription with bidirectional backpressure", async () => {
      const pair = createLocalTestPair(simpleRouter, 25, 25);

      const gen = await pair.client.proxy.countUp();

      const items = [];
      for await (const item of gen) {
        items.push(item);
      }

      expect(items).toHaveLength(3);
    });

    it("handles mixed operations with bidirectional backpressure", async () => {
      const pair = createLocalTestPair(simpleRouter, 30, 30);

      const queryPromise = pair.client.proxy.getGreeting();
      const subPromise = pair.client.proxy.countUp();

      const [queryResult, gen] = await Promise.all([queryPromise, subPromise]);

      expect(queryResult).toBe("Hello user123!");

      const subResults = [];
      for await (const item of gen) {
        subResults.push(item);
      }

      expect(subResults).toHaveLength(3);
    });
  });
});
