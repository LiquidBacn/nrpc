export { event, query, router, subscription } from "./builders.ts";
export type { EventsToProxy, NRPCRequest, NRPCResponse } from "./types.ts";

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

export class NRPCPromise<T> extends Promise<T> {
  #cancel: (msg?: string) => void;
  #reject: (msg?: string) => void;
  #canceled = false;

  constructor(
    execute: (
      resolve: (value: T | Promise<T>) => void,
      reject: (reason: any) => void,
    ) => void,
    cancel: (message?: string) => void,
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
}
