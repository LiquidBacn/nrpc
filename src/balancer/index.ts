import type {
  BroadcastResult,
  NRPCRequest,
  NRPCResponse,
} from "../shared/types.ts";
import { Queue, QueueClear } from "./queue.ts";

export { Queue, QueueClear };

type ActiveKind = "pending" | "subscription" | "event";

type RequestMessage = Extract<NRPCRequest, { type: "request" }>;
type BroadcastRequestMessage = Extract<
  NRPCRequest,
  { type: "request.broadcast" }
>;

type ActiveNormalRequest = {
  source: "request";
  connectionId: string;
  requestId: string;
  kind: ActiveKind;
};

type ActiveBroadcastRequest = {
  source: "broadcast";
  connectionId: string;
  parentRequestId: string;
  requestId: string;
  kind: ActiveKind;
};

type ActiveRequest = ActiveNormalRequest | ActiveBroadcastRequest;

type InFlightRequest = {
  backendId: string;
  kind: ActiveKind;
  bid?: string;
};

type IncomingQueueItem =
  | {
      kind: "request";
      requestId: string;
      connectionId: string;
      request: RequestMessage;
    }
  | {
      kind: "reservation";
      reservationId: string;
      connectionId: string;
      queue: Queue<LeaseQueueItem>;
    };

type BroadcastQueueItem = {
  childRequestId: string;
  parentRequestId: string;
  connectionId: string;
  resultIndex: number;
  request: RequestMessage;
};

type LeaseQueueItem =
  | {
      kind: "request";
      requestId: string;
      connectionId: string;
      request: RequestMessage;
    }
  | {
      kind: "close";
      releaseRequestId: string;
      connectionId: string;
      bid: string;
    };

type PendingQueuedRequest = {
  connectionId: string;
  requestId: string;
  bid?: string;
  canceled: boolean;
  assigned: boolean;
};

type PendingDrain = {
  res: () => void;
  rej: (error: any) => void;
};

type LeaseState = {
  reservationId: string;
  connectionId: string;
  backendId?: string;
  queue: Queue<LeaseQueueItem>;
  status: "pending" | "active" | "closing" | "closed";
  reserveRequestId: string;
  pendingReleaseRequestId?: string;
  queuedRequestIds: Set<string>;
  acknowledged: boolean;
};

type BroadcastOp = {
  parentRequestId: string;
  connectionId: string;
  targetBackendIds: string[];
  childRequestIdsByBackendId: Map<string, string>;
  results: Array<BroadcastResult<unknown> | undefined>;
  unfinishedCount: number;
  closed: boolean;
  canceled: boolean;
};

type BroadcastChild = {
  parentRequestId: string;
  connectionId: string;
  backendId: string;
  resultIndex: number;
  activated: boolean;
  settled: boolean;
  terminalSent: boolean;
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
  lease?: LeaseState;
  readyWaiters: (() => void)[];
  workerAbort: AbortController;
  broadcast: Queue<BroadcastQueueItem>;
};

type FrontendState = {
  id: string;
  send: (msg: NRPCResponse) => Promise<boolean | void> | boolean | void;
  close: () => void;
  closed: boolean;
  paused: boolean;
  toDrain: PendingDrain[];
  inFlight: Map<string, InFlightRequest>;
  leases: Map<string, LeaseState>;
  pendingReservations: Map<string, LeaseState>;
  pendingQueuedRequests: Map<string, PendingQueuedRequest>;
  broadcastRequestIds: Set<string>;
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
  drain: () => void;
  paused: () => boolean;
};

export class NRPCBalancer {
  #nextBackendId = 0;
  #nextConnectionId = 0;
  #nextReservationId = 0;
  #nextBroadcastId = 0;

