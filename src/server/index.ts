import { NRPCConnClosed, NRPCPromise, NRPCSubEnded } from "../shared/index.ts";
import type {
  Routes,
  Router,
  RouterToProxy,
  NRPCRequest,
  NRPCResponse,
  Route,
} from "../shared/types.ts";

type Call = {
  res: (val: any) => void;
  rej: (err: any) => void;
  path: string[];
  args: any[];
};

export class NRPCServer<CIn, COut, Rts extends Routes<COut>> {
  router: Router<CIn, COut, Rts>;
  constructor(router: Router<CIn, COut, Rts>) {
    this.router = router;
  }

  async getRoute(ctx: CIn, path: string[]) {
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

  async call(signal: AbortSignal, ctx: CIn, path: string[], arg?: any) {
    let { route, c } = await this.getRoute(ctx, path);

    switch (route._tag) {
      case "q": {
        let v: any;
        if (typeof route.validator === "function") {
          v = route.validator(arg);
        } else {
          v = route.validator.parse(arg);
        }
        return route.method(c, v, signal);
      }
      case "s": {
        let v: any;
        if (typeof route.validator === "function") {
          v = route.validator(arg);
        } else {
          v = route.validator.parse(arg);
        }
        return route.method(c, v);
      }
    }

    throw new Error(`Path "${path.join(".")}" incomplete.`);
  }

  getLocalCaller(ctx: CIn) {
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
                let rt = await this.call(controller.signal, ctx, path, args[0]);
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
    return getProxy([]) as any as RouterToProxy<typeof this.router>;
  }

  getConnection(
    ctx: CIn,
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
        let item = toDrain.shift();
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
        let item = toDrain.shift();
        item.res();
      }
    };

    return { onMsg, onClose, drain, paused: () => paused };
  }
}
