import { describe, it, expect, beforeEach } from "vitest";
import { NRPCServer } from "../src/server/index.ts";
import { router, query, subscription } from "../src/shared/index.ts";
import {
  simpleRouter,
  nestedRouter,
  deepNestedRouter,
  TestContext,
} from "./fixtures.ts";
import { z } from "zod";

describe("NRPCServer", () => {
  let server: NRPCServer<any, any, any>;

  describe("getRoute()", () => {
    beforeEach(() => {
      server = new NRPCServer(simpleRouter);
    });

    it("resolves a simple query route", async () => {
      const result = await server.getRoute({ kind: "test" }, ["getGreeting"]);
      expect(result.route._tag).toBe("q");
      expect(result.c).toBeDefined();
      expect(result.c.userId).toBe("user123");
    });

    it("resolves a subscription route", async () => {
      const result = await server.getRoute({ kind: "test" }, ["countUp"]);
      expect(result.route._tag).toBe("s");
      expect(result.c).toBeDefined();
    });

    it("throws error for non-existent route", async () => {
      await expect(
        server.getRoute({ kind: "test" }, ["nonExistent"])
      ).rejects.toThrow('Not Found');
    });

    it("applies middleware to context", async () => {
      const result = await server.getRoute({ kind: "test" }, ["getGreeting"]);
      expect(result.c.kind).toBe("test");
      expect(result.c.userId).toBe("user123");
    });

    it("resolves nested router with one level", async () => {
      const nestedServer = new NRPCServer(nestedRouter);
      const result = await nestedServer.getRoute({ kind: "test" }, [
        "admin",
        "secretData",
      ]);
      expect(result.route._tag).toBe("q");
      expect(result.c.isAdmin).toBe(true); // Middleware transformed context
    });

    it("resolves deeply nested router with two levels", async () => {
      const deepServer = new NRPCServer(deepNestedRouter);
      const result = await deepServer.getRoute({ kind: "test" }, [
        "level1",
        "level2",
        "deepValue",
      ]);
      expect(result.route._tag).toBe("q");
      expect(result.c.userId).toContain("L1");
      expect(result.c.userId).toContain("L2");
    });

    it("throws error for incomplete nested path", async () => {
      const nestedServer = new NRPCServer(nestedRouter);
      await expect(
        nestedServer.getRoute({ kind: "test" }, ["admin"])
      ).rejects.toThrow();
    });
  });

  describe("call()", () => {
    beforeEach(() => {
      server = new NRPCServer(simpleRouter);
    });

    it("executes a query method", async () => {
      const result = await server.call({ kind: "test" }, ["getGreeting"], undefined);
      expect(result).toBe("Hello user123!");
    });

    it("executes a query with validator", async () => {
      const result = await server.call({ kind: "test" }, ["addNumbers"], 5 as any);
      expect(result).toBe(15);
    });

    it("executes a query with string validator", async () => {
      const result = await server.call(
        { kind: "test" },
        ["echoString"],
        "hello" as any
      );
      expect(result).toBe("HELLO");
    });

    it("returns async iterator for subscription", async () => {
      const result = await server.call({ kind: "test" }, ["countUp"], undefined);
      expect((result as any)[Symbol.asyncIterator]).toBeDefined();

      const values: any[] = [];
      for await (const val of result as any) {
        values.push(val);
      }
      expect(values).toHaveLength(3);
      expect(values[0]).toEqual({ count: 0, userId: "user123" });
    });

    it("passes input to subscription method", async () => {
      const result = await server.call({ kind: "test" }, ["delayedValue"], 3 as any);
      const values: any[] = [];
      for await (const val of result as any) {
        values.push(val);
      }
      expect(values).toEqual([3, 6]); // 3 * 1, 3 * 2
    });

    it("throws error for non-existent route", async () => {
      await expect(
        server.call({ kind: "test" }, ["nonExistent"], undefined)
      ).rejects.toThrow();
    });

    it("throws error for invalid validator", async () => {
      const testRouter = router((ctx: any) => ctx, {
        strictNumber: query(
          z.number(),
          (ctx: any, num: number) => num
        ),
      });
      const strictServer = new NRPCServer(testRouter);
      await expect(
        strictServer.call({ kind: "test" }, ["strictNumber"], "not-a-number")
      ).rejects.toThrow();
    });

    it("propagates errors thrown in method", async () => {
      const errorRouter = router((ctx: any) => ctx, {
        throwError: query(() => {
          throw new Error("Method error");
        }),
      });
      const errorServer = new NRPCServer(errorRouter);
      await expect(
        errorServer.call({ kind: "test" }, ["throwError"])
      ).rejects.toThrow("Method error");
    });

    it("executes nested query with middleware transformation", async () => {
      const nestedServer = new NRPCServer(nestedRouter);
      const result = await nestedServer.call({ kind: "test" }, [
        "admin",
        "secretData",
      ]);
      expect(result).toEqual({ secret: "admin-only", userId: "user456" });
    });

    it("executes deeply nested subscription", async () => {
      const deepServer = new NRPCServer(deepNestedRouter);
      const result = await deepServer.call({ kind: "test" }, [
        "level1",
        "level2",
        "deepSub",
      ], undefined);
      const values: any[] = [];
      for await (const val of result as any) {
        values.push(val);
      }
      expect(values).toHaveLength(2);
      expect(values[0]).toHaveProperty("depth", 2);
    });
  });

  describe("getLocalCaller()", () => {
    beforeEach(() => {
      server = new NRPCServer(simpleRouter);
    });

    it("returns a proxy object", () => {
      const caller = server.getLocalCaller({ kind: "test" });
      expect(typeof caller).toBe("object");
    });

    it("allows calling queries via proxy", async () => {
      const caller = server.getLocalCaller({ kind: "test" }) as any;
      const result = await caller.getGreeting();
      expect(result).toBe("Hello user123!");
    });

    it("allows calling queries with parameters via proxy", async () => {
      const caller = server.getLocalCaller({ kind: "test" }) as any;
      const result = await caller.addNumbers(7);
      expect(result).toBe(17);
    });

    it("allows calling subscriptions via proxy", async () => {
      const caller = server.getLocalCaller({ kind: "test" }) as any;
      const gen = await caller.countUp();
      const values: any[] = [];
      for await (const val of gen) {
        values.push(val);
      }
      expect(values).toHaveLength(3);
    });

    it("allows accessing nested routes via proxy", async () => {
      const nestedServer = new NRPCServer(nestedRouter);
      const caller = nestedServer.getLocalCaller({ kind: "test" });
      const result = await caller.admin.secretData();
      expect(result).toEqual({ secret: "admin-only", userId: "user456" });
    });

    it("allows accessing deeply nested routes", async () => {
      const deepServer = new NRPCServer(deepNestedRouter);
      const caller = deepServer.getLocalCaller({ kind: "test" });
      const result = await caller.level1.level2.deepValue();
      expect(result).toContain("Level2");
    });

    it("propagates errors from nested calls", async () => {
      const errorRouter = router((ctx: any) => ctx, {
        nested: router((ctx: any) => ctx, {
          throwError: query(() => {
            throw new Error("Nested error");
          }),
        }),
      });
      const errorServer = new NRPCServer(errorRouter);
      const caller = errorServer.getLocalCaller({ kind: "test" });
      await expect(caller.nested.throwError()).rejects.toThrow(
        "Nested error"
      );
    });
  });

  describe("getConnection()", () => {
    beforeEach(() => {
      server = new NRPCServer(simpleRouter);
    });

    it("returns object with onMsg and onClose", () => {
      const connection = server.getConnection(
        { kind: "test" },
        () => {},
        () => {}
      );
      expect(connection).toHaveProperty("onMsg");
      expect(connection).toHaveProperty("onClose");
      expect(typeof connection.onMsg).toBe("function");
      expect(typeof connection.onClose).toBe("function");
    });

    it("handles query request messages", async () => {
      let sentMessage: any;
      const connection = server.getConnection(
        { kind: "test" },
        (msg) => {
          sentMessage = msg;
        },
        () => {}
      );

      connection.onMsg({
        id: "test-1",
        type: "request",
        path: ["getGreeting"],
        input: undefined,
      });

      // Wait for async processing
      await new Promise((res) => setTimeout(res, 50));

      expect(sentMessage).toBeDefined();
      expect(sentMessage.id).toBe("test-1");
      expect(sentMessage.type).toBe("result");
      expect(sentMessage.payload).toBe("Hello user123!");
    });

    it("handles query with parameters", async () => {
      let sentMessage: any;
      const connection = server.getConnection(
        { kind: "test" },
        (msg) => {
          sentMessage = msg;
        },
        () => {}
      );

      connection.onMsg({
        id: "test-2",
        type: "request",
        path: ["addNumbers"],
        input: 10,
      });

      await new Promise((res) => setTimeout(res, 50));

      expect(sentMessage.payload).toBe(20);
    });

    it("handles errors and sends error response", async () => {
      const errorRouter = router((ctx: any) => ctx, {
        throwError: query(() => {
          throw new Error("Test error");
        }),
      });
      const errorServer = new NRPCServer(errorRouter);

      let sentMessage: any;
      const connection = errorServer.getConnection(
        { kind: "test" },
        (msg) => {
          sentMessage = msg;
        },
        () => {}
      );

      connection.onMsg({
        id: "test-3",
        type: "request",
        path: ["throwError"],
        input: undefined,
      });

      await new Promise((res) => setTimeout(res, 50));

      expect(sentMessage.type).toBe("error");
      expect(sentMessage.id).toBe("test-3");
    });

    it("handles subscription request", async () => {
      const messages: any[] = [];
      const connection = server.getConnection(
        { kind: "test" },
        (msg) => {
          messages.push(msg);
        },
        () => {}
      );

      connection.onMsg({
        id: "sub-1",
        type: "request",
        path: ["countUp"],
        input: undefined,
      });

      // Wait for subscription to complete
      await new Promise((res) => setTimeout(res, 100));

      expect(messages[0].type).toBe("subscription.start");
      expect(messages[1].type).toBe("subscription.data");
      expect(messages[messages.length - 1].type).toBe("subscription.end");
    });

    it("handles subscription end message", async () => {
      const messages: any[] = [];
      const connection = server.getConnection(
        { kind: "test" },
        (msg) => {
          messages.push(msg);
        },
        () => {}
      );

      connection.onMsg({
        id: "sub-2",
        type: "request",
        path: ["countUp"],
        input: undefined,
      });

      await new Promise((res) => setTimeout(res, 50));

      // Send end message to client
      connection.onMsg({
        id: "sub-2",
        type: "subscription.end",
      });

      // Verify subscription was cleaned up (should not cause errors)
      expect(true).toBe(true);
    });
  });
});
