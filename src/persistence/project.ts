import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { SqlitePersistence } from "./sqlite.js";

export interface ProjectPersistencePaths {
  directory: string;
  databasePath: string;
}

export function projectPersistencePaths(projectRoot: string): ProjectPersistencePaths {
  const directory = join(projectRoot, ".orca");
  return { directory, databasePath: join(directory, "orca.db") };
}

export function openProjectPersistence(projectRoot: string): SqlitePersistence {
  const paths = projectPersistencePaths(projectRoot);
  mkdirSync(paths.directory, { recursive: true });
  return new SqlitePersistence({ path: paths.databasePath });
}
