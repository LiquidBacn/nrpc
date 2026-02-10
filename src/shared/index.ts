export { query, router, subscription } from "./builders.ts";
export type { NRPCRequest, NRPCResponse } from "./types.ts";

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
  #cancel: () => void;
  #reject: (msg?: string) => void;
  #canceled = false;

  constructor(
    execute: (
      resolve: (value: T | Promise<T>) => void,
      reject: (reason: any) => void,
    ) => void,
    cancel: () => void,
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

  cancel(message?: string) {
    if (this.#canceled) return;
    this.#canceled = true;
    this.#reject(message);
    this.#cancel();
  }
}
