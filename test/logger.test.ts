import { describe, expect, it, vi, afterEach } from 'vitest';
import { createLogger } from '@durable-dav-router/backend-runtime/logger';

afterEach(() => vi.restoreAllMocks());

const capture = () => {
  const spies = {
    debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
  return spies;
};

describe('createLogger', () => {
  it('defaults to info, so debug is suppressed and warnings are not', () => {
    const spies = capture();
    const log = createLogger('KvCache');
    log.debug('hidden');
    log.info('shown');
    log.warn('shown');
    log.error('shown');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledOnce();
    expect(spies.warn).toHaveBeenCalledOnce();
    expect(spies.error).toHaveBeenCalledOnce();
  });

  it('reads LOG_LEVEL from an injected env', () => {
    // Workers have no process.env, so the injected env is the real source.
    const spies = capture();
    createLogger('X', undefined, { LOG_LEVEL: 'error' }).debug('hidden');
    expect(spies.debug).not.toHaveBeenCalled();
  });

  it('honours debug level', () => {
    const spies = capture();
    createLogger('X', undefined, { LOG_LEVEL: 'debug' }).debug('shown');
    expect(spies.debug).toHaveBeenCalledOnce();
  });

  it('falls back to info for an unknown level', () => {
    // A typo must not silence logging entirely.
    const spies = capture();
    createLogger('X', undefined, { LOG_LEVEL: 'loud' }).debug('hidden');
    expect(spies.debug).not.toHaveBeenCalled();
    createLogger('Y', undefined, { LOG_LEVEL: 'loud' }).warn('shown');
    expect(spies.warn).toHaveBeenCalledOnce();
  });

  it('tags output with the namespace so a log line is attributable', () => {
    const spies = capture();
    createLogger('KvCache').info('hello');
    expect(spies.info.mock.calls[0]?.[0]).toContain('KvCache');
  });

  it('includes an optional scope label ahead of the namespace', () => {
    const spies = capture();
    createLogger('KvCache', 'davRoute').info('hello');
    const first = String(spies.info.mock.calls[0]?.[0]);
    expect(first).toContain('davRoute');
    expect(first).toContain('KvCache');
  });

  it('passes the message and structured arguments through as separate arguments', () => {
    // Cloudflare only indexes JSON fields for non-string console arguments, so
    // prefixing the message into the first string would flatten it. The prefix
    // stays first for human readability; the message and any context object
    // follow as their own arguments.
    const spies = capture();
    createLogger('KvCache').warn('failed', { domain: 'davRoute' });
    const call = spies.warn.mock.calls[0] as unknown[];
    expect(String(call[0])).toContain('KvCache');
    expect(call[1]).toBe('failed');
    expect(call[2]).toEqual({ domain: 'davRoute' });
  });

  it('never throws on a null env', () => {
    const spies = capture();
    expect(() => createLogger('X', undefined, null).info('ok')).not.toThrow();
    expect(spies.info).toHaveBeenCalledOnce();
  });
});
