import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class names without conflicts.
 *
 * `clsx` handles conditional inclusion (booleans, undefineds, arrays);
 * `twMerge` resolves conflicting Tailwind classes (later wins, e.g.
 * `px-2 px-4` → `px-4`). Together they are the de facto standard for
 * composing Tailwind classes in React components.
 *
 * @example
 * cn('px-2 py-1', isActive && 'bg-primary', className)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
