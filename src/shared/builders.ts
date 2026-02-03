import type {
  Query,
  Routes,
  Router,
  Subscription,
  RouterToProxy,
  Validator,
} from "./types.ts";

export function router<CIn, COut, R extends Routes<COut>>(
  middle: (ctx: CIn) => COut | Promise<COut>,
  routes: R,
): Router<CIn, COut, R> {
  return {
    _tag: "r",
    middle,
    routes,
  };
}

export function query<C, O>(
  method: (ctx: C) => O | Promise<O>,
): Query<C, void, O>;
export function query<C, V, O>(
  validator: Validator<V>,
  method: (ctx: C, inp: V) => O | Promise<O>,
): Query<C, V, O>;
export function query<C, V, O>(validator: any, method?: any): Query<C, any, O> {
  if (method == undefined) {
    return {
      _tag: "q",
      validator: () => {},
      method: validator,
    };
  }
  return {
    _tag: "q",
    validator,
    method,
  };
}

export function subscription<C, O>(
  method: (ctx: C) => AsyncIterator<O> | Promise<AsyncIterator<O>>,
): Subscription<C, void, O>;
export function subscription<C, V, O>(
  validator: Validator<V>,
  method: (ctx: C, inp: V) => AsyncIterator<O> | Promise<AsyncIterator<O>>,
): Subscription<C, V, O>;
export function subscription<C, V, O>(
  validator: any,
  method?: any,
): Subscription<C, any, O> {
  if (method === undefined) {
    return {
      _tag: "s",
      validator: () => {},
      method: validator,
    };
  }
  return {
    _tag: "s",
    validator,
    method,
  };
}
