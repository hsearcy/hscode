import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { AppConfigRepositoryLive } from "./AppConfig.ts";
import { AppConfigRepository } from "../Services/AppConfig.ts";

const appConfigLayer = it.layer(
  AppConfigRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

appConfigLayer("AppConfigRepository", (it) => {
  it.effect("lists only entries under the prefix, treating LIKE wildcards literally", () =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigRepository;
      const updatedAt = "2026-10-22T00:00:00.000Z";
      yield* appConfig.set({ key: "clientState:a", value: "1", updatedAt });
      yield* appConfig.set({ key: "clientState:b", value: "2", updatedAt });
      yield* appConfig.set({ key: "clientStateXc", value: "3", updatedAt });
      yield* appConfig.set({ key: "projectsRoot", value: "/tmp", updatedAt });
      yield* appConfig.set({ key: "a%_b", value: "4", updatedAt });
      yield* appConfig.set({ key: "aXYb", value: "5", updatedAt });

      const rows = yield* appConfig.listByPrefix("clientState:");
      assert.deepStrictEqual(rows.map((row) => [row.key, row.value]).toSorted(), [
        ["clientState:a", "1"],
        ["clientState:b", "2"],
      ]);

      const wildcardRows = yield* appConfig.listByPrefix("a%_");
      assert.deepStrictEqual(
        wildcardRows.map((row) => row.key),
        ["a%_b"],
      );
    }),
  );
});
