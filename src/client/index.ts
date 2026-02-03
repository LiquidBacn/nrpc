import type {
  NRPCRequest,
  NRPCResponse,
  Router,
  RouterToProxy,
} from "../shared/types.ts";

type Call = { res: (val: any) => void; rej: (err?: any) => void };
type Sub = {
  data: ({ k: "v"; val: any } | { k: "e"; err: any })[];
  calls: Call[];
  done: boolean;
  paused: boolean;
};

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

        if (data.k === "v") {
          call?.res({ value: data.val, done: false });
        } else if (data.k === "e") {
          call.rej(data.err);
        }

        if (sub.data.length < 5 && sub.paused) {
          sub.paused = false;

          send({ id, type: "subscription.resume" });
        }
      } else if (sub.done && sub.calls.length && !sub.data.length) {
        sub.calls.forEach((a) => a.res({ value: undefined, done: true }));
        subs.delete(id);
      }
    }
  };

  const onMsg = (msg: any) => {
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
            subs.delete(t.id);
            return { value: undefined, done: true };
          },
          throw: async (error) => {
            send({
              id: t.id,
              type: "subscription.error",
              error,
            });
            subs.delete(t.id);
            return { value: undefined, done: true };
          },
          // [Symbol.asyncDispose]: async () => {
          //   send({
          //     id: t.id,
          //     type: "subscription.end",
          //   });
          // },
          [Symbol.asyncIterator]() {
            return this;
          },
        };

        subs.set(t.id, { calls: [], data: [], done: false, paused: false });

        let call = inFlight.get(t.id);
        if (call) {
          inFlight.delete(t.id);
          call.res(gen);
        }
        break;
      case "subscription.data": {
        let sub = subs.get(t.id);
        if (sub) {
          sub.data.push({ k: "v", val: t.payload });
          deQueueSub(t.id);

          if (sub.data.length > 10 && !sub.paused) {
            sub.paused = true;

            send({ id: t.id, type: "subscription.pause" });
          }
        }
        break;
      }
      case "subscription.end": {
        let sub = subs.get(t.id);
        if (sub) {
          sub.done = true;
          deQueueSub(t.id);
        }
        break;
      }
      case "subscription.error": {
        let sub = subs.get(t.id);
        if (sub) {
          sub.data.push({ k: "e", err: t.error });
          deQueueSub(t.id);
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
