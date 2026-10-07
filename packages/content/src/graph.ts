/** Prerequisite graph (FR-9): Kahn's order, or one cycle (as a closed path) when there is none. */
export function topoOrder(nodes: { id: string; deps: string[] }[]): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const deps = new Map(nodes.map((n) => [n.id, n.deps]));
  const pending = new Map(nodes.map((n) => [n.id, n.deps.length]));
  const dependents = new Map<string, string[]>();
  for (const n of nodes) for (const d of n.deps) dependents.set(d, [...(dependents.get(d) ?? []), n.id]);
  const queue = nodes.filter((n) => n.deps.length === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const m of dependents.get(id) ?? []) {
      const left = pending.get(m)! - 1;
      pending.set(m, left);
      if (left === 0) queue.push(m);
    }
  }
  if (order.length === nodes.length) return { ok: true, order };
  // Every node left over has a dep that is also left over, so walking deps from any of them must loop.
  const done = new Set(order);
  const seen: string[] = [];
  let at = nodes.find((n) => !done.has(n.id))!.id;
  while (!seen.includes(at)) {
    seen.push(at);
    at = deps.get(at)!.find((d) => !done.has(d))!;
  }
  return { ok: false, cycle: [...seen.slice(seen.indexOf(at)), at] };
}
