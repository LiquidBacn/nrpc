import { NRPCConnClosed, NRPCPromise, NRPCSubEnded } from "../shared/index.ts";
import type {
  Routes,
  Router,
  RouterToProxy,
  NRPCRequest,
  NRPCResponse,
  Route,
  EventsToProxy,
  EventProp,
  EventSub,
  RouterToCIn,
} from "../shared/types.ts";

type EventConnection = {
  send: (msg: NRPCResponse) => Promise<boolean | void> | boolean | void;
  subscriptions: Map<string, string[]>;
};

// export class NRPCServer<CIn, COut, Rts extends Routes<COut>>
export class NRPCServer<R extends Router<any, any, any>> {
  router: R;
  #connections = new Set<EventConnection>();

  #reg = new FinalizationRegistry<EventConnection>((val) => {
    this.#connections.delete(val);
  });

  constructor(router: R) {
    this.router = router;
  }

  get events(): EventsToProxy<R> {
    const getProxy = (path: string[]): any => {
      return new Proxy(() => {}, {
        get(_, p) {
          if (p === "then") return undefined;
          if (typeof p === "string") return getProxy([...path, p]);
        },
        apply: (_, __, [payload]) => {
          const pathStr = path.join(".");
          for (const conn of this.#connections) {
            for (const [id, subPath] of conn.subscriptions) {
              if (subPath.join(".") === pathStr) {
                conn.send({ id, type: "event.data", payload });
              }
            }
          }
        },
      });
    };
    return getProxy([]);
  }

  async getRoute(ctx: RouterToCIn<R>, path: string[]) {
    let c = await this.router.middle(ctx);
    let pointer: Router = this.router;
    let working = [...path];

    while (working.length) {
      let segment = working.shift();
      if (typeof segment === "string" && segment in pointer.routes) {
        let route = pointer.routes[segment];
        switch (route._tag) {
          case "q":
          case "s":
          case "e":
            return { route, c } as { route: Route; c: any };

          case "r": {
            c = await route.middle(c);
            pointer = route;
            break;
          }
        }
      } else {
        throw new Error(`"${segment}" in "${path.join(".")}" Not Found.`);
      }
    }

    return { route: pointer, c } as { route: Route; c: any };
  }

  getLocalCaller(ctx: RouterToCIn<R>) {
    let eventSubs = new Map<string, EventSub>();
    let eventConn: EventConnection = {
      async send(t) {
        switch (t.type) {
          case "event.data": {
            let eventSub = eventSubs.get(t.id);
            if (eventSub) {
              eventSub.callbacks.forEach((cb) => cb(t.payload));
            }
            break;
          }
          case "event.start":
          case "event.end":
        }
      },
      subscriptions: new Map(),
    };
    this.#connections.add(eventConn);

    let nextID = 0;

    const getProxy = (path: string[]) => {
      return new Proxy(() => {}, {
        get(_, p) {
          if (p === "then") {
            return undefined;
          } else if (typeof p === "string") {
            return getProxy([...path, p]);
          }
        },
        apply: (_, t, args) => {
          const controller = new AbortController();
          return new NRPCPromise(
            async (res, rej) => {
              try {
                let arg = args[0];
                let signal = controller.signal;
                let rt;

                let { route, c } = await this.getRoute(ctx, path);

                switch (route._tag) {
                  case "q": {
                    let v: any;
                    if (typeof route.validator === "function") {
                      v = route.validator(arg);
                    } else {
                      v = route.validator.parse(arg);
                    }
                    rt = await route.method(c, v, signal);
                    break;
                  }
                  case "s": {
                    let v: any;
                    if (typeof route.validator === "function") {
                      v = route.validator(arg);
                    } else {
                      v = route.validator.parse(arg);
                    }
                    rt = await route.method(c, v);
                    break;
                  }
                  case "e": {
                    const id = `event_${nextID++}`;
                    const callbacks = new Set<(value: any) => void>();
                    const close = () => {
                      eventSubs.delete(id);
                      eventConn.subscriptions.delete(id);
                    };
                    eventSubs.set(id, { callbacks });

                    eventConn.subscriptions.set(id, path);

                    rt = {
                      on: (cb: (value: any) => void) => callbacks.add(cb),
                      close,
                    } as EventProp<any>;
                    break;
                  }
                  case "r": {
                    throw new Error(`Path "${path.join(".")}" incomplete.`);
                  }
                }

                res(rt);
              } catch (e) {
                rej(e);
              }
            },
            () => {
              controller.abort();
            },
          );
        },
      });
    };

    let rt = getProxy([]) as any as RouterToProxy<R>;

    this.#reg.register(rt, eventConn);

    return rt;
  }

  getConnection(
    ctx: RouterToCIn<R>,
    /**
     * send a Message to the client via user provided means.
     * user can return a bool that when true it applies back pressure.
     */
    sendMsg: (msg: NRPCResponse) => Promise<boolean | void> | boolean | void,
    close: () => void,
  ) {
    let requests = new Map<string, AbortController>();
    let paused = false;
    const send = async (msg: NRPCResponse) => {
      if (paused) {
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

    let toDrain: { res: () => void; rej: (error: any) => void }[] = [];

    let closed = false;
    const activeSubs = new Map<
      string,
      {
        paused: boolean;
        resume: { res: () => void; rej: (err: any) => void }[];
      }
    >();

    const eventConn: EventConnection = {
      send,
      subscriptions: new Map(),
    };
    this.#connections.add(eventConn);

    const onMsg = async (msg: any) => {
      if (closed) return;
      if (msg === null || typeof msg !== "object") {
        return;
      }

      let t = msg as NRPCRequest;
      try {
        if (t.type == "request") {
          let { route, c } = await this.getRoute(ctx, t.path);

          switch (route._tag) {
            case "q": {
              let v: any;
              if (typeof route.validator === "function") {
                v = route.validator(t.input);
              } else {
                v = route.validator.parse(t.input);
              }

              let controller = new AbortController();

              requests.set(t.id, controller);
              let rt = await route.method(c, v, controller.signal);
              requests.delete(t.id);

              if (!controller.signal.aborted) {
                await send({
                  id: t.id,
                  type: "result",
                  payload: rt,
                });
              }

              return;
            }
            case "s": {
              let v: any;
              if (typeof route.validator === "function") {
                v = route.validator(t.input);
              } else {
                v = route.validator.parse(t.input);
              }
              let rt = await route.method(c, v);

              activeSubs.set(t.id, { paused: false, resume: [] });
              await send({ id: t.id, type: "subscription.start" });

              try {
                while (1) {
                  let sub = activeSubs.get(t.id);
                  if (closed) {
                    throw new NRPCConnClosed();
                  }
                  if (!sub) {
                    rt.return(undefined);
                    break;
                  }

                  if (sub.paused) {
                    await new Promise<void>((res, rej) =>
                      sub.resume.push({ res, rej }),
                    );
                  }

                  let item = await rt.next();
                  if (item.done) {
                    break;
                  }
                  let payload = item.value;
                  await send({ id: t.id, type: "subscription.data", payload });
                }

                await send({ id: t.id, type: "subscription.end" });
              } catch (error) {
                if (error instanceof NRPCConnClosed) {
                } else if (error instanceof NRPCSubEnded) {
                } else {
                  await send({ id: t.id, type: "subscription.error", error });
                }
              } finally {
                rt.return(undefined);
                activeSubs.delete(t.id);
              }

              return;
            }
            case "e": {
              eventConn.subscriptions.set(t.id, t.path);
              await send({ id: t.id, type: "event.start" });
              return;
            }
          }

          throw new Error(`Path "${t.path.join(".")}" incomplete.`);
        } else if (t.type == "subscription.end") {
          let sub = activeSubs.get(t.id);
          activeSubs.delete(t.id);
          if (sub) {
            sub.resume.forEach((a) =>
              a.rej(new NRPCSubEnded("NRPC Sub Ended")),
            );
          }
          eventConn.subscriptions.delete(t.id);
        } else if (t.type == "subscription.error") {
          let sub = activeSubs.get(t.id);
          activeSubs.delete(t.id);
          if (sub) {
            sub.resume.forEach((a) => a.rej(t.error));
          }
        } else if (t.type == "subscription.pause") {
          let sub = activeSubs.get(t.id);
          if (sub) {
            sub.paused = true;
          }
        } else if (t.type == "subscription.resume") {
          let sub = activeSubs.get(t.id);
          if (sub) {
            let cbs = sub.resume;
            sub.resume = [];
            sub.paused = false;
            cbs.forEach((a) => a.res());
          }
        } else if (t.type == "request.cancel") {
          let controller = requests.get(t.id);
          if (controller) {
            requests.delete(t.id);
            controller.abort(t.message);
          }
        }
      } catch (error) {
        try {
          await send({
            id: t.id,
            type: "error",
            error,
          });
        } catch (error) {
          if (error instanceof NRPCConnClosed) {
          } else {
            throw error;
          }
        }
      }
    };

    const onClose = () => {
      if (closed) return;
      closed = true;
      this.#connections.delete(eventConn);

      let arr = toDrain;
      toDrain = [];
      arr.forEach((a) => a.rej(new NRPCConnClosed()));

      for (let [id, { paused, resume }] of activeSubs) {
        resume.forEach((a) => a.rej(new NRPCConnClosed()));
      }

      activeSubs.clear();
    };

    const drain = () => {
      paused = false;

      if (toDrain.length) {
        let item = toDrain.shift()!;
        item.res();
      }
    };

    let rt = { onMsg, onClose, drain, paused: () => paused };
    this.#reg.register(rt, eventConn);
    return rt;
  }
}
