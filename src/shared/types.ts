import type { NRPCPromise } from "./index.ts";

export type EventProp<O> = {
  on: (cb: (value: O) => void) => void;
  close: () => void;
};

export type EventToProp<T extends Event> =
  T extends Event<infer O> ? () => Promise<EventProp<O>> : never;

export type SubToProp<T extends Subscription> =
  T extends Subscription<any, infer V, infer O> ?
    /**
     * @param inp Input data for the subscription
     * @param backPressure Has a default of 10
     */
    (inp: V, backPressure?: number) => Promise<AsyncGenerator<O>>
  : never;

export type QueryToProp<T extends Query> =
  T extends Query<any, infer V, infer O> ? (inp: V) => NRPCPromise<O> : never;

export type RouterToProp<T extends Router> =
  T extends Router ? RoutesToProxy<T["routes"]> : never;

export type RouteToProp<T extends Route> =
  T extends Query ? QueryToProp<T>
  : T extends Subscription ? SubToProp<T>
  : T extends Event ? EventToProp<T>
  : T extends Router ? RouterToProp<T>
  : never;

export type RouterToProxy<R extends Router> =
  R extends Router ? RoutesToProxy<R["routes"]> : never;

export type EventsToProxy<R extends Router> =
  R extends Router ? RoutesToEmitter<R["routes"]> : never;

export type RoutesToEmitter<T extends Routes> = {
  [K in keyof T]: RouteToEmitter<T[K]>;
};

export type RouteToEmitter<T extends Route> =
  T extends Event<infer O> ? (payload: O) => void
  : T extends Router<any, any, infer Rt> ? RoutesToEmitter<Rt>
  : never;

export type Routes<C = any> = Record<string, Route<C>>;

export type RoutesToProxy<T extends Routes> = {
  [K in keyof T]: RouteToProp<T[K]>;
};

export type Validator<T = any> = CustomValidator<T> | ZodValidator<T>;
export type CustomValidator<T = any> = (inp: any) => T | Promise<T>;
export type ZodValidator<T = any> = { parse: (val: any) => T };

export type Route<C = any> = Query<C> | Subscription<C> | Event | Router<C>;

export interface Query<C = any, V = any, O = any> {
  _tag: "q";
  validator: Validator<V>;
  method: (ctx: C, inp: V, cancel: AbortSignal) => O | Promise<O>;
}

export interface Subscription<C = any, V = any, O = any> {
  _tag: "s";
  validator: Validator<V>;
  method: (ctx: C, inp: V) => AsyncGenerator<O> | Promise<AsyncGenerator<O>>;
}

export interface Event<O = any> {
  _tag: "e";
}

export interface Router<CIn = any, COut = any, R extends Routes<COut> = any> {
  _tag: "r";
  middle: (ctx: CIn) => COut | Promise<COut>;
  routes: R;
}

export type RouterToCIn<R extends Router> =
  R extends Router<infer CIn> ? CIn : never;

export type EventSub = {
  callbacks: Set<(value: any) => void>;
};

// Client -> Server
export type NRPCRequest =
  | { id: string; type: "request"; path: string[]; input: unknown }
  | { id: string; type: "request.cancel"; message?: string }
  | { id: string; type: "subscription.end" }
  | { id: string; type: "subscription.error"; error: any }
  | { id: string; type: "subscription.pause" }
  | { id: string; type: "subscription.resume" }
  | { id: string; type: "event.end" };

// Server -> Client
export type NRPCResponse =
  | { id: string; type: "result"; payload: unknown } // Query success
  | { id: string; type: "subscription.start" } // Subscription initiated
  | { id: string; type: "subscription.data"; payload: unknown } // Subscription payload
  | { id: string; type: "subscription.error"; error: any } // Subscription complete
  | { id: string; type: "subscription.end" } // Subscription complete
  | { id: string; type: "error"; error: any }
  | { id: string; type: "event.start" }
  | { id: string; type: "event.data"; payload: unknown };
