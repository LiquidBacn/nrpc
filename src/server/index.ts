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

  async call(ctx: CIn, path: string[], arg?: any) {
    let { route, c } = await this.getRoute(ctx, path);

    switch (route._tag) {
      case "q": {
        let v: any;
        if (typeof route.validator === "function") {
          v = route.validator(arg);
        } else {
          v = route.validator.parse(arg);
        }
        return route.method(c, v);
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
          return new Promise(async (res, rej) => {
            try {
              let rt = await this.call(ctx, path, args[0]);
              res(rt);
            } catch (e) {
              rej(e);
            }
          });
        },
      });
    };
    return getProxy([]) as any as RouterToProxy<typeof this.router>;
  }

  getConnection(
    ctx: CIn,
    send: (msg: NRPCResponse) => void,
    close: () => void,
  ) {
    const activeSubs = new Map<
      string,
      { paused: boolean; cbs: (() => void)[] }
    >();

    const onMsg = async (msg: any) => {
      if (msg === null || typeof msg !== "object") {
        return;
      }

      let t = msg as NRPCRequest;
      try {
        if (t.type == "request") {
          let { route, c } = await this.getRoute(ctx, t.path);

          switch (route._tag) {
            case "q": {
              let v;
              if (typeof route.validator === "function") {
                v = route.validator(t.input);
              } else {
                v = route.validator.parse(t.input);
              }

              let rt = await route.method(c, v);

              send({
                id: t.id,
                type: "result",
                payload: rt,
              });

              return;
            }
            case "s": {
              let v;
              if (typeof route.validator === "function") {
                v = route.validator(t.input);
              } else {
                v = route.validator.parse(t.input);
              }
              let rt = await route.method(c, v);

              activeSubs.set(t.id, { paused: false, cbs: [] });
              send({ id: t.id, type: "subscription.start" });

              try {
                while (1) {
                  let sub = activeSubs.get(t.id);
                  if (!sub) {
                    rt.return(undefined);
                    break;
                  }
                  let item = await rt.next(
                    sub.paused
                      ? new Promise<void>((res) => {
                          sub.cbs.push(res);
                        })
                      : undefined,
                  );
                  if (item.done) {
                    break;
                  }
                  let payload = item.value;
                  send({ id: t.id, type: "subscription.data", payload });
                }

                send({ id: t.id, type: "subscription.end" });
              } catch (error) {
                send({ id: t.id, type: "subscription.error", error });
              } finally {
                activeSubs.delete(t.id);
              }

              return;
            }
          }

          throw new Error(`Path "${t.path.join(".")}" incomplete.`);
        } else if (t.type == "subscription.end") {
        } else if (t.type == "subscription.error") {
        } else if (t.type == "subscription.pause") {
          let sub = activeSubs.get(t.id);
          if (sub) {
            sub.paused = true;
          }
        } else if (t.type == "subscription.resume") {
          let sub = activeSubs.get(t.id);
          if (sub) {
            let cbs = sub.cbs;
            sub.cbs = [];
            sub.paused = false;
            cbs.forEach((a) => a());
          }
        }
      } catch (error) {
        send({
          id: t.id,
          type: "error",
          error,
        });
      }
    };
    const onClose = () => {};

    return { onMsg, onClose };
  }
}
