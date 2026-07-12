import {
  WsPush,
  type WsPushChannel,
  type WsPushData,
  type WsPushEnvelopeBase,
} from "@t3tools/contracts";
import { Data, Deferred, Effect, Queue, Ref, Schema } from "effect";
import type { Scope } from "effect";
import type { WebSocket } from "ws";

type PushTarget =
  | { readonly kind: "all" }
  | { readonly kind: "client"; readonly client: WebSocket };

/**
 * Bound on queued-but-unsent pushes. The send loop drains fast (encode +
 * ws.send), so this only fills if the loop is wedged — dropping is better
 * than growing the heap without bound. Sized far above any realistic burst.
 */
const DEFAULT_PUSH_QUEUE_CAPACITY = 10_000;
/**
 * A client whose ws buffer exceeds this stopped reading long ago (frozen tab,
 * dead network). ws buffers sends in server memory without limit, so under a
 * provider event firehose one stalled browser can OOM the server. Terminating
 * forces a clean reconnect + state resync instead of silent divergence.
 */
const MAX_CLIENT_BUFFERED_BYTES = 8 * 1024 * 1024;

interface PushJob<C extends WsPushChannel = WsPushChannel> {
  readonly channel: C;
  readonly data: WsPushData<C>;
  readonly target: PushTarget;
  readonly delivered: Deferred.Deferred<boolean> | null;
}

class WsPushEncodeError extends Data.TaggedError("WsPushEncodeError")<{
  readonly cause: unknown;
}> {}

export interface ServerPushBus {
  readonly publishAll: <C extends WsPushChannel>(
    channel: C,
    data: WsPushData<C>,
  ) => Effect.Effect<void>;
  readonly publishClient: <C extends WsPushChannel>(
    client: WebSocket,
    channel: C,
    data: WsPushData<C>,
  ) => Effect.Effect<boolean>;
}

export const makeServerPushBus = (input: {
  readonly clients: Ref.Ref<Set<WebSocket>>;
  readonly logOutgoingPush: (push: WsPushEnvelopeBase, recipients: number) => void;
  readonly queueCapacity?: number;
}): Effect.Effect<ServerPushBus, never, Scope.Scope> =>
  Effect.gen(function* () {
    const nextSequence = yield* Ref.make(0);
    const queue = yield* Queue.dropping<PushJob>(
      input.queueCapacity ?? DEFAULT_PUSH_QUEUE_CAPACITY,
    );
    const encodePush = Schema.encodeUnknownSync(Schema.fromJsonString(WsPush));

    const settleDelivery = (job: PushJob, delivered: boolean) =>
      job.delivered === null
        ? Effect.void
        : Deferred.succeed(job.delivered, delivered).pipe(Effect.orDie);

    const send = Effect.fnUntraced(function* (job: PushJob) {
      const sequence = yield* Ref.updateAndGet(nextSequence, (current) => current + 1);
      const push: WsPushEnvelopeBase = {
        type: "push",
        sequence,
        channel: job.channel,
        data: job.data,
      };
      const recipients =
        job.target.kind === "all" ? yield* Ref.get(input.clients) : new Set([job.target.client]);
      const message = yield* Effect.try({
        try: () => encodePush(push),
        catch: (cause) => new WsPushEncodeError({ cause }),
      });

      let recipientCount = 0;
      for (const client of recipients) {
        if (client.readyState !== client.OPEN) {
          continue;
        }
        if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
          yield* Effect.logWarning("ws push: terminating backlogged client").pipe(
            Effect.annotateLogs({ bufferedAmount: client.bufferedAmount, channel: job.channel }),
          );
          client.terminate();
          continue;
        }
        client.send(message);
        recipientCount += 1;
      }

      input.logOutgoingPush(push, recipientCount);
      return recipientCount > 0;
    });

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((job) =>
            send(job).pipe(
              Effect.tap((delivered) => settleDelivery(job, delivered)),
              Effect.tapCause(() => settleDelivery(job, false)),
              Effect.ignoreCause({ log: true }),
            ),
          ),
        ),
      ),
    );

    const logDropped = (channel: WsPushChannel) =>
      Effect.logWarning("ws push dropped: queue full").pipe(Effect.annotateLogs({ channel }));

    const publish =
      (target: PushTarget) =>
      <C extends WsPushChannel>(channel: C, data: WsPushData<C>) =>
        Queue.offer(queue, {
          channel,
          data,
          target,
          delivered: null,
        }).pipe(
          Effect.flatMap((accepted) => (accepted ? Effect.void : logDropped(channel))),
          Effect.asVoid,
        );

    return {
      publishAll: publish({ kind: "all" }),
      publishClient: (client, channel, data) =>
        Effect.gen(function* () {
          const delivered = yield* Deferred.make<boolean>();
          const accepted = yield* Queue.offer(queue, {
            channel,
            data,
            target: { kind: "client", client },
            delivered,
          });
          if (!accepted) {
            yield* logDropped(channel);
            return false;
          }
          return yield* Deferred.await(delivered);
        }),
    } satisfies ServerPushBus;
  });