  #backends = new Map<string, BackendState>();
  #connections = new Map<string, FrontendState>();
  #incoming = new Queue<IncomingQueueItem>();
  #leasesByReservationId = new Map<string, LeaseState>();
  #leasesByBid = new Map<string, LeaseState>();
  #broadcastOps = new Map<string, BroadcastOp>();
  #broadcastChildren = new Map<string, BroadcastChild>();

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
      readyWaiters: [],
      workerAbort: new AbortController(),
      broadcast: new Queue(),
    };

    this.#backends.set(id, backend);
    void this.#runBackendWorker(backend);

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
        this.#failPendingReservationsIfNoBackends();
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
      leases: new Map(),
      pendingReservations: new Map(),
      pendingQueuedRequests: new Map(),
      broadcastRequestIds: new Set(),
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
      drain: () => {
        this.#drainConnection(connection);
      },
      paused: () => connection.paused,
    };
  }

  getAvailableBackendCount(): number {
    let count = 0;

    for (const backend of this.#backends.values()) {
      if (
        backend.alive &&
        !backend.closed &&
        !backend.busy &&
        !backend.lease &&
        !backend.paused
      ) {
        count += 1;
      }
    }

    return count;
  }

  async #runBackendWorker(backend: BackendState) {
    while (!backend.closed) {
      await this.#waitForBackendReady(backend);
      if (backend.closed) return;

      try {
        const broadcastItem = backend.broadcast.tryRead();
        if (broadcastItem) {
          await this.#handleBroadcastQueueItem(backend, broadcastItem);
        } else if (backend.lease) {
          const item = backend.lease.queue.tryRead();
          if (item) {
            await this.#handleLeaseQueueItem(backend, item);
          }
        } else {
          const item = this.#incoming.tryRead();
          if (item) {
            await this.#handleIncomingQueueItem(backend, item);
          }
        }
      } catch (error) {
        if (backend.closed || backend.workerAbort.signal.aborted) {
          return;
        }
        if (error instanceof QueueClear) {
          continue;
        }
        throw error;
      }
    }
  }

  async #onFrontendMessage(connection: FrontendState, msg: any) {
    if (connection.closed) return;
    if (msg === null || typeof msg !== "object") return;

    const t = msg as NRPCRequest;

    if (t.type === "backend.reserve") {
      await this.#queueReservation(connection, t.id);
    } else if (t.type === "backend.release") {
      await this.#queueLeaseRelease(connection, t.id, t.bid);
    } else if (t.type === "request") {
      await this.#queueRequest(connection, t);
    } else if (t.type === "request.broadcast") {
      await this.#broadcastMsg(connection, t);
    } else if (
      t.type !== "request.cancel" &&
      t.type !== "subscription.end" &&
      t.type !== "subscription.error" &&
      t.type !== "subscription.pause" &&
      t.type !== "subscription.resume" &&
      t.type !== "event.end"
    ) {
      return;
    } else {
      const broadcastOp = this.#broadcastOps.get(t.id);
      if (broadcastOp && t.type === "request.cancel") {
        await this.#cancelBroadcastOp(
          broadcastOp,
          t.message ?? "Broadcast canceled.",
        );
      } else {
        const inFlight = connection.inFlight.get(t.id);
        if (inFlight) {
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
        } else {
          const pending = connection.pendingQueuedRequests.get(t.id);
          if (
            pending &&
            (t.type === "request.cancel" ||
              t.type === "subscription.end" ||
              t.type === "subscription.error" ||
              t.type === "event.end")
          ) {
            pending.canceled = true;
          }
        }
      }
    }
  }

  async #queueRequest(connection: FrontendState, request: RequestMessage) {
    const bid = request.bid;
    if (bid) {
      const lease = connection.leases.get(bid);
      if (!lease || lease.status !== "active") {
        await this.#sendToConnection(connection, {
          id: request.id,
          type: "error",
          error: new Error("Dedicated backend unavailable."),
        });
        return;
      }

      connection.pendingQueuedRequests.set(request.id, {
        connectionId: connection.id,
        requestId: request.id,
        bid,
        canceled: false,
        assigned: false,
      });
      lease.queuedRequestIds.add(request.id);
      lease.queue.write({
        kind: "request",
        requestId: request.id,
        connectionId: connection.id,
        request,
      });
      const backend = this.#backends.get(bid);
      if (backend) {
        this.#notifyBackendReady(backend);
      }
    } else {
      connection.pendingQueuedRequests.set(request.id, {
        connectionId: connection.id,
        requestId: request.id,
        canceled: false,
        assigned: false,
      });
      this.#incoming.write({
        kind: "request",
        requestId: request.id,
        connectionId: connection.id,
        request,
      });
      this.#notifyUnleasedBackendsReady();
    }
  }

  async #queueReservation(connection: FrontendState, requestId: string) {
    const reservationId = `lease_${this.#nextReservationId++}`;
    const lease: LeaseState = {
      reservationId,
      connectionId: connection.id,
      queue: new Queue<LeaseQueueItem>(),
      status: "pending",
      reserveRequestId: requestId,
      queuedRequestIds: new Set(),
      acknowledged: false,
    };

    connection.pendingReservations.set(reservationId, lease);
    this.#leasesByReservationId.set(reservationId, lease);
    this.#incoming.write({
      kind: "reservation",
      reservationId,
      connectionId: connection.id,
      queue: lease.queue,
    });
    this.#notifyUnleasedBackendsReady();
  }

  async #queueLeaseRelease(
    connection: FrontendState,
    requestId: string,
    bid: string,
  ) {
    const lease = connection.leases.get(bid);
    if (
      !lease ||
      lease.status === "closed" ||
      lease.connectionId !== connection.id
    ) {
      await this.#sendToConnection(connection, {
        id: requestId,
        type: "error",
        error: new Error("Dedicated backend unavailable."),
      });
      return;
    }

    if (lease.status !== "active") {
      await this.#sendToConnection(connection, {
        id: requestId,
        type: "error",
        error: new Error("Backend lease already closing."),
      });
      return;
    }

    lease.status = "closing";
    lease.pendingReleaseRequestId = requestId;
    lease.queue.write({
      kind: "close",
      releaseRequestId: requestId,
      connectionId: connection.id,
      bid,
    });
    const backend = this.#backends.get(bid);
    if (backend) {
      this.#notifyBackendReady(backend);
    }
  }

  async #handleIncomingQueueItem(
    backend: BackendState,
    item: IncomingQueueItem,
  ) {
    if (!backend.alive || backend.closed || backend.busy) {
      return;
    }

    if (item.kind === "request") {
      const connection = this.#connections.get(item.connectionId);
      const pending = connection?.pendingQueuedRequests.get(item.requestId);
      if (
        !connection ||
        connection.closed ||
        !pending ||
        pending.canceled ||
        pending.assigned
      ) {
        return;
      }

      this.#activateRequest(connection, backend, item.request);
      pending.assigned = true;
      connection.pendingQueuedRequests.delete(item.requestId);
      await this.#sendToBackend(backend, item.request);
    } else {
      const lease = this.#leasesByReservationId.get(item.reservationId);
      const connection = this.#connections.get(item.connectionId);
      if (
        !lease ||
        lease.status !== "pending" ||
        !connection ||
        connection.closed ||
        connection.pendingReservations.get(item.reservationId) !== lease
      ) {
        return;
      }

      lease.backendId = backend.id;
      lease.status = "active";
      backend.lease = lease;
      connection.pendingReservations.delete(item.reservationId);
      connection.leases.set(backend.id, lease);
      this.#leasesByBid.set(backend.id, lease);

      await this.#sendToConnection(connection, {
        id: lease.reserveRequestId,
        type: "backend.reserved",
        bid: backend.id,
      });
      lease.acknowledged = true;
    }
  }

  async #handleLeaseQueueItem(backend: BackendState, item: LeaseQueueItem) {
    const lease = backend.lease;
    if (!lease || lease.backendId !== backend.id) {
      return;
    }

    if (item.kind === "request") {
      const connection = this.#connections.get(item.connectionId);
      const pending = connection?.pendingQueuedRequests.get(item.requestId);
      if (
        !connection ||
        connection.closed ||
        !pending ||
        pending.canceled ||
        pending.assigned
      ) {
        lease.queuedRequestIds.delete(item.requestId);
        return;
      }

      this.#activateLeasedRequest(connection, backend, item.request);
      pending.assigned = true;
      connection.pendingQueuedRequests.delete(item.requestId);
      lease.queuedRequestIds.delete(item.requestId);
      void this.#sendToBackend(backend, item.request).catch(() => {});
    } else if (item.bid === backend.id) {
      await this.#maybeFinalizeClosingLease(backend);
    }
  }

  async #handleBroadcastQueueItem(
    backend: BackendState,
    item: BroadcastQueueItem,
  ) {
    if (!backend.alive || backend.closed || backend.busy) {
      return;
    }

    const child = this.#broadcastChildren.get(item.childRequestId);
    const op = this.#broadcastOps.get(item.parentRequestId);
    const connection = this.#connections.get(item.connectionId);
    if (
      !child ||
      !op ||
      op.closed ||
      child.settled ||
      !connection ||
      connection.closed
    ) {
      return;
    }

    child.activated = true;
    this.#activateBroadcastRequest(connection, backend, item);

    try {
      await this.#sendToBackend(backend, item.request);
    } catch (error) {
      await this.#settleBroadcastChild(
        item.childRequestId,
        {
          backendId: backend.id,
          type: "error",
          error,
        },
        true,
      );
    }
  }

  #activateRequest(
    connection: FrontendState,
    backend: BackendState,
    request: RequestMessage,
  ) {
    backend.busy = true;
    backend.active = {
      source: "request",
      connectionId: connection.id,
      requestId: request.id,
      kind: "pending",
    };

    connection.inFlight.set(request.id, {
      backendId: backend.id,
      kind: "pending",
      bid: request.bid,
    });
  }

  #activateLeasedRequest(
    connection: FrontendState,
    backend: BackendState,
    request: RequestMessage,
  ) {
    connection.inFlight.set(request.id, {
      backendId: backend.id,
      kind: "pending",
      bid: request.bid,
    });
  }

  #activateBroadcastRequest(
    connection: FrontendState,
    backend: BackendState,
    item: BroadcastQueueItem,
  ) {
    backend.busy = true;
    backend.active = {
      source: "broadcast",
      connectionId: connection.id,
      parentRequestId: item.parentRequestId,
      requestId: item.childRequestId,
      kind: "pending",
    };
  }

  async #onBackendMessage(backend: BackendState, msg: any) {
    if (!backend.alive || backend.closed) return;
    if (msg === null || typeof msg !== "object") return;

    const t = msg as NRPCResponse;
    if (backend.active?.requestId === t.id) {
      if (backend.active.source === "request") {
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
          if (inFlight) {
            inFlight.kind = "subscription";
          }
          await this.#sendToConnection(connection, t);
        } else if (t.type === "event.start") {
          backend.active.kind = "event";
          const inFlight = connection.inFlight.get(t.id);
          if (inFlight) {
            inFlight.kind = "event";
          }
          await this.#sendToConnection(connection, t);
        } else {
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
      } else {
        await this.#handleBroadcastBackendMessage(backend, t);
      }
      return;
    }

    await this.#handleLeasedBackendMessage(backend, t);
  }

  async #handleLeasedBackendMessage(
    backend: BackendState,
    msg: NRPCResponse,
  ) {
    const lease = backend.lease;
    if (!lease || lease.backendId !== backend.id) {
      return;
    }

    const connection = this.#connections.get(lease.connectionId);
    if (!connection || connection.closed) {
      return;
    }

    const inFlight = connection.inFlight.get(msg.id);
    if (!inFlight || inFlight.backendId !== backend.id) {
      return;
    }

    if (msg.type === "subscription.start") {
      inFlight.kind = "subscription";
      await this.#sendToConnection(connection, msg);
    } else if (msg.type === "event.start") {
      inFlight.kind = "event";
      await this.#sendToConnection(connection, msg);
    } else {
      await this.#sendToConnection(connection, msg);

      if (
        msg.type === "result" ||
        msg.type === "error" ||
        msg.type === "subscription.end" ||
        msg.type === "subscription.error"
      ) {
        this.#completeRequest(connection.id, msg.id, backend.id);
      }
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

  async #handleBroadcastBackendMessage(
    backend: BackendState,
    msg: NRPCResponse,
  ) {
    const active = backend.active;
    if (!active || active.source !== "broadcast") {
      return;
    }

    const child = this.#broadcastChildren.get(active.requestId);
    if (!child) {
      if (
        msg.type === "result" ||
        msg.type === "error" ||
        msg.type === "subscription.end" ||
        msg.type === "subscription.error"
      ) {
        this.#completeBackendActivity(backend);
      }
      return;
    }

    const queryOnlyError = new Error("Broadcast only supports query routes.");
    if (msg.type === "result") {
      await this.#settleBroadcastChild(
        active.requestId,
        {
          backendId: backend.id,
          type: "result",
          value: msg.payload,
        },
        true,
      );
    } else if (msg.type === "error") {
      await this.#settleBroadcastChild(
        active.requestId,
        {
          backendId: backend.id,
          type: "error",
          error: msg.error,
        },
        true,
      );
    } else if (msg.type === "subscription.start") {
      active.kind = "subscription";
      child.terminalSent = true;
      void this.#sendToBackend(backend, {
        id: active.requestId,
        type: "subscription.end",
      }).catch(() => {});
      await this.#settleBroadcastChild(
        active.requestId,
        {
          backendId: backend.id,
          type: "error",
          error: queryOnlyError,
        },
        false,
      );
    } else if (msg.type === "event.start") {
      active.kind = "event";
      child.terminalSent = true;
      void this.#sendToBackend(backend, {
        id: active.requestId,
        type: "event.end",
      }).catch(() => {});
      await this.#settleBroadcastChild(
        active.requestId,
        {
          backendId: backend.id,
          type: "error",
          error: queryOnlyError,
        },
        false,
      );
    } else if (
      msg.type === "subscription.end" ||
      msg.type === "subscription.error"
    ) {
      if (!child.settled) {
        await this.#settleBroadcastChild(
          active.requestId,
          {
            backendId: backend.id,
            type: "error",
            error:
              msg.type === "subscription.error" ? msg.error : queryOnlyError,
          },
          false,
        );
      }
      this.#removeBroadcastChild(active.requestId);
      this.#completeBackendActivity(backend);
    } else if (msg.type === "event.data" || msg.type === "subscription.data") {
      if (!child.settled) {
        await this.#settleBroadcastChild(
          active.requestId,
          {
            backendId: backend.id,
            type: "error",
            error: queryOnlyError,
          },
          false,
        );
      }
    } else {
      await this.#settleBroadcastChild(
        active.requestId,
        {
          backendId: backend.id,
          type: "error",
          error: new Error(`Unexpected broadcast response type "${msg.type}".`),
        },
        true,
      );
    }
  }

  async #broadcastMsg(
    connection: FrontendState,
    request: BroadcastRequestMessage,
  ) {
    const targets = [...this.#backends.values()].filter(
      (backend) => backend.alive && !backend.closed,
    );
    if (!targets.length) {
      await this.#sendToConnection(connection, {
        id: request.id,
        type: "result",
        payload: [],
      });
      return;
    }

    const op: BroadcastOp = {
      parentRequestId: request.id,
      connectionId: connection.id,
      targetBackendIds: targets.map((backend) => backend.id),
      childRequestIdsByBackendId: new Map(),
      results: new Array(targets.length),
      unfinishedCount: targets.length,
      closed: false,
      canceled: false,
    };
    this.#broadcastOps.set(request.id, op);
    connection.broadcastRequestIds.add(request.id);

    targets.forEach((backend, resultIndex) => {
      const childRequestId = `broadcast_${this.#nextBroadcastId++}`;
      op.childRequestIdsByBackendId.set(backend.id, childRequestId);
      this.#broadcastChildren.set(childRequestId, {
        parentRequestId: request.id,
        connectionId: connection.id,
        backendId: backend.id,
        resultIndex,
        activated: false,
        settled: false,
        terminalSent: false,
      });
      backend.broadcast.write({
        childRequestId,
        parentRequestId: request.id,
        connectionId: connection.id,
        resultIndex,
        request: {
          id: childRequestId,
          type: "request",
          input: request.input,
          path: request.path,
        },
      });
      this.#notifyBackendReady(backend);
    });
  }

  async #cancelBroadcastOp(op: BroadcastOp, message: string) {
    if (op.closed || op.canceled) {
      return;
    }

    op.canceled = true;

    for (const childRequestId of op.childRequestIdsByBackendId.values()) {
      const child = this.#broadcastChildren.get(childRequestId);
      if (!child || child.settled) {
        continue;
      }

      if (!child.activated) {
        await this.#settleBroadcastChild(
          childRequestId,
          {
            backendId: child.backendId,
            type: "error",
            error: new Error(message),
          },
          false,
        );
      } else {
        const backend = this.#backends.get(child.backendId);
        if (backend && backend.alive && !backend.closed) {
          void this.#sendToBackend(backend, {
            id: childRequestId,
            type: "request.cancel",
            message,
          }).catch(() => {});
        }
      }
    }
  }

  async #settleBroadcastChild(
    childRequestId: string,
    result: BroadcastResult<unknown>,
    completeBackendActivity: boolean,
  ) {
    const child = this.#broadcastChildren.get(childRequestId);
    if (!child || child.settled) {
      if (completeBackendActivity) {
        const backend = this.#backends.get(result.backendId);
        if (backend) {
          this.#removeBroadcastChild(childRequestId);
          this.#completeBackendActivity(backend);
        }
      }
      return;
    }

    child.settled = true;
    const op = this.#broadcastOps.get(child.parentRequestId);
    if (!op || op.closed) {
      this.#removeBroadcastChild(childRequestId);
      if (completeBackendActivity) {
        const backend = this.#backends.get(child.backendId);
        if (backend) {
          this.#completeBackendActivity(backend);
        }
      }
      return;
    }

    op.results[child.resultIndex] = result;
    op.unfinishedCount -= 1;

    if (completeBackendActivity) {
      this.#removeBroadcastChild(childRequestId);
      const backend = this.#backends.get(child.backendId);
      if (backend) {
        this.#completeBackendActivity(backend);
      }
    } else if (!child.activated) {
      this.#removeBroadcastChild(childRequestId);
    }

    if (!op.unfinishedCount) {
      await this.#finalizeBroadcastOp(op);
    }
  }

  async #finalizeBroadcastOp(op: BroadcastOp) {
    if (op.closed) {
      return;
    }

    op.closed = true;
    this.#broadcastOps.delete(op.parentRequestId);

    const connection = this.#connections.get(op.connectionId);
    connection?.broadcastRequestIds.delete(op.parentRequestId);

    if (connection && !connection.closed) {
      await this.#sendToConnection(connection, {
        id: op.parentRequestId,
        type: "result",
        payload: op.results as BroadcastResult<unknown>[],
      });
    }
  }

  #removeBroadcastChild(childRequestId: string) {
    this.#broadcastChildren.delete(childRequestId);
  }

  #completeBackendActivity(backend: BackendState) {
    backend.active = undefined;
    backend.busy = false;
    if (backend.lease?.status === "closing") {
      void this.#maybeFinalizeClosingLease(backend).catch(() => {});
    }
    this.#notifyBackendReady(backend);
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
      this.#completeBackendActivity(backend);
    } else if (backend?.lease?.status === "closing") {
      void this.#maybeFinalizeClosingLease(backend).catch(() => {});
    }
  }

  async #maybeFinalizeClosingLease(backend: BackendState) {
    const lease = backend.lease;
    if (
      !lease ||
      lease.status !== "closing" ||
      backend.busy ||
      backend.broadcast.size() > 0 ||
      this.#hasLeasedInFlightRequests(backend, lease) ||
      lease.queue.size() > 0
    ) {
      return;
    }

    await this.#finalizeLease(
      backend,
      lease,
      lease.pendingReleaseRequestId,
    );
  }

  #hasLeasedInFlightRequests(backend: BackendState, lease: LeaseState) {
    const connection = this.#connections.get(lease.connectionId);
    if (!connection || connection.closed) {
      return false;
    }

    for (const request of connection.inFlight.values()) {
      if (request.backendId === backend.id) {
        return true;
      }
    }

    return false;
  }

  async #finalizeLease(
    backend: BackendState,
    lease: LeaseState,
    releaseRequestId?: string,
  ) {
    backend.lease = undefined;
    lease.status = "closed";
    this.#leasesByReservationId.delete(lease.reservationId);
    if (lease.backendId) {
      this.#leasesByBid.delete(lease.backendId);
    }

    const connection = this.#connections.get(lease.connectionId);
    if (connection) {
      if (lease.backendId) {
        connection.leases.delete(lease.backendId);
      }
      connection.pendingReservations.delete(lease.reservationId);
    }

    const shouldAck =
      !!releaseRequestId &&
      releaseRequestId === lease.pendingReleaseRequestId &&
      connection &&
      !connection.closed;

    lease.pendingReleaseRequestId = undefined;
    lease.backendId = undefined;

    if (shouldAck) {
      await this.#sendToConnection(connection, {
        id: releaseRequestId!,
        type: "backend.released",
        bid: backend.id,
      });
    }

    this.#notifyBackendReady(backend);
  }

  async #waitForBackendReady(backend: BackendState) {
    if (backend.closed) return;
    if (!backend.busy && !backend.paused && this.#hasBackendWork(backend)) {
      return;
    }

    await new Promise<void>((res) => {
      backend.readyWaiters.push(res);
    });
  }

  #hasBackendWork(backend: BackendState) {
    return (
      backend.broadcast.size() > 0 ||
      (backend.lease ?
        backend.lease.queue.size() > 0
      : this.#incoming.size() > 0)
    );
  }

  #notifyBackendReady(backend: BackendState) {
    if (backend.readyWaiters.length && !backend.busy) {
      const waiter = backend.readyWaiters.shift()!;
      waiter();
    }
  }

  #notifyUnleasedBackendsReady() {
    for (const backend of this.#backends.values()) {
      if (!backend.lease) {
        this.#notifyBackendReady(backend);
      }
    }
  }

  #markPendingRequestCanceled(connection: FrontendState, requestId: string) {
    const pending = connection.pendingQueuedRequests.get(requestId);
    if (!pending) return;

    pending.canceled = true;
    if (pending.bid) {
      const lease =
        connection.leases.get(pending.bid) ??
        this.#leasesByBid.get(pending.bid);
      lease?.queuedRequestIds.delete(requestId);
    }
  }

  #enqueueLeaseClose(lease: LeaseState, releaseRequestId: string) {
    if (lease.status === "closed") return;
    if (lease.status === "pending") {
      lease.status = "closed";
      this.#leasesByReservationId.delete(lease.reservationId);
      const connection = this.#connections.get(lease.connectionId);
      connection?.pendingReservations.delete(lease.reservationId);
      return;
    }

    if (lease.status === "active") {
      lease.status = "closing";
    }

    lease.queue.write({
      kind: "close",
      releaseRequestId,
      connectionId: lease.connectionId,
      bid: lease.backendId!,
    });
    const backend = this.#backends.get(lease.backendId!);
    if (backend) {
      this.#notifyBackendReady(backend);
    }
  }

  #closeConnection(connection: FrontendState) {
    if (connection.closed) return;
    const waiters = connection.toDrain;
    connection.toDrain = [];
    waiters.forEach((item) => item.rej(new Error("Connection closed.")));

    connection.closed = true;
    this.#connections.delete(connection.id);

    const broadcastRequestIds = [...connection.broadcastRequestIds];
    connection.broadcastRequestIds.clear();
    for (const requestId of broadcastRequestIds) {
      const op = this.#broadcastOps.get(requestId);
      if (op) {
        void this.#cancelBroadcastOp(op, "Broadcast canceled.").catch(() => {});
      }
    }

    for (const lease of connection.pendingReservations.values()) {
      lease.status = "closed";
      this.#leasesByReservationId.delete(lease.reservationId);
    }
    connection.pendingReservations.clear();

    for (const requestId of connection.pendingQueuedRequests.keys()) {
      this.#markPendingRequestCanceled(connection, requestId);
    }

    for (const lease of connection.leases.values()) {
      for (const requestId of lease.queuedRequestIds) {
        this.#markPendingRequestCanceled(connection, requestId);
      }
      if (lease.status !== "closed") {
        this.#enqueueLeaseClose(lease, `release_${lease.reservationId}`);
      }
    }

    const active = [...connection.inFlight.entries()];
    connection.inFlight.clear();

    for (const [requestId, info] of active) {
      const backend = this.#backends.get(info.backendId);
      if (backend && backend.alive && !backend.closed) {
        if (info.kind === "subscription") {
          void this.#sendToBackend(backend, {
            id: requestId,
            type: "subscription.end",
            bid: info.bid,
          });
        } else if (info.kind === "event") {
          void this.#sendToBackend(backend, {
            id: requestId,
            type: "event.end",
            bid: info.bid,
          });
        } else {
          void this.#sendToBackend(backend, {
            id: requestId,
            type: "request.cancel",
            bid: info.bid,
          });
        }
      }

      this.#completeRequest(connection.id, requestId, info.backendId);
    }

    connection.leases.clear();
    connection.pendingQueuedRequests.clear();
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
    this.#notifyBackendReady(backend);
  }

  #failLease(lease: LeaseState, error: Error) {
    const connection = this.#connections.get(lease.connectionId);

    if (!lease.acknowledged) {
      if (connection && !connection.closed) {
        void this.#sendToConnection(connection, {
          id: lease.reserveRequestId,
          type: "error",
          error,
        });
      }
    } else {
      for (const requestId of lease.queuedRequestIds) {
        const pending = connection?.pendingQueuedRequests.get(requestId);
        if (!pending) continue;
        if (connection) {
          connection.pendingQueuedRequests.delete(requestId);
        }
        if (connection && !connection.closed && !pending.canceled) {
          void this.#sendToConnection(connection, {
            id: requestId,
            type: "error",
            error: new Error("Dedicated backend unavailable."),
          });
        }
      }
    }

    lease.queuedRequestIds.clear();

    if (lease.pendingReleaseRequestId && connection && !connection.closed) {
      void this.#sendToConnection(connection, {
        id: lease.pendingReleaseRequestId,
        type: "error",
        error: new Error("Dedicated backend unavailable."),
      });
    }

    if (lease.backendId) {
      connection?.leases.delete(lease.backendId);
      this.#leasesByBid.delete(lease.backendId);
    }
    connection?.pendingReservations.delete(lease.reservationId);
    this.#leasesByReservationId.delete(lease.reservationId);
    lease.pendingReleaseRequestId = undefined;
    lease.status = "closed";
    lease.backendId = undefined;
  }

  #failPendingReservationsIfNoBackends() {
    const hasLiveBackend = [...this.#backends.values()].some(
      (backend) => backend.alive && !backend.closed,
    );
    if (hasLiveBackend) {
      return;
    }

    for (const lease of this.#leasesByReservationId.values()) {
      if (lease.status !== "pending") continue;
      this.#failLease(
        lease,
        new Error("No backend available for dedicated lease."),
      );
    }
  }

  #failBroadcastChildrenForBackend(backend: BackendState, error: unknown) {
    const backendError = error ?? new Error(`Backend "${backend.id}" closed.`);
    const matchingChildren = [...this.#broadcastChildren.entries()].filter(
      ([, child]) => child.backendId === backend.id,
    );

    for (const [childRequestId, child] of matchingChildren) {
      if (child.settled) {
        this.#removeBroadcastChild(childRequestId);
      } else {
        void this.#settleBroadcastChild(
          childRequestId,
          {
            backendId: backend.id,
            type: "error",
            error: backendError,
          },
          child.activated,
        ).catch(() => {});
      }
    }
  }

  #closeBackend(backend: BackendState, error?: unknown) {
    if (backend.closed) return;
    backend.closed = true;
    backend.alive = false;
    backend.workerAbort.abort(new Error(`Backend "${backend.id}" closed.`));
    const backendError = error ?? new Error(`Backend "${backend.id}" closed.`);

    const inflight = backend.active;
    if (inflight?.source === "request") {
      const connection = this.#connections.get(inflight.connectionId);
      if (connection && !connection.closed) {
        if (inflight.kind === "subscription") {
          void this.#sendToConnection(connection, {
            id: inflight.requestId,
            type: "subscription.error",
            error: backendError,
          });
        } else {
          void this.#sendToConnection(connection, {
            id: inflight.requestId,
            type: "error",
            error: backendError,
          });
        }
      }
      this.#completeRequest(
        inflight.connectionId,
        inflight.requestId,
        backend.id,
      );
      this.#failBroadcastChildrenForBackend(backend, error);
    } else if (inflight?.source === "broadcast") {
      this.#failBroadcastChildrenForBackend(backend, error);
      this.#completeBackendActivity(backend);
    } else {
      this.#failBroadcastChildrenForBackend(backend, error);
    }

    if (backend.lease) {
      const connection = this.#connections.get(backend.lease.connectionId);
      const leasedInFlight = [...(connection?.inFlight.entries() ?? [])].filter(
        ([, request]) => request.backendId === backend.id,
      );
      for (const [requestId, request] of leasedInFlight) {
        if (connection && !connection.closed) {
          if (request.kind === "subscription") {
            void this.#sendToConnection(connection, {
              id: requestId,
              type: "subscription.error",
              error: backendError,
            });
          } else {
            void this.#sendToConnection(connection, {
              id: requestId,
              type: "error",
              error: backendError,
            });
          }
        }
        connection?.inFlight.delete(requestId);
      }
    }

    if (backend.lease) {
      this.#failLease(
        backend.lease,
        new Error("Dedicated backend unavailable."),
      );
      backend.lease = undefined;
    }

    backend.broadcast.clear();
    const arr = backend.toDrain;
    backend.toDrain = [];
    arr.forEach((item) =>
      item.rej(new Error(`Backend "${backend.id}" closed.`)),
    );
    this.#notifyBackendReady(backend);
    this.#failPendingReservationsIfNoBackends();
  }
}
