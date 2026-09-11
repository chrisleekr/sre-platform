import { describe, expect, test, vi } from 'vitest';
import { interpretImage, VISION_PROMPT } from '../interpret-image';
import type { VisionModel } from '../types';

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

describe('interpretImage deadline signal', () => {
  test('an already-aborted reason wins over the capability error', async () => {
    const describeImage = vi.fn<VisionModel['describeImage']>();
    const vision: VisionModel = { provider: 'text-only', supportsVision: false, describeImage };
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);

    await expect(
      interpretImage(vision, bytes, 'image/png', { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(describeImage).not.toHaveBeenCalled();
  });

  test('forwards options to the configured vision model', async () => {
    const describeImage = vi
      .fn<VisionModel['describeImage']>()
      .mockResolvedValueOnce('description');
    const vision: VisionModel = { provider: 'vision', supportsVision: true, describeImage };
    const controller = new AbortController();
    const options = { signal: controller.signal };

    await expect(interpretImage(vision, bytes, 'image/png', options)).resolves.toBe('description');
    expect(describeImage).toHaveBeenCalledWith(bytes, 'image/png', VISION_PROMPT, options);
  });
});
