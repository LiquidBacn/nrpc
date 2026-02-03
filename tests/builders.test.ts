import { describe, it, expect } from "vitest";
import { router, query, subscription } from "../src/shared/index.ts";
import { z } from "zod";

describe("Builders", () => {
  describe("router()", () => {
    it("creates a router with correct tag", () => {
      const testRouter = router((ctx: any) => ctx, {});
      expect(testRouter._tag).toBe("r");
    });

    it("stores middleware function", () => {
      const middleware = (ctx: { value: string }) => ({
        ...ctx,
        transformed: true,
      });
      const testRouter = router(middleware, {});
      expect(testRouter.middle).toBe(middleware);
    });

    it("stores routes", () => {
      const routes = { testRoute: query(() => "test") };
      const testRouter = router((ctx: any) => ctx, routes);
      expect(testRouter.routes).toBe(routes);
    });

    it("supports async middleware", () => {
      const asyncMiddleware = async (ctx: any) => ({
        ...ctx,
        async: true,
      });
      const testRouter = router(asyncMiddleware, {});
      expect(testRouter.middle).toBe(asyncMiddleware);
    });
  });

  describe("query()", () => {
    it("creates a query with correct tag", () => {
      const testQuery = query(() => "result");
      expect(testQuery._tag).toBe("q");
    });

    it("stores method without validator", () => {
      const method = () => "result";
      const testQuery = query(method);
      expect(testQuery.method).toBe(method);
      expect(testQuery.validator).toBeDefined();
    });

    it("creates default validator when none provided", () => {
      const testQuery = query(() => "result");
      const validated = (testQuery.validator as any)(undefined);
      expect(validated).toBeUndefined();
    });

    it("stores validator and method when provided", () => {
      const validator = z.number();
      const method = (ctx: any, inp: number) => inp + 1;
      const testQuery = query(validator, method);
      expect(testQuery.validator).toBe(validator);
      expect(testQuery.method).toBe(method);
    });

    it("supports async methods", () => {
      const asyncMethod = async () => "result";
      const testQuery = query(asyncMethod);
      expect(testQuery.method).toBe(asyncMethod);
    });

    it("works with custom validator functions", () => {
      const customValidator = (inp: any) => String(inp);
      const testQuery = query(customValidator, (ctx: any, inp: string) => inp);
      expect(testQuery.validator).toBe(customValidator);
    });
  });

  describe("subscription()", () => {
    it("creates a subscription with correct tag", () => {
      const testSub = subscription(async function* () {
        yield "value";
      });
      expect(testSub._tag).toBe("s");
    });

    it("stores method without validator", () => {
      const method = async function* () {
        yield "result";
      };
      const testSub = subscription(method);
      expect(testSub.method).toBe(method);
      expect(testSub.validator).toBeDefined();
    });

    it("creates default validator when none provided", () => {
      const testSub = subscription(async function* () {
        yield "result";
      });
      const validated = (testSub.validator as any)(undefined);
      expect(validated).toBeUndefined();
    });

    it("stores validator and method when provided", () => {
      const validator = z.number();
      const method = async function* (ctx: any, inp: number) {
        for (let i = 0; i < inp; i++) {
          yield i;
        }
      };
      const testSub = subscription(validator, method);
      expect(testSub.validator).toBe(validator);
      expect(testSub.method).toBe(method);
    });

    it("supports async generator methods", async () => {
      const method = async function* () {
        yield 1;
        yield 2;
      };
      const testSub = subscription(method);
      const gen = await testSub.method({});
      const values: any[] = [];
      for await (const val of gen) {
        values.push(val);
      }
      expect(values).toEqual([1, 2]);
    });

    it("works with custom validator functions", () => {
      const customValidator = (inp: any) => Number(inp);
      const testSub = subscription(
        customValidator,
        async function* (ctx: any, inp: number) {
          for (let i = 0; i < inp; i++) {
            yield i;
          }
        }
      );
      expect(testSub.validator).toBe(customValidator);
    });
  });

  describe("Type combinations", () => {
    it("supports mixed routes with queries and subscriptions", () => {
      const mixedRouter = router((ctx: any) => ctx, {
        myQuery: query(() => "query result"),
        mySub: subscription(async function* () {
          yield "sub result";
        }),
      });

      expect(mixedRouter.routes.myQuery._tag).toBe("q");
      expect(mixedRouter.routes.mySub._tag).toBe("s");
    });

    it("supports nested routers with mixed routes", () => {
      const innerRouter = router((ctx: any) => ctx, {
        innerQuery: query(() => "inner"),
      });

      const outerRouter = router((ctx: any) => ctx, {
        outer: query(() => "outer"),
        nested: innerRouter,
      });

      expect(outerRouter.routes.nested._tag).toBe("r");
      expect(outerRouter.routes.outer._tag).toBe("q");
    });
  });
});
