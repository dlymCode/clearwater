/** Statuses worth retrying later (timeouts, throttling, server errors). Everything else 4xx is permanent. */
export function retryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}
