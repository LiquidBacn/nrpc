import { NRPCConnClosed, NRPCPromise } from "../shared/index.ts";
import type {
  BroadcastRouterToProxy,
  NRPCRequest,
  NRPCResponse,
  Router,
  RouterToProxy,
} from "../shared/types.ts";

type Call = {
  res: (val: any) => void;
  rej: (err?: any) => void;
  back: number;
  bid?: string;
};

type Sub = {
  data: ({ k: "v"; val: any } | { k: "e"; err: any })[];
  calls: Call[];
  done: boolean;
  paused: boolean;
  back: number;
  resume: number;
  gen: AsyncGenerator;
  bid?: string;
};

type ClientEventSub = {
  callbacks: Set<(value: any) => void>;
  bid?: string;
};

type LeaseState<R extends Router> = {
  bid: string;
  status: "active" | "releasing" | "released";
  releasePromise?: Promise<void>;
  handle: NRPCBackendLease<R>;
};

type ReserveOp<R extends Router> = {
  res: (val: NRPCBackendLease<R>) => void;
  rej: (err?: any) => void;
};

type ReleaseOp = {
  bid: string;
  res: () => void;
  rej: (err?: any) => void;
};

export type NRPCBackendLease<R extends Router> = {
  bid: string;
  proxy: RouterToProxy<R>;
  release: () => Promise<void>;
};

type ProxyMode = {
  bid?: string;
  requestType: "request" | "request.broadcast";
};

