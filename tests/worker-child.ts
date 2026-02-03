import { parentPort } from "worker_threads";
import { NRPCServer } from "../src/server/index.ts";
import { simpleRouter } from "./fixtures.ts";

if (parentPort) {
  const pp = parentPort;

  const server = new NRPCServer(simpleRouter);

  const connection = server.getConnection(
    { kind: "worker" },
    (response) => {
      pp.postMessage(response);
    },
    () => {},
  );

  pp.on("message", (msg) => {
    connection.onMsg(msg);
  });

  pp.postMessage({ type: "ready" });
}
