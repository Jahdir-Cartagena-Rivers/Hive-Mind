import { startHiveMind } from "./service.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Hive Mind: npm start -- --state-dir <absolute-directory> [--port 8788]\nSet HIVE_MIND_TOKEN (32+ random characters). Optional HIVE_MIND_READ_TOKEN grants read-only access.",
  );
} else {
  try {
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
      if (
        !["--state-dir", "--port"].includes(args[index]) ||
        args[index + 1] === undefined ||
        values.has(args[index])
      )
        throw new Error("Use --help for supported arguments.");
      values.set(args[index], args[index + 1]);
    }
    const service = await startHiveMind({
      stateDirectory: values.get("--state-dir"),
      port: values.has("--port") ? Number(values.get("--port")) : 8788,
      token: process.env.HIVE_MIND_TOKEN,
      readToken: process.env.HIVE_MIND_READ_TOKEN,
    });
    console.log(
      JSON.stringify({
        product: "Hive Mind",
        origin: service.origin,
        stateDirectory: service.stateDirectory,
      }),
    );
    const shutdown = () => {
      void service.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
