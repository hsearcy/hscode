import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@t3tools/contracts";
import { memo, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "~/lib/icons";

function fingerprint(status: ServerProviderStatus): string {
  return `${status.provider}|${status.status}|${status.message ?? ""}`;
}

export const ProviderHealthBanner = memo(function ProviderHealthBanner({
  status,
}: {
  status: ServerProviderStatus | null;
}) {
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);

  if (!status || status.status === "ready") {
    return null;
  }

  const currentFingerprint = fingerprint(status);
  if (dismissedFingerprint === currentFingerprint) {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;
  const isError = status.status === "error";

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={isError ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss provider status"
            className={
              isError
                ? "inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
                : "inline-flex size-6 items-center justify-center rounded-md text-warning/60 transition-colors hover:text-warning"
            }
            onClick={() => setDismissedFingerprint(currentFingerprint)}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
    </div>
  );
});
