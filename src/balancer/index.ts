import type { NRPCRequest, NRPCResponse } from "../shared/types.ts";

type ActiveKind = "pending" | "subscription" | "event";

type ActiveRequest = {
  connectionId: string;
  requestId: string;
  kind: ActiveKind;
};

type InFlightRequest = {
  backendId: string;
  kind: ActiveKind;
};

type QueueItem = {
  connectionId: string;
  request: Extract<NRPCRequest, { type: "request" }>;
  targetBackendId?: string;
};

type PendingDrain = {
  res: () => void;
  rej: (error: any) => void;
};

type BackendState = {
  id: string;
  send: (msg: NRPCRequest) => Promise<boolean | void> | boolean | void;
  alive: boolean;
  closed: boolean;
  paused: boolean;
  toDrain: PendingDrain[];
  busy: boolean;
  active?: ActiveRequest;
  leasedConnectionId?: string;
};

type FrontendState = {
  id: string;
  send: (msg: NRPCResponse) => Promise<boolean | void> | boolean | void;
  close: () => void;
  closed: boolean;
  paused: boolean;
  toDrain: PendingDrain[];
  inFlight: Map<string, InFlightRequest>;
  dedicatedBackendId?: string;
  dedicatedInvalidated: boolean;
};

export type NRPCBalancerBackend = {
  id: string;
  onMsg: (msg: any) => Promise<void>;
  onClose: (error?: unknown) => void;
  remove: () => void;
  drain: () => void;
  paused: () => boolean;
};

export type NRPCBalancerConnection = {
  id: string;
  onMsg: (msg: any) => Promise<void>;
  onClose: () => void;
  acquireDedicated: () => string;
  releaseDedicated: () => void;
  dedicatedBackendId: () => string | undefined;
  drain: () => void;
  paused: () => boolean;
};

export class NRPCBalancer {
  #nextBackendId = 0;
  #nextConnectionId = 0;
  #backendOrder: string[] = [];
  #backends = new Map<string, BackendState>();
  #connections = new Map<string, FrontendState>();
  #queue: QueueItem[] = [];

  addBackend(input: {
    id?: string;
    send: (msg: NRPCRequest) => Promise<boolean | void> | boolean | void;
  }): NRPCBalancerBackend {
    const id = input.id ?? `backend_${this.#nextBackendId++}`;
    if (this.#backends.has(id)) {
      throw new Error(`Backend "${id}" already exists.`);
    }

    const backend: BackendState = {
      id,
      send: input.send,
      alive: true,
      closed: false,
      paused: false,
      toDrain: [],
      busy: false,
    };

    this.#backends.set(id, backend);
    this.#backendOrder.push(id);
    this.#drainQueue();

    return {
      id,
      onMsg: async (msg) => {
        await this.#onBackendMessage(backend, msg);
      },
      onClose: (error) => {
        this.#closeBackend(backend, error);
      },
      remove: () => {
        this.#closeBackend(backend, new Error("Backend removed."));
        this.#backends.delete(backend.id);
        this.#backendOrder = this.#backendOrder.filter((v) => v !== backend.id);
      },
      drain: () => {
        this.#drainBackend(backend);
      },
      paused: () => backend.paused,
    };
  }

  getConnection(
    sendMsg: (msg: NRPCResponse) => Promise<boolean | void> | boolean | void,
    close: () => void,
  ): NRPCBalancerConnection {
    const id = `conn_${this.#nextConnectionId++}`;

    const connection: FrontendState = {
      id,
      send: sendMsg,
      close,
      closed: false,
      paused: false,
      toDrain: [],
      inFlight: new Map(),
      dedicatedInvalidated: false,
    };
    this.#connections.set(id, connection);

    return {
      id,
      onMsg: async (msg) => {
        await this.#onFrontendMessage(connection, msg);
      },
      onClose: () => {
        this.#closeConnection(connection);
      },
      acquireDedicated: () => this.acquireDedicated(connection.id),
      releaseDedicated: () => this.releaseDedicated(connection.id),
      dedicatedBackendId: () => connection.dedicatedBackendId,
      drain: () => {
        this.#drainConnection(connection);
      },
      paused: () => connection.paused,
    };
  }

