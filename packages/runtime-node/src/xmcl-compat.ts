/** Packaging compatibility: installer 6.3.6 imports an unshipped core subpath. */
export function isNotNull<T>(value: T | undefined): value is T {
  return value !== undefined;
}
