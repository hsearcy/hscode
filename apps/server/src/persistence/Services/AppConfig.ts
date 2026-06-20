/**
 * AppConfigRepository - durable key-value store for app settings that must be
 * shared across processes.
 *
 * Most user settings live in the browser's localStorage, but a few values need
 * to be readable by the server and the separate hscode-mcp process too (e.g.
 * the projects root used by repo provisioning). Those are persisted here, in
 * the `app_config` table of state.sqlite.
 *
 * @module AppConfigRepository
 */
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const AppConfigEntry = Schema.Struct({
  key: TrimmedNonEmptyString,
  value: Schema.String,
  updatedAt: IsoDateTime,
});
export type AppConfigEntry = typeof AppConfigEntry.Type;

/**
 * AppConfigRepositoryShape - get/set/delete for app config keys.
 */
export interface AppConfigRepositoryShape {
  /** Read a config value by key. None when the key is unset. */
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, ProjectionRepositoryError>;

  /** Insert or replace a config value. */
  readonly set: (entry: AppConfigEntry) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Remove a config key (no-op when absent). */
  readonly delete: (key: string) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * AppConfigRepository - service tag for shared app config persistence.
 */
export class AppConfigRepository extends ServiceMap.Service<
  AppConfigRepository,
  AppConfigRepositoryShape
>()("t3/persistence/Services/AppConfig/AppConfigRepository") {}
