import type { CAC } from 'cac';
import { registerStubTopic } from '../stub-topic';

export function register(cli: CAC): void {
  registerStubTopic(cli, {
    name: 'acb',
    description: 'Agent change brief review (not yet implemented)',
    phase: 9,
  });
}
