import type { MonitorStoragePressure } from "../types/snapshots.js";

export interface FilesystemStorageProjection {
  pressure: MonitorStoragePressure;
  usedPercent: number | null;
}

export function projectFilesystemStorage(
  availableBytes: bigint,
  totalBytes: bigint,
): FilesystemStorageProjection {
  if (
    totalBytes <= 0n ||
    availableBytes < 0n ||
    availableBytes > totalBytes
  ) {
    return { pressure: "unknown", usedPercent: null };
  }

  const usedPercent =
    Number(((totalBytes - availableBytes) * 10_000n) / totalBytes) / 100;
  const pressure =
    availableBytes * 100n <= totalBytes * 5n
      ? "critical"
      : availableBytes * 100n <= totalBytes * 15n
        ? "elevated"
        : "normal";

  return { pressure, usedPercent };
}
