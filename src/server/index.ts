import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionGateway } from "./gateway.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";
const dbPath = process.env.DB_PATH ?? resolve(projectRoot, "poker-platform.db");
const staticDir = resolve(projectRoot, "dist/client");

const gateway = createSessionGateway({
  dbPath,
  staticDir,
});

const url = await gateway.listen(port, host);
console.log(`Poker Table Companion listening at ${url} (SQLite: ${dbPath})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void gateway.close().then(() => process.exit(0));
  });
}
