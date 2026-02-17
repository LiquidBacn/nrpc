import { NRPCConnClosed, NRPCPromise } from "../shared/index.ts";
import type {
  EventSub,
  NRPCRequest,
  NRPCResponse,
  Router,
  RouterToProxy,
} from "../shared/types.ts";

type Call = { res: (val: any) => void; rej: (err?: any) => void; back: number };
type Sub = {
  data: ({ k: "v"; val: any } | { k: "e"; err: any })[];
  calls: Call[];
  done: boolean;
  paused: boolean;
  back: number;
  resume: number;
  gen: AsyncGenerator;
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
  let eventSubs = new Map<string, EventSub>();
  let toDrain: { res: () => void; rej: (error: any) => void }[] = [];

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

  const deQueueSub = async (id: string) => {
    let sub = subs.get(id);
    if (sub) {
      if (sub.calls.length && sub.data.length) {
        let data = sub.data.shift()!;
        let call = sub.calls.shift()!;

        if (data.k === "v") {
          call?.res({ value: data.val, done: false });
        } else if (data.k === "e") {
          call.rej(data.err);
        }

        if (sub.data.length < sub.resume && sub.paused) {
          sub.paused = false;

          await send({ id, type: "subscription.resume" });
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
        }
        break;
      }
      case "subscription.start":
        let gen: AsyncGenerator = {
          next: () => {
            return new Promise((res, rej) => {
              let sub = subs.get(t.id);
              if (sub) {
                sub.calls.push({ res, rej, back: 0 });
                subs.set(t.id, sub);
                deQueueSub(t.id);
              } else {
                res({ value: undefined, done: true });
              }
            });
          },
          return: async (value) => {
            await send({
              id: t.id,
              type: "subscription.end",
            });
            subs.delete(t.id);
            return { value, done: true };
          },
          throw: async (error) => {
            await send({
              id: t.id,
              type: "subscription.error",
              error,
            });
            subs.delete(t.id);
            return { value: undefined, done: true };
          },
          [Symbol.asyncDispose]: async () => {
            await send({
              id: t.id,
              type: "subscription.end",
            });
            subs.delete(t.id);
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };

        let call = inFlight.get(t.id);
        if (call) {
          let resume = Math.max(1, Math.ceil(call.back / 2));
          subs.set(t.id, {
            calls: [],
            data: [],
            done: false,
            paused: false,
            back: call.back,
            resume,
            gen,
          });
          inFlight.delete(t.id);
          call.res(gen);
        }
        break;
      case "subscription.data": {
        let sub = subs.get(t.id);
        if (sub) {
          sub.data.push({ k: "v", val: t.payload });
          deQueueSub(t.id);

          if (sub.data.length > sub.back && !sub.paused) {
            sub.paused = true;

            await send({ id: t.id, type: "subscription.pause" });
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
      case "event.start": {
        let call = inFlight.get(t.id);
        if (call) {
          inFlight.delete(t.id);
          const callbacks = new Set<(value: any) => void>();
          const close = () => {
            eventSubs.delete(t.id);
            send({ id: t.id, type: "event.end" });
          };
          eventSubs.set(t.id, { callbacks });
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
    }
  };
  const onClose = () => {
    if (closed) return;
    closed = true;
    for (let [id, call] of inFlight) {
      call.rej(new NRPCConnClosed());
    }
    inFlight.clear();

    let arr = toDrain;
    toDrain = [];
    arr.forEach((a) => a.rej(new NRPCConnClosed()));

    for (let [id, sub] of subs) {
      sub.done = true;
      deQueueSub(id);
    }

    eventSubs.clear();
  };

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
        if (closed) {
          return Promise.reject(new NRPCConnClosed());
        }

        let back = 10;
        if (typeof args[1] === "number" && args[1] > 0) {
          back = args[1];
        }
        let id = `nrpc_${nextId++}`;
        return new NRPCPromise(
          async (res, rej) => {
            inFlight.set(id, { res, rej, back });

            await send({
              id,
              type: "request",
              path,
              input: args[0],
            });
          },
          (message) => {
            inFlight.delete(id);
            send({
              id,
              type: "request.cancel",
              message,
            });
          },
        );
      },
    });
  };

  const proxy = getProxy([]) as any as RouterToProxy<R>;

  const drain = () => {
    paused = false;

    if (toDrain.length) {
      let item = toDrain.shift()!;
      item.res();
    }
  };

  return { onMsg, onClose, proxy, drain, paused: () => paused };
}
