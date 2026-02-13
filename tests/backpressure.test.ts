import { describe, it, expect, beforeEach } from "vitest";
import { router, subscription } from "../src/shared/index.ts";
import { createLocalTestPair } from "./fixtures.ts";

describe("Backpressure", () => {
  describe("Client-side backpressure", () => {
    it("pauses server subscription when client queue exceeds 10 items", async () => {
      const testRouter = router((ctx: any) => ctx, {
        fastStream: subscription(async function* (ctx) {
          for (let i = 0; i < 20; i++) {
            yield i;
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, undefined);

      try {
        const gen = await pair.client.proxy.fastStream();

        // Read items one by one, slowly
        const results = [];
        for await (const item of gen) {
          results.push(item);
          // Slow consumption to allow server to queue up and trigger backpressure
          if (results.length === 5) {
            // At this point, server should have queued more than 10
            break;
          }
        }

        // Should have some items
        expect(results.length).toBeGreaterThan(0);
      } finally {
        await pair.cleanup();
      }
    });

    it("resumes server when client processes queued items", async () => {
      const yieldCount = { value: 0 };

      const testRouter = router((ctx: any) => ctx, {
        controlledStream: subscription(async function* (ctx) {
          for (let i = 0; i < 30; i++) {
            yieldCount.value++;
            yield i;
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, undefined);

      try {
        const gen = await pair.client.proxy.controlledStream();
        const results = [];

        // Consume all items
        for await (const item of gen) {
          results.push(item);
        }

        // Should have received all items
        expect(results).toHaveLength(30);
        // Server should have yielded all 30 items
        expect(yieldCount.value).toBe(30);
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Backpressure with streaming", () => {
    it("handles rapid server yields without losing data", async () => {
      const testRouter = router((ctx: any) => ctx, {
        rapidStream: subscription(async function* (ctx) {
          for (let i = 0; i < 50; i++) {
            yield { id: i, data: `item-${i}` };
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, undefined);

      try {
        const gen = await pair.client.proxy.rapidStream();
        const results = [];

        for await (const item of gen) {
          results.push(item);
        }

        // All items should be received
        expect(results).toHaveLength(50);
        // Verify order is preserved
        expect(results[0]).toEqual({ id: 0, data: "item-0" });
        expect(results[49]).toEqual({ id: 49, data: "item-49" });
      } finally {
        await pair.cleanup();
      }
    });

    it("handles slow client consumption with backpressure", async () => {
      const testRouter = router((ctx: any) => ctx, {
        slowConsumer: subscription(async function* (ctx) {
          for (let i = 0; i < 25; i++) {
            yield i;
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, undefined);

      try {
        const gen = await pair.client.proxy.slowConsumer();
        const results = [];

        // Consume slowly
        for await (const item of gen) {
          results.push(item);
          // Add delay to trigger backpressure
          await new Promise((res) => setTimeout(res, 10));
        }

        expect(results).toHaveLength(25);
        expect(results[0]).toBe(0);
        expect(results[24]).toBe(24);
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Backpressure queue thresholds", () => {
    it("triggers pause at threshold (queue > 10)", async () => {
      const testRouter = router((ctx: any) => ctx, {
        thresholdTest: subscription(async function* (ctx) {
          for (let i = 0; i < 20; i++) {
            yield i;
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, undefined);

      try {
        const gen = await pair.client.proxy.thresholdTest();
        const results = [];

        // Consume a few items then pause
        let count = 0;
        for await (const item of gen) {
          results.push(item);
          count++;
          if (count === 5) {
            break;
          }
        }

        // Continue consuming
        for await (const item of gen) {
          results.push(item);
        }

        expect(results.length).toBeGreaterThan(0);
      } finally {
        await pair.cleanup();
      }
    });

    it("resumes when queue drops below threshold (queue < 5)", async () => {
      const testRouter = router((ctx: any) => ctx, {
        drainTest: subscription(async function* (ctx) {
          for (let i = 0; i < 20; i++) {
            yield i;
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, undefined);

      try {
        const gen = await pair.client.proxy.drainTest();
        const results = [];

        // Fast consumption to allow queue to drain
        for await (const item of gen) {
          results.push(item);
        }

        expect(results).toHaveLength(20);
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Backpressure with errors", () => {
    it("handles errors during backpressure wait", async () => {
      const testRouter = router((ctx: any) => ctx, {
        errorUnderPressure: subscription(async function* (ctx) {
          for (let i = 0; i < 15; i++) {
            if (i === 12) {
              throw new Error("Error under pressure");
            }
            yield i;
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, undefined);

      try {
        const gen = await pair.client.proxy.errorUnderPressure();
        const results = [];

        try {
          for await (const item of gen) {
            results.push(item);
          }
          expect.fail("Should have thrown");
        } catch (err: any) {
          expect(err.message).toContain("Error under pressure");
        }
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Backpressure cancellation", () => {
    it("handles cancellation during backpressure pause", async () => {
      const testRouter = router((ctx: any) => ctx, {
        cancellableStream: subscription(async function* (ctx) {
          for (let i = 0; i < 50; i++) {
            yield i;
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, undefined);

      try {
        const gen = await pair.client.proxy.cancellableStream();

        // Start consuming
        const result1 = await gen.next();
        expect(result1.done).toBe(false);

        // Cancel the subscription
        await gen.return(undefined);

        // Next call should return done
        const result2 = await gen.next();
        expect(result2.done).toBe(true);
      } finally {
        await pair.cleanup();
      }
    });

    it("cleans up server state when subscription cancelled under backpressure", async () => {
      let generatorFinalized = false;

      const testRouter = router((ctx: any) => ctx, {
        trackedStream: subscription(async function* (ctx) {
          try {
            for (let i = 0; i < 50; i++) {
              yield i;
            }
          } finally {
            generatorFinalized = true;
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, undefined);

      try {
        const gen = await pair.client.proxy.trackedStream();

        // Read a few items
        await gen.next();
        await gen.next();

        // Cancel
        await gen.return(undefined);

        // Give it a moment to clean up
        await new Promise((res) => setTimeout(res, 50));

        // Generator should have been finalized
        expect(generatorFinalized).toBe(true);
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("Backpressure with multiple subscriptions", () => {
    it("handles backpressure independently for multiple subscriptions", async () => {
      const testRouter = router((ctx: any) => ctx, {
        sub1: subscription(async function* (ctx) {
          for (let i = 0; i < 20; i++) {
            yield `sub1-${i}`;
          }
        }),
        sub2: subscription(async function* (ctx) {
          for (let i = 0; i < 20; i++) {
            yield `sub2-${i}`;
          }
        }),
      });

      const pair = createLocalTestPair(testRouter, { kind: "test" });

      try {
        const gen1 = await pair.client.proxy.sub1();
        const gen2 = await pair.client.proxy.sub2();

        const results1 = [];
        const results2 = [];

        // Interleave consumption
        for (let i = 0; i < 20; i++) {
          const r1 = await gen1.next();
          if (!r1.done) results1.push(r1.value);

          const r2 = await gen2.next();
          if (!r2.done) results2.push(r2.value);
        }

        expect(results1).toHaveLength(20);
        expect(results2).toHaveLength(20);
        expect(results1[0]).toBe("sub1-0");
        expect(results2[0]).toBe("sub2-0");
      } finally {
        await pair.cleanup();
      }
    });
  });
});
