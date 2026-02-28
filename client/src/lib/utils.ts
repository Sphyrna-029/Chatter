import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function displayUserId(id: string): string {
  return id.split(":")[0]?.replace("@", "") || id;
}
