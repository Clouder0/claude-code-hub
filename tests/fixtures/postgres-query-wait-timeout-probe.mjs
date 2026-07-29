import net from "node:net";
import postgres from "postgres";

function message(type, payload) {
  const body = Buffer.from(payload);
  const output = Buffer.alloc(1 + 4 + body.length);
  output.write(type, 0);
  output.writeInt32BE(4 + body.length, 1);
  body.copy(output, 5);
  return output;
}

function int32(value) {
  const output = Buffer.alloc(4);
  output.writeInt32BE(value);
  return output;
}

const authenticationOk = message("R", int32(0));
const backendKeyData = message("K", Buffer.concat([int32(1234), int32(5678)]));
const ready = message("Z", Buffer.from("I"));
const queryWaitTimeout = message(
  "E",
  Buffer.from("SFATAL\0VFATAL\0C57014\0Mquery_wait_timeout\0Fclient.c\0L1\0Rquery_wait_timeout\0\0")
);

const server = net.createServer((socket) => {
  let startupComplete = false;
  let failureSent = false;
  socket.on("data", () => {
    if (!startupComplete) {
      startupComplete = true;
      socket.write(Buffer.concat([authenticationOk, backendKeyData, ready]));
      return;
    }
    if (failureSent) return;
    failureSent = true;
    socket.end(queryWaitTimeout);
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("probe server did not expose a TCP address");
}

const unhandled = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

const fetchTypes = process.env.PROBE_FETCH_TYPES !== "false";
const sql = postgres(`postgres://probe:probe@127.0.0.1:${address.port}/probe`, {
  max: 1,
  connect_timeout: 2,
  idle_timeout: 1,
  fetch_types: fetchTypes,
});

let caught;
try {
  await sql`select 1`;
} catch (error) {
  caught = error;
}

await new Promise((resolve) => setTimeout(resolve, 100));
const unhandledBeforeEnd = unhandled.length;
await sql.end({ timeout: 0 });
await new Promise((resolve) => server.close(resolve));

process.stdout.write(
  `${JSON.stringify({
    fetchTypes,
    caughtName: caught?.name,
    caughtMessage: caught?.message,
    caughtCode: caught?.code,
    unhandledBeforeEnd,
    unhandled: unhandled.map((error) => ({
      name: error?.name,
      message: error?.message,
      code: error?.code,
    })),
  })}\n`
);
