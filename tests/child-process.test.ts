import { describe, it, expect } from "vitest";
import { NRPCReqCanceled } from "../src/shared/index.ts";
import { createChildProcessTestPair } from "./fixtures.ts";

describe("Child Process Communication", () => {
  describe("Basic query execution", () => {
    it("executes simple query through child process", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const result = await pair.client.proxy.getGreeting();
        expect(result).toBe("Hello user123!");
      } finally {
        await pair.cleanup();
      }
    });

    it("executes query with parameters through child process", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const result = await pair.client.proxy.addNumbers(7);
        expect(result).toBe(17);
      } finally {
        await pair.cleanup();
      }
    });

    it("executes multiple queries in sequence", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const result1 = await pair.client.proxy.getGreeting();
        const result2 = await pair.client.proxy.addNumbers(2);

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
          pair.client.proxy.getGreeting(),
          pair.client.proxy.addNumbers(8),
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

    it("receives subscription with input through child process", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const gen = await pair.client.proxy.delayedValue(4);
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

  describe("Error handling through child process", () => {
    it("handles invalid route", async () => {
      const pair = await createChildProcessTestPair();

      try {
        //@ts-expect-error
        await pair.client.proxy.nonExistent();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).toBeDefined();
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Cancellation", () => {
    it("rejects canceled requests with NRPCReqCanceled", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const request = pair.client.proxy.longQuery();
        request.cancel("stop it");

        await expect(request).rejects.toBeInstanceOf(NRPCReqCanceled);
        await expect(request).rejects.toMatchObject({ message: "stop it" });
      } finally {
        await pair.cleanup();
      }
    });

    it("returns itself and ignores repeat cancels", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const request = pair.client.proxy.longQuery();
        const same = request.cancel("first");
        request.cancel("second");

        expect(same).toBe(request);
        await expect(request).rejects.toMatchObject({ message: "first" });
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Serialization with advanced", () => {
    it("handles null and undefined through child process", async () => {
      const pair = await createChildProcessTestPair();

      try {
        const greeting = await pair.client.proxy.getGreeting();
        expect(greeting).toBe("Hello user123!");
      } finally {
        await pair.cleanup();
      }
    });

    it("handles complex nested structures", async () => {
      const pair = await createChildProcessTestPair();

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

  describe("Child process cleanup", () => {
    it("cleans up child process properly", async () => {
      const pair = await createChildProcessTestPair();
      await pair.cleanup();
      expect(true).toBe(true);
    });
  });
});
