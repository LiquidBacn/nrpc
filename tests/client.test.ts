import { describe, it, expect, expectTypeOf } from "vitest";
import { getClient } from "../src/client/index.ts";
import {
  event,
  query,
  router,
  subscription,
  type BroadcastResult,
  type NRPCPromise,
} from "../src/shared/index.ts";

const typedRouter = router(() => ({}), {
  admin: router(() => ({}), {
    users: router(() => ({}), {
      getAll: query((_ctx: {}, _signal: AbortSignal) => ["user"]),
      stream: subscription(async function* () {
        yield "user";
      }),
      changed: event<string>(),
    }),
  }),
});

describe("getClient()", () => {
  describe("message handling", () => {
    it("returns client with onMsg, onClose, and proxy", () => {
      const client = getClient(
        () => {},
        () => {},
      );
      expect(client).toHaveProperty("onMsg");
      expect(client).toHaveProperty("onClose");
      expect(client).toHaveProperty("proxy");
      expect(client).toHaveProperty("broadcast");
      expect(typeof client.onMsg).toBe("function");
      expect(typeof client.onClose).toBe("function");
    });

    it("handles query result messages", () => {
      return new Promise<void>((done) => {
        let capturedMsg: any;
        const client = getClient(
          (msg) => {
            capturedMsg = msg;
          },
          () => {},
        );

        // Simulate sending a request
        const result = (client.proxy as any).testQuery();

        result.then((val: any) => {
          expect(val).toBe("test-result");
          done();
        });

        // Simulate server response
        client.onMsg({
          id: capturedMsg.id,
          type: "result",
          payload: "test-result",
        });
      });
    });

    it("handles query error messages", () => {
      return new Promise<void>((done) => {
        let capturedMsg: any;
        const client = getClient(
          (msg) => {
            capturedMsg = msg;
          },
          () => {},
        );

        const result = (client.proxy as any).testQuery();

        result.catch((err: any) => {
          expect(err).toEqual({ message: "Test error" });
          done();
        });

        client.onMsg({
          id: capturedMsg.id,
          type: "error",
          error: { message: "Test error" },
        });
      });
    });

    it("handles subscription start messages", () => {
      return new Promise<void>((done) => {
        let capturedMsg: any;
        const client = getClient(
          (msg) => {
            capturedMsg = msg;
          },
          () => {},
        );

        const result = (client.proxy as any).testSub();

        result.then((gen: any) => {
          expect(gen[Symbol.asyncIterator]).toBeDefined();
          done();
        });

        client.onMsg({
          id: capturedMsg.id,
          type: "subscription.start",
        });
      });
    });

    it("handles subscription data messages", async () => {
      let capturedMsg: any;
      const client = getClient(
        (msg) => {
          capturedMsg = msg;
        },
        () => {},
      );

      const genPromise = (client.proxy as any).testSub();
      const sub1Id = capturedMsg.id;

      client.onMsg({
        id: sub1Id,
        type: "subscription.start",
      });

      const gen = await genPromise;

      // Send data
      client.onMsg({
        id: sub1Id,
        type: "subscription.data",
        payload: "data-1",
      });

      const result1 = await gen.next();
      expect(result1.value).toBe("data-1");
      expect(result1.done).toBe(false);
    });

    it("handles subscription end messages", async () => {
      let capturedMsg: any;
      const client = getClient(
        (msg) => {
          capturedMsg = msg;
        },
        () => {},
      );

      const genPromise = (client.proxy as any).testSub();
      const subId = capturedMsg.id;

      client.onMsg({
        id: subId,
        type: "subscription.start",
      });

      const gen = await genPromise;

      // Send data then end
      client.onMsg({
        id: subId,
        type: "subscription.data",
        payload: "data-1",
      });

      client.onMsg({
        id: subId,
        type: "subscription.end",
      });

      const result1 = await gen.next();
      expect(result1.value).toBe("data-1");

      const result2 = await gen.next();
      expect(result2.done).toBe(true);
    });

    it("handles subscription error messages", async () => {
      let capturedMsg: any;
      const client = getClient(
        (msg) => {
          capturedMsg = msg;
        },
        () => {},
      );

      const genPromise = (client.proxy as any).testSub();
      const subId = capturedMsg.id;

      client.onMsg({
        id: subId,
        type: "subscription.start",
      });

      const gen = await genPromise;

      client.onMsg({
        id: subId,
        type: "subscription.error",
        error: { message: "Sub error" },
      });

      try {
        await gen.next();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toBe("Sub error");
      }
    });

    it("handles multiple concurrent requests", async () => {
      const results: any[] = [];
      let msgCount = 0;

      const client = getClient(
        (msg) => {
          msgCount++;
          if (msgCount === 1) {
            setTimeout(() => {
              client.onMsg({
                id: msg.id,
                type: "result",
                payload: "result-1",
              });
            }, 10);
          } else if (msgCount === 2) {
            setTimeout(() => {
              client.onMsg({
                id: msg.id,
                type: "result",
                payload: "result-2",
              });
            }, 10);
          }
        },
        () => {},
      );

      const promise1 = (client.proxy as any).query1();
      const promise2 = (client.proxy as any).query2();

      await new Promise<void>((done) => {
        Promise.all([promise1, promise2]).then(([r1, r2]) => {
          expect(r1).toBe("result-1");
          expect(r2).toBe("result-2");
          done();
        });
      });
    });

    it("handles multiple concurrent subscriptions", async () => {
      const client = getClient(
        (msg) => {
          if (msg.type === "request") {
            ids.push(msg.id);
            if (messageCount === 0) {
              client.onMsg({
                id: msg.id,
                type: "subscription.start",
              });
            } else if (messageCount === 1) {
              client.onMsg({
                id: msg.id,
                type: "subscription.start",
              });
            }
            messageCount++;
          }
        },
        () => {},
      );
      const ids: string[] = [];
      let messageCount = 0;

      const sub1 = (client.proxy as any).sub1();
      const sub2 = (client.proxy as any).sub2();

      const gen1 = await sub1;
      const gen2 = await sub2;

      // Send data to first subscription
      client.onMsg({
        id: ids[0],
        type: "subscription.data",
        payload: "sub1-data",
      });

      // Send data to second subscription
      client.onMsg({
        id: ids[1],
        type: "subscription.data",
        payload: "sub2-data",
      });

      const res1 = await gen1.next();
      const res2 = await gen2.next();

      expect(res1.value).toBe("sub1-data");
      expect(res2.value).toBe("sub2-data");
    });
  });

  describe("request generation", () => {
    it("generates request messages with correct structure", async () => {
      let capturedMsg: any;
      const client = getClient(
        (msg) => {
          capturedMsg = msg;
        },
        () => {},
      );

      (client.proxy as any).myMethod("arg");

      expect(capturedMsg).toBeDefined();
      expect(capturedMsg.type).toBe("request");
      expect(capturedMsg.id).toBeDefined();
      expect(capturedMsg.path).toEqual(["myMethod"]);
      expect(capturedMsg.input).toBe("arg");
    });

    it("generates unique IDs for sequential requests", () => {
      const ids = new Set();
      const client = getClient(
        (msg) => {
          ids.add(msg.id);
        },
        () => {},
      );

      (client.proxy as any).method1();
      (client.proxy as any).method2();
      (client.proxy as any).method3();

      expect(ids.size).toBe(3);
    });

    it("builds nested paths for nested routes", () => {
      let capturedMsg: any;
      const client = getClient(
        (msg) => {
          capturedMsg = msg;
        },
        () => {},
      );

      (client.proxy as any).admin.users.getAll();

      expect(capturedMsg.path).toEqual(["admin", "users", "getAll"]);
    });

    it("builds nested broadcast paths for nested routes", () => {
      let capturedMsg: any;
      const client = getClient(
        (msg) => {
          capturedMsg = msg;
        },
        () => {},
      );

      (client.broadcast as any).admin.users.getAll();

      expect(capturedMsg.type).toBe("request.broadcast");
      expect(capturedMsg.path).toEqual(["admin", "users", "getAll"]);
    });

    it("sends request.broadcast for broadcast calls", () => {
      let capturedMsg: any;
      const client = getClient(
        (msg) => {
          capturedMsg = msg;
        },
        () => {},
      );

      (client.broadcast as any).myMethod("arg");

      expect(capturedMsg).toMatchObject({
        type: "request.broadcast",
        path: ["myMethod"],
        input: "arg",
      });
    });

    it("includes undefined for requests without input", () => {
      let capturedMsg: any;
      const client = getClient(
        (msg) => {
          capturedMsg = msg;
        },
        () => {},
      );

      (client.proxy as any).method();

      expect(capturedMsg.input).toBeUndefined();
    });
  });

  describe("proxy interface", () => {
    it("proxy returns thenable for async/await compatibility", () => {
      return new Promise<void>((done) => {
        let capturedMsg: any;
        const client = getClient(
          (msg) => {
            capturedMsg = msg;
          },
          () => {},
        );

        const result = (client.proxy as any).method();
        expect(result).toHaveProperty("then");

        result.then(() => {
          done();
        });

        client.onMsg({
          id: capturedMsg.id,
          type: "result",
          payload: null,
        });
      });
    });

    it("proxy does not return promise for .then access", () => {
      const client = getClient(
        () => {},
        () => {},
      );
      const proxy = (client.proxy as any).method;
      expect(proxy.then).toBeUndefined();
    });

    it("broadcast proxy does not return promise for .then access", () => {
      const client = getClient(
        () => {},
        () => {},
      );
      const proxy = (client.broadcast as any).method;
      expect(proxy.then).toBeUndefined();
    });

    it("allows deep nesting of proxy access", () => {
      const client = getClient(
        () => {},
        () => {},
      );
      const nested = (client.proxy as any).level1.level2.level3.level4;
      expect(typeof nested).toBe("function");
    });

    it("proxy call handler receives correct arguments", () => {
      let capturedMsg: any;
      const client = getClient(
        (msg) => {
          capturedMsg = msg;
        },
        () => {},
      );

      const testData = { key: "value", nested: { data: 123 } };
      (client.proxy as any).method(testData);

      expect(capturedMsg.input).toEqual(testData);
    });
  });

  describe("subscription cancellation", () => {
    it("sends subscription.end when generator.return() is called", async () => {
      const messages: any[] = [];
      const client = getClient(
        (msg) => {
          messages.push(msg);
        },
        () => {},
      );

      const genPromise = (client.proxy as any).testSub();
      const subId = messages[0].id;

      client.onMsg({
        id: subId,
        type: "subscription.start",
      });

      const gen = await genPromise;

      // Add data
      client.onMsg({
        id: subId,
        type: "subscription.data",
        payload: "data",
      });

      // Cancel subscription
      await gen.return();

      // Check that subscription.end was sent
      const endMsg = messages.find((m) => m.type === "subscription.end");
      expect(endMsg).toBeDefined();
    });

    it("sends subscription.error when generator.throw() is called", async () => {
      const messages: any[] = [];
      const client = getClient(
        (msg) => {
          messages.push(msg);
        },
        () => {},
      );

      const genPromise = (client.proxy as any).testSub();
      const subId = messages[0].id;

      client.onMsg({
        id: subId,
        type: "subscription.start",
      });

      const gen = await genPromise;

      await gen.throw(new Error("Thrown error"));

      const errorMsg = messages.find((m) => m.type === "subscription.error");
      expect(errorMsg).toBeDefined();
    });

    it("sends request.cancel when a broadcast promise is canceled", async () => {
      const messages: any[] = [];
      const client = getClient(
        (msg) => {
          messages.push(msg);
        },
        () => {},
      );

      const promise = (client.broadcast as any).testQuery();
      promise.cancel("stop");

      await expect(promise).rejects.toBeDefined();
      expect(messages[0].type).toBe("request.broadcast");
      expect(messages[1]).toMatchObject({
        id: messages[0].id,
        type: "request.cancel",
        message: "stop",
      });
    });
  });

  describe("broadcast typing", () => {
    it("exposes query leaves and rejects subscription or event leaves", () => {
      const client = getClient<typeof typedRouter>(
        () => {},
        () => {},
      );

      expectTypeOf(client.broadcast.admin.users.getAll).toEqualTypeOf<
        (inp: void) => NRPCPromise<BroadcastResult<string[]>[]>
      >();

      // @ts-expect-error broadcast excludes subscriptions
      client.broadcast.admin.users.stream();
      // @ts-expect-error broadcast excludes events
      client.broadcast.admin.users.changed();
    });
  });

  describe("message guard clause", () => {
    it("ignores null messages", () => {
      return new Promise<void>((done) => {
        let callCount = 0;
        const client = getClient(
          () => {
            callCount++;
          },
          () => {}
        );

        (client.proxy as any).testQuery();

        // Send null message - should be ignored by guard
        client.onMsg(null);

        setTimeout(() => {
          // No response should be processed since we sent null
          expect(callCount).toBe(1); // Only the initial request
          done();
        }, 50);
      });
    });

    it("ignores non-object messages", () => {
      return new Promise<void>((done) => {
        let callCount = 0;
        const client = getClient(
          () => {
            callCount++;
          },
          () => {}
        );

        (client.proxy as any).testQuery();

        // Send various non-object messages - should be ignored by guard
        client.onMsg("string" as any);
        client.onMsg(123 as any);
        client.onMsg(true as any);
        client.onMsg(undefined as any);

        setTimeout(() => {
          // No responses should be processed
          expect(callCount).toBe(1); // Only the initial request
          done();
        }, 50);
      });
    });

    it("processes valid object messages normally", () => {
      return new Promise<void>((done) => {
        let capturedMsg: any;
        const client = getClient(
          (msg) => {
            capturedMsg = msg;
          },
          () => {}
        );

        const result = (client.proxy as any).testQuery();

        result.then((val: any) => {
          expect(val).toBe("valid-result");
          done();
        });

        // Send valid message
        client.onMsg({
          id: capturedMsg.id,
          type: "result",
          payload: "valid-result",
        });
      });
    });
  });
});
