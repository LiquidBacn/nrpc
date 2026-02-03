import type {
  NRPCRequest,
  NRPCResponse,
  Router,
  RouterToProxy,
} from "../shared/types.ts";

type Call = { res: (val: any) => void; rej: (err?: any) => void };
type Sub = { data: any[]; calls: Call[] };

export function getClient<R extends Router>(
  send: (msg: NRPCRequest) => void,
  close: () => void,
) {
  let nextId = 0;

  let inFlight = new Map<string, Call>();
  let subs = new Map<string, Sub>();

  const deQueueSub = (id: string) => {
    let sub = subs.get(id);
    if (sub) {
      if (sub.calls.length && sub.data.length) {
        let data = sub.data.shift();
        let call = sub.calls.shift();

        call?.res({ value: data, done: false });
      }
    }
  };

  const onMsg = (msg: any) => {
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
        }
        break;
      }
      case "subscription.start":
        let gen: AsyncGenerator = {
          next: () => {
            return new Promise((res, rej) => {
              let sub = subs.get(t.id);
              if (sub) {
                sub.calls.push({ res, rej });
                subs.set(t.id, sub);
                deQueueSub(t.id);
              } else {
                res({ value: undefined, done: true });
              }
            });
          },
          return: async () => {
            send({
              id: t.id,
              type: "subscription.end",
            });
            return { value: undefined, done: true };
          },
          throw: async (error) => {
            send({
              id: t.id,
              type: "subscription.error",
              error,
            });
            return { value: undefined, done: true };
          },
          [Symbol.asyncDispose]: async () => {
            send({
              id: t.id,
              type: "subscription.end",
            });
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };

        subs.set(t.id, { calls: [], data: [] });

        let call = inFlight.get(t.id);
        if (call) {
          inFlight.delete(t.id);
          call.res(gen);
        }
        break;
      case "subscription.data": {
        let sub = subs.get(t.id);
        if (sub) {
          sub.data.push(t.payload);
          subs.set(t.id, sub);
          deQueueSub(t.id);
        }
        break;
      }
      case "subscription.end": {
        let sub = subs.get(t.id);
        if (sub) {
          subs.delete(t.id);
          sub.calls.forEach((a) => a.res({ value: undefined, done: true }));
        }
        break;
      }
      case "subscription.error": {
        let sub = subs.get(t.id);
        if (sub) {
          subs.delete(t.id);
          sub.calls.forEach((a) => a.rej(t.error));
        }
        break;
      }
    }
  };
  const onClose = () => {};

  const getProxy = (path: string[]) => {
    return new Proxy(() => {}, {
      get(_, p) {
        if (p === "then") {
          return undefined;
        } else if (typeof p === "string") {
          return getProxy([...path, p]);
        }
      },
      apply: (a, b, args) => {
        let id = `nrpc_${nextId++}`;
        return new Promise((res, rej) => {
          inFlight.set(id, { res, rej });

          send({
            id,
            type: "request",
            path,
            input: args[0],
          });
        });
      },
    });
  };

  let proxy = getProxy([]) as any as RouterToProxy<R>;

  return { onMsg, onClose, proxy };
}
