import fs from "node:fs";

import { RotatingFileSink } from "@t3tools/shared/logging";
import { Effect, Logger } from "effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config";

const SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024;
const SERVER_LOG_MAX_FILES = 10;

export const ServerLoggerLive = Effect.gen(function* () {
  const { logsDir, serverLogPath } = yield* ServerConfig;

  yield* Effect.sync(() => {
    fs.mkdirSync(logsDir, { recursive: true });
  });

  const sink = new RotatingFileSink({
    filePath: serverLogPath,
    maxBytes: SERVER_LOG_MAX_BYTES,
    maxFiles: SERVER_LOG_MAX_FILES,
  });

  const fileLogger = Logger.map(Logger.formatSimple, (formatted) => {
    sink.write(`${formatted}\n`);
  });

  return Logger.layer([Logger.defaultLogger, fileLogger], {
    mergeWithExisting: false,
  });
}).pipe(Layer.unwrap);
