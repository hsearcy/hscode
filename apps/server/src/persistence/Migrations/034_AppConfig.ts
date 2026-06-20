import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Key-value store for user-configurable app settings that must be readable
// outside the browser (the web UI persists localStorage settings, but the
// separate hscode-mcp process and the server need a shared, durable home for
// values like the projects root used by repo provisioning).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
