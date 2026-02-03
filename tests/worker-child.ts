import { parentPort } from "worker_threads";
import { NRPCServer } from "../src/server/index.ts";
import { getClient } from "../src/client/index.ts";

let server: NRPCServer<any, any, any>;

if (parentPort) {
  const pp = parentPort;
  pp.postMessage({ type: "ready" });

  pp.on("message", async (msg) => {
    if (msg.type === "router") {
      server = new NRPCServer(msg.router);

      const connection = server.getConnection(
        { kind: "worker" },
        (response) => {
          pp.postMessage(response);
        },
        () => {}
      );

      // Override the message handler to accept requests from parent
      const originalOnMsg = connection.onMsg;
      pp.on("message", (request) => {
        if (request.type !== "router") {
          originalOnMsg(request);
        }
      });
    } else if (server) {
      const connection = server.getConnection(
        { kind: "worker" },
        (response) => {
          pp.postMessage(response);
        },
        () => {}
      );

      connection.onMsg(msg);
    }
  });
}
