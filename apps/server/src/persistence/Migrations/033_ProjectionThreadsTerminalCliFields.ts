import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN cli_kind TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN cli_session_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN cli_launched_once INTEGER NOT NULL DEFAULT 0
  `;
});
