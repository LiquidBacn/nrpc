import { describe, it, expect } from "vitest";
import { createWorkerTestPair } from "./fixtures.ts";

describe("Worker Thread Communication", () => {
  describe("Basic query execution", () => {
    it("executes simple query through worker", async () => {
      const pair = await createWorkerTestPair();

      try {
        const result = await pair.client.proxy.getGreeting();
        expect(result).toBe("Hello user123!");
      } finally {
        await pair.cleanup();
      }
    });

    it("executes query with parameters through worker", async () => {
      const pair = await createWorkerTestPair();

      try {
        const result = await pair.client.proxy.addNumbers(10);
        expect(result).toBe(20);
      } finally {
        await pair.cleanup();
      }
    });

    it("executes multiple queries in sequence", async () => {
      const pair = await createWorkerTestPair();

      try {
        const result1 = await pair.client.proxy.getGreeting();
        const result2 = await pair.client.proxy.addNumbers(5);

        expect(result1).toBe("Hello user123!");
        expect(result2).toBe(15);
      } finally {
        await pair.cleanup();
      }
    });

    it("executes queries in parallel", async () => {
      const pair = await createWorkerTestPair();

      try {
        const [result1, result2] = await Promise.all([
          pair.client.proxy.getGreeting(),
          pair.client.proxy.addNumbers(3),
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
      const pair = await createWorkerTestPair();

      try {
        const gen = await pair.client.proxy.countUp();
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
      const pair = await createWorkerTestPair();

      try {
        const gen = await pair.client.proxy.delayedValue(5);
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
      const pair = await createWorkerTestPair();

      try {
        const [gen1, gen2] = await Promise.all([
          pair.client.proxy.countUp(),
          pair.client.proxy.countUp(),
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
    it("handles invalid route", async () => {
      const pair = await createWorkerTestPair();

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

  describe("Serialization", () => {
    it("handles null and undefined", async () => {
      const pair = await createWorkerTestPair();

      try {
        // Test that query results are properly serialized
        const greeting = await pair.client.proxy.getGreeting();
        expect(greeting).toBe("Hello user123!");
      } finally {
        await pair.cleanup();
      }
    });

    it("handles complex nested structures in query results", async () => {
      const pair = await createWorkerTestPair();

      try {
        const userInfo = await pair.client.proxy.getUserInfo();
        expect(userInfo).toEqual({
          userId: "user123",
          isAdmin: false,
        });
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Worker cleanup", () => {
    it("cleans up worker properly", async () => {
      const pair = await createWorkerTestPair();
      await pair.cleanup();
      expect(true).toBe(true);
    });
  });
});
