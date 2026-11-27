import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createApp({ config });

try {
  const address = await app.listen({
    // Вне production по умолчанию только локально: заглушка YourSpace пускает тестовым админом.
    host: process.env.HOST ?? (config.profile === "production" ? "0.0.0.0" : "127.0.0.1"),
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
  });
  app.log.info(
    { profile: config.profile, yourspace: config.yourspace.mode, testData: config.seedTestData },
    `YourTask is listening on ${address}`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
