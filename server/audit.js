// Minimal in-memory audit log for the demo. Swap with SQLite/Postgres if needed.
const logs = [];
export function record(entry) {
  const row = { ts: Date.now(), ...entry };
  logs.push(row);
  if (logs.length > 5000) logs.shift();
}
export function query({ limit = 200 } = {}) {
  return logs.slice(-limit);
}