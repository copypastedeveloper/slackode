import { getDb } from "./index.js";

const ROLE_RANK: Record<string, number> = { admin: 2, developer: 1, user: 0 };

export type Role = "admin" | "developer" | "user";

export function getUserRole(userId: string): Role {
  const row = getDb()
    .prepare("SELECT role FROM permissions WHERE user_id = ?")
    .get(userId) as { role: string } | undefined;
  return (row?.role as Role) ?? "user";
}

export function hasRole(userId: string, minRole: "admin" | "developer"): boolean {
  const actual = getUserRole(userId);
  return (ROLE_RANK[actual] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
}

export function setRole(userId: string, role: "admin" | "developer", grantedBy: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO permissions (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(userId, role, grantedBy);
}

export function removeRole(userId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM permissions WHERE user_id = ?")
    .run(userId);
  return result.changes > 0;
}

export interface PermissionRow {
  user_id: string;
  role: string;
  granted_by: string;
  granted_at: number;
}

export function listPermissions(): PermissionRow[] {
  return getDb()
    .prepare("SELECT user_id, role, granted_by, granted_at FROM permissions ORDER BY granted_at")
    .all() as PermissionRow[];
}

export function bootstrapAdmins(userIds: string[]): void {
  const database = getDb();
  const insert = database.prepare(
    "INSERT OR IGNORE INTO permissions (user_id, role, granted_by) VALUES (?, 'admin', 'ENV')"
  );
  const txn = database.transaction(() => {
    for (const id of userIds) {
      insert.run(id);
    }
  });
  txn();
}
