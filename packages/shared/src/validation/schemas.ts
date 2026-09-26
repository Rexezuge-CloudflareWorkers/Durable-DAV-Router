import { z } from 'zod';

const MAX_RESOURCE_NUMBER = 2_147_483_647;

function parsePositiveInt(raw: string | undefined | null, max: number = MAX_RESOURCE_NUMBER): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max ? null : parsed;
}

const tokenIdSchema = z.string().trim().uuid('Invalid token id');
const credentialIdSchema = z.string().trim().uuid('Invalid credential id');

export { parsePositiveInt, tokenIdSchema, credentialIdSchema, MAX_RESOURCE_NUMBER };
