import { NRPCServer } from "../src/server/index.ts";

let server;

process.send({ type: "ready" });

process.on("message", async (msg) => {
  if (msg.type === "router") {
    server = new NRPCServer(msg.router);

    const connection = server.getConnection(
      { kind: "child" },
      (response) => {
        process.send(response);
      },
      () => {}
    );

    // Set up message handler for subsequent requests
    process.on("message", (request) => {
      if (request.type !== "router") {
        connection.onMsg(request);
      }
    });
  } else if (server) {
    const connection = server.getConnection(
      { kind: "child" },
      (response) => {
        process.send(response);
      },
      () => {}
    );

    connection.onMsg(msg);
  }
});
