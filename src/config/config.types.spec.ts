import { FLOATRA_CATEGORIES } from './config.types';
import { loadJsonFixture } from '../contract/fixtures';

describe('FLOATRA_CATEGORIES', () => {
  it("matches core's Prisma OrderCategory enum (contract fixture)", () => {
    const core = loadJsonFixture<string[]>('order-categories');
    expect([...FLOATRA_CATEGORIES].sort()).toEqual([...core].sort());
  });
});
