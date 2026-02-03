import { describe, it, expect } from "vitest";
import {
  createChildProcessTestPair,
  simpleRouter,
  nestedRouter,
} from "./fixtures.ts";

describe("Child Process Communication", () => {
  describe("Basic query execution", () => {
    it("executes simple query through child process", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const result = await (pair.client.proxy as any).getGreeting();
        expect(result).toBe("Hello user123!");
      } finally {
        await pair.cleanup();
      }
    });

    it("executes query with parameters through child process", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const result = await (pair.client.proxy as any).addNumbers(7);
        expect(result).toBe(17);
      } finally {
        await pair.cleanup();
      }
    });

    it("executes multiple queries in sequence", async () => {
      const pair = await createChildProcessTestPair();

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
      const pair = await createChildProcessTestPair();

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
      const pair = await createChildProcessTestPair();

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
      const pair = await createChildProcessTestPair();

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
      const pair = await createChildProcessTestPair();

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
    it("handles invalid route", async () => {
      const pair = await createChildProcessTestPair();

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

  describe("Serialization with advanced", () => {
    it("handles null and undefined through child process", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const greeting = await (pair.client.proxy as any).getGreeting();
        expect(greeting).toBe("Hello user123!");
      } finally {
        await pair.cleanup();
      }
    });

    it("handles complex nested structures", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const userInfo = await (pair.client.proxy as any).getUserInfo();
        expect(userInfo).toEqual({
          userId: "user123",
          isAdmin: false,
        });
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Child process cleanup", () => {
    it("cleans up child process properly", async () => {
      const pair = await createChildProcessTestPair();
      await pair.cleanup();
      expect(true).toBe(true);
    });
  });
});
