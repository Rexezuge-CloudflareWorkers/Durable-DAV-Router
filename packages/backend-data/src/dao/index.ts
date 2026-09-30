// Grouped DAO barrels — import from a domain group for readability
// (`@durable-dav-router/backend-data/dao/identity`), or from the root barrel.
export * from './identity';
export * from './router';
export { BaseDAO } from './BaseDAO';
export { buildSetClause } from './UpdateClause';
export type { SetAssignment } from './UpdateClause';
