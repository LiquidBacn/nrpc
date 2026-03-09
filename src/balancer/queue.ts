export class QueueClear extends Error {}

export class Queue<T> {
  private data: T[] = [];
  private cbs: {
    res: (val: T) => void;
    rej: (err: any) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }[] = [];

  constructor() {}

  write(val: T) {
    this.data.push(val);
    this.dequeue();
  }

  tryRead(): T | undefined {
    if (this.data.length) {
      return this.data.shift();
    }
  }

  read(signal?: AbortSignal): Promise<T> {
    return new Promise<T>((res, rej) => {
      const item = { res, rej, signal } as (typeof this.cbs)[number];

      if (signal?.aborted) {
        rej(signal.reason ?? new Error("Queue read aborted."));
        return;
      }

      if (signal) {
        item.onAbort = () => {
          this.cbs = this.cbs.filter((cb) => cb !== item);
          rej(signal.reason ?? new Error("Queue read aborted."));
        };
        signal.addEventListener("abort", item.onAbort, { once: true });
      }

      this.cbs.push(item);
      this.dequeue();
    });
  }

  clear() {
    let old = this.cbs;
    this.cbs = [];
    this.data = [];

    for (let { rej, signal, onAbort } of old) {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      rej(new QueueClear("Queue Cleared"));
    }
  }

  size(): number {
    return this.data.length + this.cbs.length;
  }

  private dequeue() {
    if (this.data.length && this.cbs.length) {
      let val = this.data.shift()!;
      let cb = this.cbs.shift()!;
      if (cb.signal && cb.onAbort) {
        cb.signal.removeEventListener("abort", cb.onAbort);
      }

      cb.res(val);
    }
  }

  async *[Symbol.asyncIterator]() {
    try {
      while (1) {
        yield await this.read();
      }
    } catch (e) {
      if (!(e instanceof QueueClear)) {
        throw e;
      }
    }
  }
}
