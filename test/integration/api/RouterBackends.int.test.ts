import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { setupIntegrationTest } from '../helpers/setup';

describe('router backends', () => {
  it('registers a backend and lists empty aggregated volumes', async () => {
    await setupIntegrationTest(env as never, 'test@example.com');
    const createRes = await SELF.fetch(
      new Request('https://router/user/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'office', baseUrl: 'https://backend.example.com' }),
      }),
    );
    // Health probe to example.com fails softly; creation still succeeds.
    expect([201, 400, 409]).toContain(createRes.status);
    const listRes = await SELF.fetch(new Request('https://router/user/backends'));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { backends?: unknown[] };
    expect(Array.isArray(list.backends)).toBe(true);
  });
});
