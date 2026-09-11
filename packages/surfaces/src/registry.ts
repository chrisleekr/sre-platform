import type { Surface } from '@sre/db';
import type { SurfacePoster } from './types';

/** Registry of outbound surface posters, keyed by surface. Mirrors ConnectorRegistry. */
export class SurfaceRegistry {
  private readonly posters = new Map<Surface, SurfacePoster>();

  register(poster: SurfacePoster): void {
    this.posters.set(poster.surface, poster);
  }

  get(surface: Surface): SurfacePoster | undefined {
    return this.posters.get(surface);
  }

  has(surface: Surface): boolean {
    return this.posters.has(surface);
  }
}
