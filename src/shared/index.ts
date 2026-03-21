export { event, query, router, subscription } from "./builders.ts";
export type {
  BroadcastResult,
  BroadcastRouterToProxy,
  EventsToProxy,
  NRPCRequest,
  NRPCResponse,
} from "./types.ts";

export class NRPCConnClosed extends Error {
  name = "NRPCConnClosed";
  constructor() {
    super("nRPC Connection Closed.");
  }
}

export class NRPCSubEnded extends Error {
  name = "NRPCSubEnded";
}
export class NRPCReqCanceled extends Error {
  name = "NRPCReqCanceled";
}

export class NRPCPromise<T, I = T> extends Promise<T> {
  #cancel: (msg?: string) => void;
  #reject: (msg?: string) => void;
  #canceled = false;
  #onCb: (cb: (value: I) => void | PromiseLike<void>) => void;

  constructor(
    execute: (
      resolve: (value: T | Promise<T>) => void,
      reject: (reason: any) => void,
    ) => void,
    cancel: (message?: string) => void,
    onCb: (cb: (value: I) => void | PromiseLike<void>) => void,
  ) {
    let reject: (reason: any) => void;
    super((res, rej) => {
      reject = rej;
      execute(res, rej);
    });

    this.#cancel = cancel;
    this.#reject = (msg) => {
      reject(new NRPCReqCanceled(msg));
    };
    this.#onCb = onCb;
  }

  /**
   * Unlike `.then`, does not return a new Promise, but rather `this`.
   * @param message
   */
  cancel(message?: string) {
    if (!this.#canceled) {
      this.#canceled = true;
      this.#reject(message);
      this.#cancel(message);
    }
    return this;
  }

  /**
   * This unusual Promise method uses the callback provided in the following ways:
   * 1. If the request is to a `query`, the callback will be called with the resolved value.
   * 2. If the request is to a `subscription`, the callback will be called for each item in the subscription.
   * 3. If the request is to a `event`, the callback will be called for every event.
   */
  on(cb: (value: I) => void | PromiseLike<void>) {
    this.#onCb(cb);
    return this;
  }
}
