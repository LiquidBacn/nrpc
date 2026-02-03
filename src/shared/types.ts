export type RouteToProp<T extends Route<C>, C = any> =
  T extends Query<C, infer V, infer O> ? (inp: V) => Promise<O>
  : T extends Subscription<C, infer V, infer O> ?
    (inp: V) => Promise<AsyncIterable<O>>
  : T extends Router<infer CIn, infer COut> ? RoutesToProxy<T["routes"], COut>
  : never;

export type RouterToProxy<R extends Router> =
  R extends Router<any> ? RoutesToProxy<R["routes"]> : never;

export type Routes<C = any> = Record<string, Route<C>>;

export type RoutesToProxy<T extends Routes<C>, C = any> = {
  [K in keyof T]: RouteToProp<T[K], C>;
};

export type Validator<T = any> = CustomValidator<T> | ZodValidator<T>;
type CustomValidator<T = any> = (inp: any) => T | Promise<T>;
type ZodValidator<T = any> = { parse: (val: any) => T };

export type Route<C = any> = Query<C> | Subscription<C> | Router<C>;

export interface Query<C = any, V = any, O = any> {
  _tag: "q";
  validator: Validator<V>;
  method: (ctx: C, inp: V) => O | Promise<O>;
}

export interface Subscription<C = any, V = any, O = any> {
  _tag: "s";
  validator: Validator<V>;
  method: (ctx: C, inp: V) => AsyncGenerator<O> | Promise<AsyncGenerator<O>>;
}

export interface Router<CIn = any, COut = any, R extends Routes<COut> = any> {
  _tag: "r";
  middle: (ctx: CIn) => COut | Promise<COut>;
  routes: R;
}

export type NRPCRequest =
  | { id: string; type: "request"; path: string[]; input: unknown }
  | { id: string; type: "subscription.end" }
  | { id: string; type: "subscription.error"; error: any };

// Server -> Client
export type NRPCResponse =
  | { id: string; type: "result"; payload: unknown } // Query success
  | { id: string; type: "subscription.start" } // Subscription initiated
  | { id: string; type: "subscription.data"; payload: unknown } // Subscription payload
  | { id: string; type: "subscription.error"; error: any } // Subscription complete
  | { id: string; type: "subscription.end" } // Subscription complete
  | { id: string; type: "error"; error: any };