  acquireDedicated(connectionId: string): string {
    const connection = this.#connections.get(connectionId);
    if (!connection || connection.closed) {
      throw new Error(`Connection "${connectionId}" not found.`);
    }

    if (connection.dedicatedBackendId) {
      return connection.dedicatedBackendId;
    }

    const backend = this.#findFirst((candidate) => {
      if (!candidate.alive || candidate.closed || candidate.busy) return false;
      if (candidate.leasedConnectionId) return false;
      return true;
    });

    if (!backend) {
      throw new Error("No backend available for dedicated lease.");
    }

    backend.leasedConnectionId = connection.id;
    connection.dedicatedBackendId = backend.id;
    connection.dedicatedInvalidated = false;
    return backend.id;
  }

  releaseDedicated(connectionId: string) {
    const connection = this.#connections.get(connectionId);
    if (!connection) return;
    this.#releaseDedicatedFor(connection);
    this.#drainQueue();
  }

  async #onFrontendMessage(connection: FrontendState, msg: any) {
    if (connection.closed) return;
    if (msg === null || typeof msg !== "object") return;

    const t = msg as NRPCRequest;

    if (t.type === "request") {
      if (connection.dedicatedInvalidated) {
        connection.dedicatedInvalidated = false;
        await this.#sendToConnection(connection, {
          id: t.id,
          type: "error",
          error: new Error("Dedicated backend unavailable."),
        });
        return;
      }
      await this.#dispatchRequest(connection, t);
      return;
    }

    if (
      t.type !== "request.cancel" &&
      t.type !== "subscription.end" &&
      t.type !== "subscription.error" &&
      t.type !== "subscription.pause" &&
      t.type !== "subscription.resume" &&
      t.type !== "event.end"
    ) {
      return;
    }

    const inFlight = connection.inFlight.get(t.id);
    if (!inFlight) return;

    const backend = this.#backends.get(inFlight.backendId);
    if (backend && backend.alive && !backend.closed) {
      await this.#sendToBackend(backend, t);
    }

    if (
      t.type === "request.cancel" ||
      t.type === "subscription.end" ||
      t.type === "subscription.error" ||
      t.type === "event.end"
    ) {
      this.#completeRequest(connection.id, t.id, inFlight.backendId);
    }
  }

  async #dispatchRequest(
    connection: FrontendState,
    request: Extract<NRPCRequest, { type: "request" }>,
  ) {
    let targetBackendId: string | undefined;
    if (connection.dedicatedBackendId) {
      targetBackendId = connection.dedicatedBackendId;
    }

    const backend = this.#pickBackend(targetBackendId);
    if (!backend) {
      this.#queue.push({
        connectionId: connection.id,
        request,
        targetBackendId,
      });
      return;
    }

    this.#activateRequest(connection, backend, request);
    await this.#sendToBackend(backend, request);
  }

  #activateRequest(
    connection: FrontendState,
    backend: BackendState,
    request: Extract<NRPCRequest, { type: "request" }>,
  ) {
    backend.busy = true;
    backend.active = {
      connectionId: connection.id,
      requestId: request.id,
      kind: "pending",
    };

    connection.inFlight.set(request.id, {
      backendId: backend.id,
      kind: "pending",
    });
  }

  async #onBackendMessage(backend: BackendState, msg: any) {
    if (!backend.alive || backend.closed) return;
    if (msg === null || typeof msg !== "object") return;
    if (!backend.active) return;

    const t = msg as NRPCResponse;
    if (t.id !== backend.active.requestId) {
      return;
    }

    const connection = this.#connections.get(backend.active.connectionId);
    if (!connection || connection.closed) {
      this.#completeRequest(
        backend.active.connectionId,
        backend.active.requestId,
        backend.id,
      );
      return;
    }

    if (t.type === "subscription.start") {
      backend.active.kind = "subscription";
      const inFlight = connection.inFlight.get(t.id);
      if (inFlight) inFlight.kind = "subscription";
      await this.#sendToConnection(connection, t);
      return;
    }

    if (t.type === "event.start") {
      backend.active.kind = "event";
      const inFlight = connection.inFlight.get(t.id);
      if (inFlight) inFlight.kind = "event";
      await this.#sendToConnection(connection, t);
      return;
    }

    await this.#sendToConnection(connection, t);

    if (
      t.type === "result" ||
      t.type === "error" ||
      t.type === "subscription.end" ||
      t.type === "subscription.error"
    ) {
      this.#completeRequest(connection.id, t.id, backend.id);
    }
  }

  async #sendToConnection(connection: FrontendState, msg: NRPCResponse) {
    if (connection.closed) return;
    if (connection.paused) {
      await new Promise<void>((res, rej) => {
        connection.toDrain.push({ res, rej });
      });
    }

    const bp = await connection.send(msg);
    if (bp) {
      connection.paused = true;
    } else if (connection.toDrain.length) {
      const next = connection.toDrain.shift()!;
      next.res();
    }
  }

  async #sendToBackend(backend: BackendState, msg: NRPCRequest) {
    if (!backend.alive || backend.closed) {
      throw new Error(`Backend "${backend.id}" unavailable.`);
    }

    if (backend.paused) {
      await new Promise<void>((res, rej) => {
        backend.toDrain.push({ res, rej });
      });
    }

    try {
      const bp = await backend.send(msg);
      if (bp) {
        backend.paused = true;
      } else if (backend.toDrain.length) {
        const next = backend.toDrain.shift()!;
        next.res();
      }
    } catch (error) {
      this.#closeBackend(backend, error);
    }
  }

  #completeRequest(connectionId: string, requestId: string, backendId: string) {
    const connection = this.#connections.get(connectionId);
    connection?.inFlight.delete(requestId);

    const backend = this.#backends.get(backendId);
    if (
      backend?.active &&
      backend.active.connectionId === connectionId &&
      backend.active.requestId === requestId
    ) {
      backend.active = undefined;
      backend.busy = false;
    }

    this.#drainQueue();
  }

  #pickBackend(targetBackendId?: string) {
    if (targetBackendId) {
      const backend = this.#backends.get(targetBackendId);
      if (!backend || !backend.alive || backend.closed || backend.busy) {
        return undefined;
      }
      return backend;
    }

    return this.#findFirst((backend) => {
      if (!backend.alive || backend.closed || backend.busy) return false;
      if (backend.leasedConnectionId) return false;
      return true;
    });
  }

  #findFirst(predicate: (backend: BackendState) => boolean) {
    for (const id of this.#backendOrder) {
      const backend = this.#backends.get(id);
      if (!backend) continue;
      if (predicate(backend)) return backend;
    }
    return undefined;
  }

  #drainQueue() {
    let progressed = true;
    while (progressed) {
      progressed = false;

      for (let i = 0; i < this.#queue.length; i++) {
        const item = this.#queue[i];
        const connection = this.#connections.get(item.connectionId);
        if (!connection || connection.closed) {
          this.#queue.splice(i, 1);
          progressed = true;
          break;
        }

        if (connection.dedicatedInvalidated && !connection.dedicatedBackendId) {
          connection.dedicatedInvalidated = false;
          this.#queue.splice(i, 1);
          void this.#sendToConnection(connection, {
            id: item.request.id,
            type: "error",
            error: new Error("Dedicated backend unavailable."),
          });
          progressed = true;
          break;
        }

        const backend = this.#pickBackend(item.targetBackendId);
        if (!backend) {
          if (item.targetBackendId) {
            const target = this.#backends.get(item.targetBackendId);
            if (!target || !target.alive || target.closed) {
              this.#queue.splice(i, 1);
              void this.#sendToConnection(connection, {
                id: item.request.id,
                type: "error",
                error: new Error("Dedicated backend unavailable."),
              });
              progressed = true;
              break;
            }
          }
          continue;
        }

        this.#queue.splice(i, 1);
        this.#activateRequest(connection, backend, item.request);
        void this.#sendToBackend(backend, item.request);
        progressed = true;
        break;
      }
    }
  }

  #releaseDedicatedFor(connection: FrontendState) {
    const backendId = connection.dedicatedBackendId;
    connection.dedicatedBackendId = undefined;
    connection.dedicatedInvalidated = false;
    if (!backendId) return;

    const backend = this.#backends.get(backendId);
    if (backend?.leasedConnectionId === connection.id) {
      backend.leasedConnectionId = undefined;
    }
  }

  #closeConnection(connection: FrontendState) {
    if (connection.closed) return;
    const waiters = connection.toDrain;
    connection.toDrain = [];
    waiters.forEach((item) => item.rej(new Error("Connection closed.")));

    connection.closed = true;
    this.#connections.delete(connection.id);

    this.#queue = this.#queue.filter((item) => item.connectionId !== connection.id);

    const active = [...connection.inFlight.entries()];
    connection.inFlight.clear();

    for (const [requestId, info] of active) {
      const backend = this.#backends.get(info.backendId);
      if (backend && backend.alive && !backend.closed) {
        if (info.kind === "subscription") {
          void this.#sendToBackend(backend, { id: requestId, type: "subscription.end" });
        } else if (info.kind === "event") {
          void this.#sendToBackend(backend, { id: requestId, type: "event.end" });
        } else {
          void this.#sendToBackend(backend, { id: requestId, type: "request.cancel" });
        }
      }

      this.#completeRequest(connection.id, requestId, info.backendId);
    }

    this.#releaseDedicatedFor(connection);
    this.#drainQueue();
    connection.close();
  }

  #drainConnection(connection: FrontendState) {
    connection.paused = false;
    if (connection.toDrain.length) {
      const next = connection.toDrain.shift()!;
      next.res();
    }
  }

  #drainBackend(backend: BackendState) {
    backend.paused = false;
    if (backend.toDrain.length) {
      const next = backend.toDrain.shift()!;
      next.res();
    }
  }

  #closeBackend(backend: BackendState, error?: unknown) {
    if (backend.closed) return;
    backend.closed = true;
    backend.alive = false;

    const inflight = backend.active;
    if (inflight) {
      const connection = this.#connections.get(inflight.connectionId);
      if (connection && !connection.closed) {
        if (inflight.kind === "subscription") {
          void this.#sendToConnection(connection, {
            id: inflight.requestId,
            type: "subscription.error",
            error: error ?? new Error(`Backend "${backend.id}" closed.`),
          });
        } else {
          void this.#sendToConnection(connection, {
            id: inflight.requestId,
            type: "error",
            error: error ?? new Error(`Backend "${backend.id}" closed.`),
          });
        }
      }
      this.#completeRequest(inflight.connectionId, inflight.requestId, backend.id);
    }

    if (backend.leasedConnectionId) {
      const connection = this.#connections.get(backend.leasedConnectionId);
      if (connection) {
        connection.dedicatedBackendId = undefined;
        connection.dedicatedInvalidated = true;
      }
    }
    backend.leasedConnectionId = undefined;

    const arr = backend.toDrain;
    backend.toDrain = [];
    arr.forEach((item) => item.rej(new Error(`Backend "${backend.id}" closed.`)));

    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const item = this.#queue[i];
      if (item.targetBackendId !== backend.id) continue;
      this.#queue.splice(i, 1);
      const connection = this.#connections.get(item.connectionId);
      if (connection && !connection.closed) {
        void this.#sendToConnection(connection, {
          id: item.request.id,
          type: "error",
          error: new Error("Dedicated backend unavailable."),
        });
      }
    }

    this.#drainQueue();
  }
}

