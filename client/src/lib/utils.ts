import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function displayUserId(id: string): string {
  return id.split(":")[0]?.replace("@", "") || id;
}

/**
 * A byte count as something a person reads.
 *
 * One definition rather than the three that had grown up separately — the
 * staged-attachment row, the admin dashboard, and now the composer's list of
 * interrupted uploads — which disagreed about whether 2 MB is "2 MB" or
 * "2.0 MB" and about whether bytes have a unit of their own.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const tier = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${parseFloat((bytes / 1024 ** tier).toFixed(1))} ${units[tier]}`;
}
