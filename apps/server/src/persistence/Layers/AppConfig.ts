import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AppConfigEntry,
  AppConfigRepository,
  type AppConfigRepositoryShape,
} from "../Services/AppConfig.ts";

const AppConfigValueRow = Schema.Struct({ value: Schema.String });
const GetAppConfigInput = Schema.Struct({ key: Schema.String });
const DeleteAppConfigInput = Schema.Struct({ key: Schema.String });

const makeAppConfigRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getAppConfigRow = SqlSchema.findOneOption({
    Request: GetAppConfigInput,
    Result: AppConfigValueRow,
    execute: ({ key }) =>
      sql`
        SELECT value
        FROM app_config
        WHERE key = ${key}
      `,
  });

  const upsertAppConfigRow = SqlSchema.void({
    Request: AppConfigEntry,
    execute: (entry) =>
      sql`
        INSERT INTO app_config (key, value, updated_at)
        VALUES (${entry.key}, ${entry.value}, ${entry.updatedAt})
        ON CONFLICT (key)
        DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
  });

  const deleteAppConfigRow = SqlSchema.void({
    Request: DeleteAppConfigInput,
    execute: ({ key }) =>
      sql`
        DELETE FROM app_config
        WHERE key = ${key}
      `,
  });

  const get: AppConfigRepositoryShape["get"] = (key) =>
    getAppConfigRow({ key }).pipe(
      Effect.map(Option.map((row) => row.value)),
      Effect.mapError(toPersistenceSqlError("AppConfigRepository.get:query")),
    );

  const set: AppConfigRepositoryShape["set"] = (entry) =>
    upsertAppConfigRow(entry).pipe(
      Effect.mapError(toPersistenceSqlError("AppConfigRepository.set:query")),
    );

  const deleteKey: AppConfigRepositoryShape["delete"] = (key) =>
    deleteAppConfigRow({ key }).pipe(
      Effect.mapError(toPersistenceSqlError("AppConfigRepository.delete:query")),
    );

  return {
    get,
    set,
    delete: deleteKey,
  } satisfies AppConfigRepositoryShape;
});

export const AppConfigRepositoryLive = Layer.effect(AppConfigRepository, makeAppConfigRepository);
