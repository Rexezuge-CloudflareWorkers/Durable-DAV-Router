// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
// `?raw` rather than `readFileSync(new URL(..., import.meta.url))`: under the
// jsdom environment `import.meta.url` is an http URL, not a file URL, so the
// `readFileSync` form throws. Importing it through Vite is also independent of
// the cwd the runner happens to start in.
import indexHtml from '../apps/web/index.html?raw';

// Models i18next's `t(key, defaultValue)`: with a key that the bundle may not
// carry, the inline default is what renders. That is exactly the path the word
// mark takes, so the assertions below pin the *default* strings - the ones that
// are invisible to `pnpm run validate:locales`, which only compares bundles
// against each other and never against the source.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

import { Logo } from '../apps/web/src/components/layout/Logo';
import en from '../apps/web/src/locales/en/translation.json';

describe('wordmark', () => {
  it('spells the product name, not the backend it fronts', () => {
    // The bug this pins: the nav bar said "Durable-DAV", which is the *upstream
    // backend* product, while this project is the router in front of it.
    const { container } = render(<Logo />);
    expect(container.textContent).toBe('Durable-DAV-Router');
  });

  it('splits the accent at the same place the design does', () => {
    render(<Logo />);
    // Two keys rather than one string sliced at a hyphen: the colour boundary is
    // a design decision, and slicing it out of a translated string would move it
    // silently for any locale whose name has no hyphen to slice on.
    const accent = screen.getByText('Durable-DAV-');
    const rest = screen.getByText('Router');
    expect(accent.className).toContain('var(--color-accent)');
    expect(rest.className).toContain('var(--color-text-primary)');
  });

  it('keeps the en bundle in step with the inline defaults', () => {
    // The `landing.*` bundle entries have already drifted from their component
    // defaults once; `validate:locales` cannot catch that, so assert it here.
    expect(en.header.brandAccent + en.header.brandRest).toBe('Durable-DAV-Router');
    expect(en.header.home).toBe('Durable-DAV-Router Home');
  });
});

describe('document shell', () => {
  it('titles the tab with the product name', () => {
    expect(indexHtml).toContain('<title>Durable-DAV-Router</title>');
  });

  it('carries a self-contained favicon that decodes to the shipped mark', () => {
    // Inlined rather than linked as `/favicon.svg`: the API worker has no assets
    // binding, so a path-based icon 404s there. Asserted on the decoded SVG so a
    // mangled data URI fails here instead of silently showing a broken icon.
    const href = /rel="icon"[\s\S]*?href="([^"]+)"/.exec(indexHtml)?.[1];
    expect(href).toBeDefined();
    const svg = decodeURIComponent((href as string).replace(/^data:image\/svg\+xml,/, ''));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 32 32"');
    // The routing fork: two nodes on top, a stem below.
    expect(svg.match(/<circle/g)).toHaveLength(2);
    expect(svg).toContain('stroke-width="4"');
  });
});