export function getClient<R extends Router>(
  sendMsg: (msg: NRPCRequest) => Promise<boolean | void> | boolean | void,
  close: () => void,
) {
  let paused = false;
  let closed = false;
  let nextId = 0;

  let inFlight = new Map<string, Call>();
  let subs = new Map<string, Sub>();
  let eventSubs = new Map<string, ClientEventSub>();
  let reserveOps = new Map<string, ReserveOp<R>>();
  let releaseOps = new Map<string, ReleaseOp>();
  let leases = new Map<string, LeaseState<R>>();
  let toDrain: { res: () => void; rej: (error: any) => void }[] = [];

  const nextMessageId = () => `nrpc_${nextId++}`;

  const addBid = <T extends { id: string; type: string }>(msg: T, bid?: string) =>
    bid ? { ...msg, bid } : msg;

  const send = async (msg: NRPCRequest) => {
    if (paused || toDrain.length) {
      await new Promise<void>((res, rej) => {
        toDrain.push({ res, rej });
      });
    }

    let bp = await sendMsg(msg);
    if (bp) {
      paused = true;
    } else if (toDrain.length) {
      let item = toDrain.shift()!;
      item.res();
    }
  };

  const getLeaseState = (bid?: string) => {
    if (!bid) return undefined;
    return leases.get(bid);
  };

  const assertLeaseActive = (bid?: string) => {
    if (!bid) return;
    const lease = getLeaseState(bid);
    if (!lease || lease.status !== "active") {
      throw new Error("Backend lease released.");
    }
  };

  const deQueueSub = async (id: string) => {
    let sub = subs.get(id);
    if (sub) {
      if (sub.calls.length && sub.data.length) {
        let data = sub.data.shift()!;
        let call = sub.calls.shift()!;

        if (data.k === "v") {
          call.res({ value: data.val, done: false });
        } else if (data.k === "e") {
          call.rej(data.err);
        }

        if (sub.data.length < sub.resume && sub.paused) {
          sub.paused = false;

          await send(addBid({ id, type: "subscription.resume" }, sub.bid));
        }
      } else if (sub.done && sub.calls.length && !sub.data.length) {
        if (closed) {
          sub.calls.forEach((a) => a.rej(new NRPCConnClosed()));
        } else {
          sub.calls.forEach((a) => a.res({ value: undefined, done: true }));
        }
        subs.delete(id);
      }
    }
  };

  const startLeaseRelease = (lease: LeaseState<R>) => {
    if (lease.status === "released") {
      return Promise.resolve();
    }
    if (lease.releasePromise) {
      return lease.releasePromise;
    }

    lease.status = "releasing";

    const id = nextMessageId();
    lease.releasePromise = new Promise<void>((res, rej) => {
      releaseOps.set(id, {
        bid: lease.bid,
        res: () => {
          lease.status = "released";
          leases.delete(lease.bid);
          res();
        },
        rej: (err) => {
          lease.status = "released";
          leases.delete(lease.bid);
          rej(err);
        },
      });

      void send({
        id,
        type: "backend.release",
        bid: lease.bid,
      }).catch((error) => {
        releaseOps.delete(id);
        lease.status = "released";
        leases.delete(lease.bid);
        rej(error);
      });
    });

    return lease.releasePromise;
  };

  const getProxy = (path: string[], mode: ProxyMode) => {
    return new Proxy(() => {}, {
      get(_, p) {
        if (p === "then") {
          return undefined;
        } else if (typeof p === "string") {
          return getProxy([...path, p], mode);
        }
      },
      apply: (_, __, args) => {
        if (closed) {
          return Promise.reject(new NRPCConnClosed());
        }

        try {
          assertLeaseActive(mode.bid);
        } catch (error) {
          return Promise.reject(error);
        }

        let back = 10;
        if (typeof args[1] === "number" && args[1] > 0) {
          back = args[1];
        }

        let id = nextMessageId();
        return new NRPCPromise(
          async (res, rej) => {
            inFlight.set(id, { res, rej, back, bid: mode.bid });

            try {
              if (mode.requestType === "request") {
                await send(
                  addBid(
                    {
                      id,
                      type: "request",
                      path,
                      input: args[0],
                    },
                    mode.bid,
                  ),
                );
              } else {
                await send({
                  id,
                  type: "request.broadcast",
                  path,
                  input: args[0],
                });
              }
            } catch (error) {
              inFlight.delete(id);
              rej(error);
            }
          },
          (message) => {
            inFlight.delete(id);
            void send(
              addBid(
                {
                  id,
                  type: "request.cancel",
                  message,
                },
                mode.bid,
              ),
            ).catch(() => {});
          },
        );
      },
    });
  };

  const onMsg = async (msg: any) => {
    if (closed) return;
    if (msg === null || typeof msg !== "object") {
      return;
    }

    let t = msg as NRPCResponse;

    switch (t.type) {
      case "result": {
        let call = inFlight.get(t.id);
        if (call) {
          inFlight.delete(t.id);
          call.res(t.payload);
        }
        break;
      }
      case "error": {
        let call = inFlight.get(t.id);
        if (call) {
          inFlight.delete(t.id);
          call.rej(t.error);
          break;
        }

        let reserveOp = reserveOps.get(t.id);
        if (reserveOp) {
          reserveOps.delete(t.id);
          reserveOp.rej(t.error);
          break;
        }

        let releaseOp = releaseOps.get(t.id);
        if (releaseOp) {
          releaseOps.delete(t.id);
          let lease = leases.get(releaseOp.bid);
          if (lease) {
            lease.status = "released";
            leases.delete(releaseOp.bid);
          }
          releaseOp.rej(t.error);
        }
        break;
      }
      case "subscription.start": {
        let call = inFlight.get(t.id);
        if (call) {
          let bid = call.bid;
          let gen: AsyncGenerator = {
            next: () => {
              return new Promise((res, rej) => {
                let sub = subs.get(t.id);
                if (sub) {
                  sub.calls.push({ res, rej, back: 0, bid });
                  subs.set(t.id, sub);
                  void deQueueSub(t.id);
                } else {
                  res({ value: undefined, done: true });
                }
              });
            },
            return: async (value) => {
              await send(addBid({ id: t.id, type: "subscription.end" }, bid));
              subs.delete(t.id);
              return { value, done: true };
            },
            throw: async (error) => {
              await send(
                addBid(
                  {
                    id: t.id,
                    type: "subscription.error",
                    error,
                  },
                  bid,
                ),
              );
              subs.delete(t.id);
              return { value: undefined, done: true };
            },
            [Symbol.asyncDispose]: async () => {
              await send(addBid({ id: t.id, type: "subscription.end" }, bid));
              subs.delete(t.id);
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          };

          let resume = Math.max(1, Math.ceil(call.back / 2));
          subs.set(t.id, {
            calls: [],
            data: [],
            done: false,
            paused: false,
            back: call.back,
            resume,
            gen,
            bid,
          });
          inFlight.delete(t.id);
          call.res(gen);
        }
        break;
      }
      case "subscription.data": {
        let sub = subs.get(t.id);
        if (sub) {
          sub.data.push({ k: "v", val: t.payload });
          await deQueueSub(t.id);

          if (sub.data.length > sub.back && !sub.paused) {
            sub.paused = true;

            await send(
              addBid(
                {
                  id: t.id,
                  type: "subscription.pause",
                },
                sub.bid,
              ),
            );
          }
        }
        break;
      }
      case "subscription.end": {
        let sub = subs.get(t.id);
        if (sub) {
          sub.done = true;
          await deQueueSub(t.id);
        }
        break;
      }
      case "subscription.error": {
        let sub = subs.get(t.id);
        if (sub) {
          sub.data.push({ k: "e", err: t.error });
          await deQueueSub(t.id);
        }
        break;
      }
      case "event.start": {
        let call = inFlight.get(t.id);
        if (call) {
          inFlight.delete(t.id);
          const callbacks = new Set<(value: any) => void>();
          const close = () => {
            eventSubs.delete(t.id);
            void send(addBid({ id: t.id, type: "event.end" }, call.bid)).catch(
              () => {},
            );
          };
          eventSubs.set(t.id, { callbacks, bid: call.bid });
          call.res({
            on: (cb: (value: any) => void) => callbacks.add(cb),
            close,
          });
        }
        break;
      }
      case "event.data": {
        let eventSub = eventSubs.get(t.id);
        if (eventSub) {
          eventSub.callbacks.forEach((cb) => cb(t.payload));
        }
        break;
      }
      case "backend.reserved": {
        let reserveOp = reserveOps.get(t.id);
        if (reserveOp) {
          reserveOps.delete(t.id);
          let lease = leases.get(t.bid);
          if (!lease) {
            const newLease: LeaseState<R> = {
              bid: t.bid,
              status: "active",
              handle: undefined as any,
            };
            newLease.handle = {
              bid: t.bid,
              proxy: getProxy([], {
                bid: t.bid,
                requestType: "request",
              }) as any as RouterToProxy<R>,
              release: () => startLeaseRelease(newLease),
            };
            leases.set(t.bid, newLease);
            lease = newLease;
          }
          reserveOp.res(lease.handle);
        }
        break;
      }
      case "backend.released": {
        let releaseOp = releaseOps.get(t.id);
        if (releaseOp) {
          releaseOps.delete(t.id);
          let lease = leases.get(releaseOp.bid);
          if (lease) {
            lease.status = "released";
            leases.delete(releaseOp.bid);
          }
          releaseOp.res();
        }
        break;
      }
    }
  };

  const onClose = () => {
    if (closed) return;
    closed = true;

    for (let [, call] of inFlight) {
      call.rej(new NRPCConnClosed());
    }
    inFlight.clear();

    for (let [, reserveOp] of reserveOps) {
      reserveOp.rej(new NRPCConnClosed());
    }
    reserveOps.clear();

    for (let [, releaseOp] of releaseOps) {
      releaseOp.rej(new NRPCConnClosed());
    }
    releaseOps.clear();

    leases.clear();

    let arr = toDrain;
    toDrain = [];
    arr.forEach((a) => a.rej(new NRPCConnClosed()));

    for (let [id, sub] of subs) {
      sub.done = true;
      void deQueueSub(id);
    }

    eventSubs.clear();
  };

  const proxy = getProxy([], {
    requestType: "request",
  }) as any as RouterToProxy<R>;
  const broadcast = getProxy([], {
    requestType: "request.broadcast",
  }) as any as BroadcastRouterToProxy<R>;

  const reserveBackend = () => {
    if (closed) {
      return Promise.reject(new NRPCConnClosed());
    }

    const id = nextMessageId();
    return new Promise<NRPCBackendLease<R>>((res, rej) => {
      reserveOps.set(id, { res, rej });
      void send({
        id,
        type: "backend.reserve",
      }).catch((error) => {
        reserveOps.delete(id);
        rej(error);
      });
    });
  };

  const drain = () => {
    paused = false;

    if (toDrain.length) {
      let item = toDrain.shift()!;
      item.res();
    }
  };

  return {
    onMsg,
    onClose,
    proxy,
    broadcast,
    reserveBackend,
    drain,
    paused: () => paused,
  };
}
