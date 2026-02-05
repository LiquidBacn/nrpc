export { query, router, subscription } from "./builders.ts";
export class NRPCConnClosed extends Error {
  constructor() {
    super("nRPC Connection Closed.");
  }
}

export class NRPCSubEnded extends Error {}

export type { NRPCRequest, NRPCResponse } from "./types.ts";
