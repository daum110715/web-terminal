// systemd's journal adds timestamps; lines only carry a scope.
export function logger(scope: string) {
  return {
    info: (...args: unknown[]) => console.log(`[${scope}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${scope}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${scope}]`, ...args),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
