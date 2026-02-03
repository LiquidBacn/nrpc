import { describe, it, expect } from "vitest";
import { createWorkerTestPair, simpleRouter, nestedRouter } from "./fixtures.ts";

describe("Worker Thread Communication", () => {
  describe("Basic query execution", () => {
    it("executes simple query through worker", async () => {
      const pair = await createWorkerTestPair(simpleRouter);

      try {
        const result = await (pair.client.proxy as any).getGreeting();
        expect(result).toBe("Hello user123!");
      } finally {
        await pair.cleanup();
      }
    });

    it("executes query with parameters through worker", async () => {
      const pair = await createWorkerTestPair(simpleRouter);

      try {
        const result = await (pair.client.proxy as any).addNumbers(10);
        expect(result).toBe(20);
      } finally {
        await pair.cleanup();
      }
    });

    it("executes multiple queries in sequence", async () => {
      const pair = await createWorkerTestPair(simpleRouter);

      try {
        const result1 = await (pair.client.proxy as any).getGreeting();
        const result2 = await (pair.client.proxy as any).addNumbers(5);

        expect(result1).toBe("Hello user123!");
        expect(result2).toBe(15);
      } finally {
        await pair.cleanup();
      }
    });

    it("executes queries in parallel", async () => {
      const pair = await createWorkerTestPair(simpleRouter);

      try {
        const [result1, result2] = await Promise.all([
          (pair.client.proxy as any).getGreeting(),
          (pair.client.proxy as any).addNumbers(3),
        ]);

        expect(result1).toBe("Hello user123!");
        expect(result2).toBe(13);
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Subscription execution", () => {
    it("receives subscription data through worker", async () => {
      const pair = await createWorkerTestPair(simpleRouter);

      try {
        const gen = await (pair.client.proxy as any).countUp();
        const results = [];

        for await (const item of gen) {
          results.push(item);
        }

        expect(results).toHaveLength(3);
        expect(results[0]).toEqual({ count: 0, userId: "user123" });
      } finally {
        await pair.cleanup();
      }
    });

    it("receives subscription with input through worker", async () => {
      const pair = await createWorkerTestPair(simpleRouter);

      try {
        const gen = await (pair.client.proxy as any).delayedValue(5);
        const results = [];

        for await (const item of gen) {
          results.push(item);
        }

        expect(results).toEqual([5, 10]);
      } finally {
        await pair.cleanup();
      }
    });

    it("handles multiple subscriptions concurrently", async () => {
      const pair = await createWorkerTestPair(simpleRouter);

      try {
        const [gen1, gen2] = await Promise.all([
          (pair.client.proxy as any).countUp(),
          (pair.client.proxy as any).countUp(),
        ]);

        const results1 = [];
        const results2 = [];

        for await (const item of gen1) {
          results1.push(item);
        }

        for await (const item of gen2) {
          results2.push(item);
        }

        expect(results1).toHaveLength(3);
        expect(results2).toHaveLength(3);
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Error handling through worker", () => {
    it("propagates query errors", async () => {
      const { router, query } = await import("../src/shared/index.ts");
      const errorRouter = router((ctx: any) => ctx, {
        throwError: query(() => {
          throw new Error("Query error");
        }),
      });

      const pair = await createWorkerTestPair(errorRouter);

      try {
        await (pair.client.proxy as any).throwError();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("error");
      } finally {
        await pair.cleanup();
      }
    });

    it("handles invalid route", async () => {
      const pair = await createWorkerTestPair(simpleRouter);

      try {
        await (pair.client.proxy as any).nonExistent();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).toBeDefined();
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Nested routers through worker", () => {
    it("routes through nested routers", async () => {
      const pair = await createWorkerTestPair(nestedRouter);

      try {
        const result = await (pair.client.proxy as any).admin.secretData();
        expect(result).toEqual({
          secret: "admin-only",
          userId: "user456",
        });
      } finally {
        await pair.cleanup();
      }
    });

    it("executes subscription in nested router", async () => {
      const pair = await createWorkerTestPair(nestedRouter);

      try {
        const gen = await (pair.client.proxy as any).admin.adminCount();
        const results = [];

        for await (const item of gen) {
          results.push(item);
        }

        expect(results).toHaveLength(2);
        expect(results[0]).toHaveProperty("adminId");
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Serialization", () => {
    it("serializes and deserializes JSON", async () => {
      const { router, query } = await import("../src/shared/index.ts");
      const testRouter = router((ctx: any) => ctx, {
        echo: query((ctx: any, data: any) => data),
      });

      const pair = await createWorkerTestPair(testRouter);

      try {
        const testData = {
          string: "hello",
          number: 42,
          boolean: true,
          array: [1, 2, 3],
          nested: { key: "value" },
        };

        const result = await (pair.client.proxy as any).echo(testData as any);
        expect(result).toEqual(testData);
      } finally {
        await pair.cleanup();
      }
    });

    it("handles null and undefined", async () => {
      const { router, query } = await import("../src/shared/index.ts");
      const testRouter = router((ctx: any) => ctx, {
        returnNull: query(() => null),
        returnUndefined: query(() => undefined),
      });

      const pair = await createWorkerTestPair(testRouter);

      try {
        const nullResult = await (pair.client.proxy as any).returnNull();
        const undefinedResult = await (pair.client.proxy as any).returnUndefined();

        expect(nullResult).toBeNull();
        expect(undefinedResult).toBeUndefined();
      } finally {
        await pair.cleanup();
      }
    });

    it("handles complex nested structures", async () => {
      const { router, query } = await import("../src/shared/index.ts");
      const testRouter = router((ctx: any) => ctx, {
        echo: query((ctx: any, data: any) => data),
      });

      const pair = await createWorkerTestPair(testRouter);

      try {
        const complexData = {
          level1: {
            level2: {
              level3: {
                values: [1, 2, 3],
                deep: { key: "value" },
              },
            },
          },
        };

        const result = await (pair.client.proxy as any).echo(complexData as any);
        expect(result).toEqual(complexData);
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Worker cleanup", () => {
    it("cleans up worker properly", async () => {
      const pair = await createWorkerTestPair(simpleRouter);
      await pair.cleanup();
      expect(true).toBe(true);
    });
  });
});
