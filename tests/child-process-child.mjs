import { NRPCServer } from "../src/server/index.ts";
import { simpleRouter } from "./fixtures.ts";

const server = new NRPCServer(simpleRouter);

const connection = server.getConnection(
  { kind: "child" },
  (response) => {
    process.send(response);
  },
  () => {}
);

process.send({ type: "ready" });

process.on("message", (msg) => {
  connection.onMsg(msg);
});
