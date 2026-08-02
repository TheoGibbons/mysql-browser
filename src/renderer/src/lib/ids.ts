let counter = 0

/** Short, sortable, collision-free ids for tabs and sessions. */
export function newId(prefix: string): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`
}
