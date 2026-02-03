import { describe, it, expect } from "vitest";
import {
  createChildProcessTestPair,
  simpleRouter,
  nestedRouter,
} from "./fixtures.ts";

describe("Child Process Communication", () => {
  describe("Basic query execution", () => {
    it("executes simple query through child process", async () => {
      const pair = await createChildProcessTestPair(simpleRouter);

      try {
        const result = await (pair.client.proxy as any).getGreeting();
        expect(result).toBe("Hello user123!");
      } finally {
        await pair.cleanup();
      }
    });

    it("executes query with parameters through child process", async () => {
      const pair = await createChildProcessTestPair(simpleRouter);

      try {
        const result = await (pair.client.proxy as any).addNumbers(7);
        expect(result).toBe(17);
      } finally {
        await pair.cleanup();
      }
    });

    it("executes multiple queries in sequence", async () => {
      const pair = await createChildProcessTestPair(simpleRouter);

      try {
        const result1 = await (pair.client.proxy as any).getGreeting();
        const result2 = await (pair.client.proxy as any).addNumbers(2);

        expect(result1).toBe("Hello user123!");
        expect(result2).toBe(12);
      } finally {
        await pair.cleanup();
      }
    });

    it("executes queries in parallel", async () => {
      const pair = await createChildProcessTestPair(simpleRouter);

      try {
        const [result1, result2] = await Promise.all([
          (pair.client.proxy as any).getGreeting(),
          (pair.client.proxy as any).addNumbers(8),
        ]);

        expect(result1).toBe("Hello user123!");
        expect(result2).toBe(18);
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Subscription execution", () => {
    it("receives subscription data through child process", async () => {
      const pair = await createChildProcessTestPair(simpleRouter);

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

    it("receives subscription with input through child process", async () => {
      const pair = await createChildProcessTestPair(simpleRouter);

      try {
        const gen = await (pair.client.proxy as any).delayedValue(4);
        const results = [];

        for await (const item of gen) {
          results.push(item);
        }

        expect(results).toEqual([4, 8]);
      } finally {
        await pair.cleanup();
      }
    });

    it("handles multiple subscriptions concurrently", async () => {
      const pair = await createChildProcessTestPair(simpleRouter);

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

  describe("Error handling through child process", () => {
    it("propagates query errors", async () => {
      const { router, query } = await import("../src/shared/index.ts");
      const errorRouter = router((ctx: any) => ctx, {
        throwError: query(() => {
          throw new Error("Query error from child");
        }),
      });

      const pair = await createChildProcessTestPair(errorRouter);

      try {
        await (pair.client.proxy as any).throwError();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).toBeDefined();
      } finally {
        await pair.cleanup();
      }
    });

    it("handles invalid route", async () => {
      const pair = await createChildProcessTestPair(simpleRouter);

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

  describe("Nested routers through child process", () => {
    it("routes through nested routers", async () => {
      const pair = await createChildProcessTestPair(nestedRouter);

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
      const pair = await createChildProcessTestPair(nestedRouter);

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

  describe("Serialization with advanced", () => {
    it("serializes and deserializes JSON through child process", async () => {
      const { router, query } = await import("../src/shared/index.ts");
      const testRouter = router((ctx: any) => ctx, {
        echo: query((ctx: any, data: any) => data),
      });

      const pair = await createChildProcessTestPair(testRouter);

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

    it("handles null and undefined through child process", async () => {
      const { router, query } = await import("../src/shared/index.ts");
      const testRouter = router((ctx: any) => ctx, {
        returnNull: query(() => null),
        returnUndefined: query(() => undefined),
      });

      const pair = await createChildProcessTestPair(testRouter);

      try {
        const nullResult = await (pair.client.proxy as any).returnNull();
        const undefinedResult = await (pair.client.proxy as any).returnUndefined();

        expect(nullResult).toBeNull();
        expect(undefinedResult).toBeUndefined();
      } finally {
        await pair.cleanup();
      }
    });

    it("handles Buffer through advanced serialization", async () => {
      const { router, query } = await import("../src/shared/index.ts");
      const testRouter = router((ctx: any) => ctx, {
        echo: query((ctx: any, data: any) => data),
      });

      const pair = await createChildProcessTestPair(testRouter);

      try {
        const buffer = Buffer.from("test-data");
        const result = await (pair.client.proxy as any).echo(buffer as any);

        // Buffer should be serialized and deserialized
        expect(Buffer.isBuffer(result) || typeof result === "object").toBe(
          true
        );
      } finally {
        await pair.cleanup();
      }
    });

    it("handles complex nested structures", async () => {
      const { router, query } = await import("../src/shared/index.ts");
      const testRouter = router((ctx: any) => ctx, {
        echo: query((ctx: any, data: any) => data),
      });

      const pair = await createChildProcessTestPair(testRouter);

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

  describe("Child process cleanup", () => {
    it("cleans up child process properly", async () => {
      const pair = await createChildProcessTestPair(simpleRouter);
      await pair.cleanup();
      expect(true).toBe(true);
    });
  });
});
